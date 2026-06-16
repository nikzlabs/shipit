/**
 * Install controller — owns `agent.install` execution state and the MCP npm
 * install state, and registers the install/workspace/MCP endpoints
 * (`/install`, `/install/status`, `/workspace/head-commit`,
 * `/workspace/dep-snapshot`, `/mcp/install`, `/mcp/test`).
 *
 * Install progress and completion stream over SSE (`install_log` /
 * `install_done` / `install_error`); the marker stamp + overlay dep checks
 * decide whether an install can be skipped. See docs/183 / docs/197 / docs/088.
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { McpServerConfig } from "./agents/agent-process.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { agentHome } from "../shared/agent-home.js";
import { getErrorMessage } from "../shared/utils.js";
import { runtimeKey, tuneNpmInstall } from "./install-runtime.js";
import {
  makeMarker,
  markerMatches,
  parseMarker,
  serializeMarker,
  type InstallMarkerStamp,
} from "../shared/install-marker.js";
import { emptyDepDirsContradictingMarker } from "./overlay-dep-check.js";
import { formatInstallFailureMessage, INSTALL_STDERR_TAIL_BYTES } from "./install-failure.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { createDepSnapshotTar, safeDepDirRelpath } from "./dep-snapshot.js";

export interface InstallControllerDeps {
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  mcpConfig: McpConfigController;
}

export class InstallController {
  // Install state
  private _installRunning = false;
  private _installProcess: ChildProcess | null = null;
  /**
   * Last completed install's result. Retained across the worker process
   * lifetime (or until a new install starts) so the orchestrator can
   * recover on SSE reconnect: if the orchestrator's SSE drops between
   * `install_status: running` and the worker emitting `install_done`,
   * the orchestrator polls `/install/status` to discover the outcome
   * instead of waiting forever for an event that already fired.
   */
  private _lastInstallResult: { ok: boolean; command?: string; message?: string } | null = null;

  // docs/088 — MCP npm install state. Per-package mutex coalesces concurrent
  // install requests for the same package; `/tmp/mcp-installed.json` records
  // completed installs so a worker restart within the same container doesn't
  // reinstall (cross-container caching is out of scope for Phase 1).
  private _mcpInstallMutex = new Map<string, Promise<void>>();
  private static readonly MCP_INSTALLED_MARKER = "/tmp/mcp-installed.json";

  constructor(private readonly deps: InstallControllerDeps) {}

  private get workspaceDir(): string {
    return this.deps.workspaceDir;
  }

  private broadcastSSE(event: WorkerSSEEvent): void {
    this.deps.broadcast(event);
  }

  /**
   * The completed install result to replay on SSE reconnect, or null when an
   * install is in flight (running installs don't replay a stale outcome).
   */
  getCompletedResult(): { ok: boolean; command?: string; message?: string } | null {
    if (this._lastInstallResult && !this._installRunning) {
      return this._lastInstallResult;
    }
    return null;
  }

  registerRoutes(app: FastifyInstance): void {
    // --- Install endpoint ---

    app.post<{ Body: { commands: string[] } }>("/install", async (request, reply) => {
      const { commands } = request.body ?? {};
      if (!Array.isArray(commands) || commands.length === 0) {
        return reply.code(400).send({ error: "commands array is required" });
      }

      // Check the stamped marker — skip only when it EXACTLY matches this
      // session's install context (source commit + runtime fingerprint +
      // install commands), per docs/183 Phase 3. Presence alone is no longer
      // enough: a session over a shared overlay base inherits the base's marker
      // from the lowerdir, so the stamp is what proves the base's deps still fit
      // this checkout/runtime/command. A mismatch (non-default checkout,
      // force-push, edited install command, incompatible runtime) or a legacy
      // bare-timestamp marker is treated as a miss — the stale marker is removed
      // and `agent.install` re-runs. Checked before the `running` guard so a
      // finished pre-install that wrote the marker (warm-pool path) but hasn't
      // yet flipped `_installRunning` still short-circuits cleanly.
      const markerDir = path.join(this.workspaceDir, ".shipit");
      const markerFile = path.join(markerDir, ".install-done");
      const stamp: InstallMarkerStamp = {
        sourceCommit: await this.readSourceCommit(),
        runtimeKey: runtimeKey(),
        installCommands: commands,
        // docs/197 — content key over the dependency input files. Lets a
        // different commit whose dep files are byte-identical skip the install.
        // `null` (codegen install / no `install-inputs` / no input files) falls
        // back to commit-only matching.
        depsHash: this.computeDepsHash(commands),
      };
      if (await this.installMarkerMatches(markerFile, stamp)) {
        // docs/183 — a matching marker is only trustworthy if every declared dep
        // dir actually holds content. The marker lives in the host clone; the
        // deps live in the dep dir (an overlay mount when OVERLAY_DEP_STORE is on,
        // a plain dir in the clone otherwise), and the two can disagree:
        //   • Flag newly ON: a container recreated with the flag enabled mounts an
        //     EMPTY overlay over previously-installed deps — skipping would leave
        //     the session dep-less AND let the publish hook capture the empty view
        //     as the scope's shared base.
        //   • Flag rolled OFF (the documented incident response, FINDINGS #3): a
        //     session whose deps lived in the overlay gets its container recreated
        //     with the flag off — no overlay mount, but the dep dir left behind in
        //     the host clone is EMPTY. The marker still matches exactly, so the
        //     old overlay-mount-only check skipped → dep-less session.
        // Distrusting a matching marker over a present-but-EMPTY dep dir,
        // regardless of mount type, closes both. An ABSENT dep dir is NOT a
        // contradiction, so a legitimately dep-less repo (e.g. default
        // node_modules on a non-Node repo) and the `agent.dep-dirs: []` opt-out
        // keep the marker-skip — non-overlay/no-deps sessions stay unchanged.
        const contradicted = emptyDepDirsContradictingMarker(this.workspaceDir);
        if (contradicted.length === 0) {
          return { skipped: true, reason: "marker" };
        }
        console.warn(
          `[install] marker matched but declared dep dir(s) are empty: ` +
          `${contradicted.map((c) => (c.overlay ? `${c.depDir} (overlay)` : c.depDir)).join(", ")} ` +
          `— treating as a miss and reinstalling`,
        );
      }
      // Stale / legacy / mismatched marker — whiteout it before reinstalling so
      // a partial reinstall can never leave an old stamp claiming success.
      await fsp.rm(markerFile, { force: true }).catch(() => {});

      if (this._installRunning) {
        // Join the in-flight install instead of failing. The caller awaits the
        // SSE-delivered `install_done` / `install_error` event for completion,
        // so reporting `started: true` (vs the previous 409) lets the warm-pool
        // pre-install and the on-activation install converge on the same run.
        return { started: true, joined: true };
      }

      this._installRunning = true;
      // New install starts — clear any previous result so the SSE-reconnect
      // resync path doesn't surface a stale outcome from a prior install.
      this._lastInstallResult = null;

      // Run `agent.install` in the background; progress and completion stream
      // via SSE (`install_done` / `install_error`). The lockfile-keyed copy
      // store fast path (docs/148) was removed in docs/183 Phase 1 — the
      // overlay rolling base will reclaim the install-extract cost instead.
      void this.runRealInstallCommands(commands, markerDir, markerFile, stamp);
      return { started: true };
    });

    // Install state probe — used by the orchestrator's SSE reconnect path
    // to recover from a missed install_done/install_error. See
    // `ContainerSessionRunner.resyncInstallStateAfterReconnect()`.
    app.get("/install/status", async () => ({
      running: this._installRunning,
      lastResult: this._lastInstallResult,
    }));

    // docs/183 — the merged-workspace HEAD commit. The overlay publish
    // path needs the source commit the install actually ran against to stamp the
    // candidate base and decide publish eligibility (source == remote default).
    // The orchestrator can't read it from the host upperdir (`.git` lives in the
    // merged tree, not the host storage path), so it asks the worker, which runs
    // `git rev-parse HEAD` in the same merged `/workspace` the agent sees.
    app.get("/workspace/head-commit", async () => ({
      commit: await this.readSourceCommit(),
      // docs/183 — the worker-side runtime fingerprint. The publish path records
      // it on the base pointer so a later same-commit session can be pre-stamped
      // with a marker the /install gate accepts (the gate compares against THIS
      // value, not the orchestrator-side scope key).
      runtimeKey: runtimeKey(),
    }));

    // docs/183 Phase 4 — stream a single dep dir's merged contents as a tar so the
    // orchestrator can publish it as the next rolling base for that dep dir. The
    // merged view exists only inside the container; this is the HTTP-only pull.
    app.get<{ Querystring: { path?: string } }>("/workspace/dep-snapshot", async (request, reply) => {
      const rel = safeDepDirRelpath(request.query.path ?? "");
      if (!rel) return reply.code(400).send({ error: "invalid dep dir path" });
      const full = path.join(this.workspaceDir, rel);
      if (!fs.existsSync(full)) return reply.code(404).send({ error: `dep dir not found: ${rel}` });
      const { stream, done } = createDepSnapshotTar(this.workspaceDir, rel);
      // A non-zero tar exit means the piped archive is truncated; the consumer
      // validates extraction, but destroy the stream so a truncated tar surfaces
      // as a stream error rather than a silently-short archive.
      done.catch((err: unknown) => {
        console.warn(`[dep-snapshot] tar failed for ${rel}:`, err instanceof Error ? err.message : String(err));
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      reply.header("content-type", "application/x-tar");
      return reply.send(stream);
    });

    // --- MCP endpoints (docs/088-mcp-integration) ---

    // Install npm packages for stdio MCP servers. Runs at session activation,
    // alongside the existing `agent.install` step. Packages already recorded
    // in /tmp/mcp-installed.json are skipped. Concurrent requests for the same
    // package coalesce via the per-package mutex.
    app.post<{ Body: { packages?: string[] } }>("/mcp/install", async (request, reply) => {
      const { packages } = request.body ?? {};
      if (!Array.isArray(packages) || packages.some((p) => typeof p !== "string")) {
        return reply.code(400).send({ error: "packages must be an array of strings" });
      }
      const installed = this.readMcpInstalledMarker();
      const pending = [...new Set(packages)].filter((p) => p && !installed.has(p));
      if (pending.length === 0) {
        return { installed: [], skipped: packages };
      }
      const results = await Promise.allSettled(
        pending.map((pkg) => this.installMcpPackage(pkg)),
      );
      const ok: string[] = [];
      const failed: { package: string; error: string }[] = [];
      results.forEach((r, i) => {
        const pkg = pending[i];
        if (r.status === "fulfilled") {
          ok.push(pkg);
        } else {
          const error = getErrorMessage(r.reason);
          failed.push({ package: pkg, error });
          this.broadcastSSE({
            type: "mcp_server_status",
            data: { name: pkg, state: "failed", reason: `install failed: ${error}` },
          });
        }
      });
      return { installed: ok, failed };
    });

    // Connectivity test — spawn the configured stdio server (or open the HTTP
    // connection), run `initialize` + `tools/list`, tear it down. The config
    // arrives with `$secret:` placeholders; resolve them locally first.
    app.post<{ Body: { config?: McpServerConfig } }>("/mcp/test", async (request, reply) => {
      const { config } = request.body ?? {};
      if (!config || typeof config !== "object") {
        return reply.code(400).send({ error: "config is required" });
      }
      const { testMcpServer } = await import("./mcp-test.js");
      const resolved = this.deps.mcpConfig.resolveMcpServerConfig(config);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error };
      }
      return testMcpServer(resolved.config);
    });
  }

  /** Kill any in-flight install process (worker shutdown). */
  stop(): void {
    if (this._installProcess) {
      this._installProcess.kill();
      this._installProcess = null;
      this._installRunning = false;
    }
  }

  // --- MCP helpers (docs/088) ---

  /** Read the set of MCP npm packages already installed in this container. */
  private readMcpInstalledMarker(): Set<string> {
    try {
      const raw = fs.readFileSync(InstallController.MCP_INSTALLED_MARKER, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return new Set(parsed.filter((p): p is string => typeof p === "string"));
    } catch {
      /* no marker yet */
    }
    return new Set();
  }

  /** Append a package to the installed-marker file. */
  private recordMcpInstalled(pkg: string): void {
    const installed = this.readMcpInstalledMarker();
    installed.add(pkg);
    try {
      fs.writeFileSync(InstallController.MCP_INSTALLED_MARKER, JSON.stringify([...installed]));
    } catch (err) {
      console.warn("[mcp] failed to write installed marker:", getErrorMessage(err));
    }
  }

  /** `npm install -g <pkg>` with a per-package mutex. */
  private installMcpPackage(pkg: string): Promise<void> {
    const existing = this._mcpInstallMutex.get(pkg);
    if (existing) return existing;
    const run = new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install", "-g", pkg], {
        stdio: ["ignore", "pipe", "pipe"],
        // docs/150 §6 — `npm install -g` targets NPM_CONFIG_PREFIX
        // (/home/shipit/.npm-global, set in the image ENV and writable by the
        // unprivileged `shipit` user). Spawn from agentHome() rather than the
        // root-owned /app cwd so the install is hermetic — /app's package.json
        // can otherwise subtly affect resolution, and /app is not writable to
        // `shipit` post-migration.
        cwd: agentHome(),
        env: { ...process.env, NODE_ENV: "development" },
      });
      let stderr = "";
      proc.stdout?.on("data", (c: Buffer) =>
        this.broadcastSSE({ type: "install_log", data: { text: c.toString(), stream: "stdout" } }),
      );
      proc.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
        this.broadcastSSE({ type: "install_log", data: { text: c.toString(), stream: "stderr" } });
      });
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if (code === 0) {
          this.recordMcpInstalled(pkg);
          resolve();
        } else {
          reject(new Error(stderr.trim().slice(-400) || `npm exited with code ${code}`));
        }
      });
    }).finally(() => {
      this._mcpInstallMutex.delete(pkg);
    });
    this._mcpInstallMutex.set(pkg, run);
    return run;
  }

  // --- Install command execution ---

  /**
   * Latch a successful install: write the marker, record the result, clear the
   * running flag, and broadcast `install_done`.
   *
   * State (`_lastInstallResult`, `_installRunning`) is updated BEFORE the
   * broadcast so an orchestrator that races to query `/install/status` right
   * after the SSE event sees a consistent `running: false` snapshot.
   */
  private finishInstallOk(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    this.writeMarker(markerDir, markerFile, stamp);
    this._lastInstallResult = { ok: true };
    this._installRunning = false;
    this._installProcess = null;
    this.broadcastSSE({ type: "install_done", data: {} });
  }

  /**
   * Run `agent.install`, streaming output via SSE and writing the marker on
   * success. Each command is passed through {@link tuneNpmInstall} so a bare
   * `npm install` lands fast on a warm download cache (`/dep-cache`, docs/075).
   *
   * The lockfile-keyed copy-store fast path (docs/148) was removed in docs/183
   * Phase 1: the overlay rolling base eliminates the install-extract cost
   * generically (whole-workspace, ecosystem-agnostic) instead of copying a
   * `node_modules` snapshot per session.
   */
  private async runRealInstallCommands(
    commands: string[],
    markerDir: string,
    markerFile: string,
    stamp: InstallMarkerStamp,
  ): Promise<void> {
    try {
      for (const rawCmd of commands) {
        const cmd = tuneNpmInstall(rawCmd);
        const { code: exitCode, stderrTail } = await this.runSingleInstallCommand(cmd);
        if (exitCode !== 0) {
          const message = formatInstallFailureMessage(cmd, exitCode, stderrTail);
          this._lastInstallResult = { ok: false, command: cmd, message };
          // Update terminal state BEFORE broadcasting so an orchestrator that
          // races to query `/install/status` after the SSE event sees a
          // consistent `running: false` snapshot.
          this._installRunning = false;
          this._installProcess = null;
          this.broadcastSSE({
            type: "install_error",
            data: { command: cmd, exitCode, message },
          });
          return;
        }
      }

      this.finishInstallOk(markerDir, markerFile, stamp);
    } catch (err) {
      const message = getErrorMessage(err);
      this._lastInstallResult = { ok: false, message };
      this._installRunning = false;
      this._installProcess = null;
      this.broadcastSSE({
        type: "install_error",
        data: { message },
      });
    }
  }

  /**
   * Write the stamped `.shipit/.install-done` marker (docs/183 Phase 3). The
   * stamp records the source commit + runtime fingerprint + install commands
   * the install ran against, so a later `/install` skips only on an exact match.
   */
  private writeMarker(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, serializeMarker(makeMarker(stamp, new Date().toISOString())));
  }

  /**
   * Read the stamped marker and report whether it exactly matches `stamp`.
   * A missing file, a legacy bare-timestamp marker, or a corrupt/future-version
   * stamp all parse to `null` and count as a miss — the caller then whiteouts
   * the marker and reinstalls.
   */
  private async installMarkerMatches(
    markerFile: string,
    stamp: InstallMarkerStamp,
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = await fsp.readFile(markerFile, "utf8");
    } catch {
      return false; // no marker yet
    }
    const marker = parseMarker(raw);
    return marker !== null && markerMatches(marker, stamp);
  }

  /**
   * Compute the install marker's `depsHash` (docs/197) — a content hash of the
   * dependency input files, gated by the `agent.install` command allowlist and
   * an optional `agent.install-inputs` override (read from `shipit.yaml`). A
   * config-read failure or a non-content-keyable install both yield `null`,
   * which keeps the marker on the commit-only path.
   */
  private computeDepsHash(commands: string[]): string | null {
    let installInputs: string[] | null = null;
    try {
      installInputs = resolveShipitConfig(this.workspaceDir).agent.installInputs;
    } catch {
      // Unreadable/invalid config — fall back to the command-derived inputs.
    }
    return computeInstallDepsHash(this.workspaceDir, commands, installInputs);
  }

  /**
   * Resolve the git HEAD of the workspace for the marker stamp. Returns `null`
   * for a non-git workspace (standalone/template sessions), where the marker
   * simply omits the commit from its match decision. Best-effort: any git
   * failure also yields `null` rather than blocking the install.
   */
  private readSourceCommit(): Promise<string | null> {
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      const done = (v: string | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const proc = spawn("git", ["rev-parse", "HEAD"], {
          cwd: this.workspaceDir,
          stdio: ["ignore", "pipe", "ignore"],
        });
        proc.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        proc.on("error", () => done(null));
        proc.on("close", (code) => done(code === 0 && out.trim() ? out.trim() : null));
      } catch {
        done(null);
      }
    });
  }

  /**
   * Run a single install command and return its exit code.
   * Streams stdout/stderr via SSE.
   *
   * Forces `NODE_ENV=development` so devDependencies (tsc, vitest, eslint, etc.)
   * are installed — the agent needs them to typecheck, test, and lint. The prod
   * session-worker image sets `NODE_ENV=production` at the container level,
   * which would otherwise cause `npm install` to skip devDependencies. Users can
   * still override by prefixing their install command (e.g. `NODE_ENV=production
   * npm install --omit=dev`); shell prefixes win over the spawned env.
   */
  private runSingleInstallCommand(command: string): Promise<{ code: number; stderrTail: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "development" },
      });
      this._installProcess = proc;

      // Retain a bounded tail of stderr so a non-zero exit can report WHY it
      // failed (e.g. the EACCES line from a root-owned workspace), not just the
      // exit code. Streamed live to SSE as before; the tail is the keep-the-end
      // accumulation `formatInstallFailureMessage` consumes on failure.
      let stderrTail = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.broadcastSSE({
          type: "install_log",
          data: { text: chunk.toString(), stream: "stdout" },
        });
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.broadcastSSE({
          type: "install_log",
          data: { text, stream: "stderr" },
        });
        stderrTail = (stderrTail + text).slice(-INSTALL_STDERR_TAIL_BYTES);
      });

      proc.on("error", (err) => {
        this._installProcess = null;
        reject(err);
      });

      proc.on("close", (code) => {
        this._installProcess = null;
        resolve({ code: code ?? 1, stderrTail });
      });
    });
  }
}
