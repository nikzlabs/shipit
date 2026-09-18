import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { killChild } from "../shared/kill-child.js";
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
import { classifyEmptyDepDirs } from "./overlay-dep-check.js";
import { installSkipOutputWarning } from "./install-skip-warning.js";
import {
  formatEmptyDepDirsFailureMessage,
  formatHoistedDepDirsWarning,
  formatInstallFailureMessage,
  formatStaleDepDirsFailureMessage,
  INSTALL_STDERR_TAIL_BYTES,
} from "./install-failure.js";
import { MAX_REPORTED_MISMATCHES, staleDepDirs } from "./dep-tree-staleness.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { createDepSnapshotTar, safeDepDirRelpath } from "./dep-snapshot.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";
import { whenNodeRuntimeReady } from "./node-runtime.js";

export interface InstallControllerDeps {
  workspaceDir: string;
  stateDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  mcpConfig: McpConfigController;
}

export class InstallController {
  private _installRunning = false;
  private _installProcess: ChildProcess | null = null;
  // Retain the outcome so the orchestrator can recover a completion missed during SSE disconnect.
  private _lastInstallResult: { ok: boolean; command?: string; message?: string } | null = null;

  get installRunning(): boolean {
    return this._installRunning;
  }

  private _mcpInstallMutex = new Map<string, Promise<void>>();
  private static readonly MCP_INSTALLED_MARKER = "/tmp/mcp-installed.json";

  constructor(private readonly deps: InstallControllerDeps) {}

  private get workspaceDir(): string {
    return this.deps.workspaceDir;
  }

  private get stateDir(): string {
    return this.deps.stateDir;
  }

  private broadcastSSE(event: WorkerSSEEvent): void {
    this.deps.broadcast(event);
  }

  getCompletedResult(): { ok: boolean; command?: string; message?: string } | null {
    if (this._lastInstallResult && !this._installRunning) {
      return this._lastInstallResult;
    }
    return null;
  }

  registerRoutes(app: FastifyInstance): void {
    app.post<{ Body: { commands: string[] } }>("/install", async (request, reply) => {
      const { commands } = request.body ?? {};
      if (!Array.isArray(commands) || commands.length === 0) {
        return reply.code(400).send({ error: "commands array is required" });
      }

      // Resolve Node before computing the marker key or compiling native addons.
      await whenNodeRuntimeReady();

      const markerDir = this.stateDir;
      const markerFile = path.join(markerDir, INSTALL_MARKER_FILE);
      const stamp: InstallMarkerStamp = {
        sourceCommit: await this.readSourceCommit(),
        runtimeKey: runtimeKey(),
        installCommands: commands,
        depsHash: this.computeDepsHash(commands),
      };
      if (await this.installMarkerMatches(markerFile, stamp)) {
        // Overlay mount changes can leave deps empty while the marker still matches.
        const { contradicting: contradicted } = classifyEmptyDepDirs(this.workspaceDir);
        if (contradicted.length === 0) {
          this.warnOnSkippedInstallOutput(commands);
          return { skipped: true, reason: "marker" };
        }
        console.warn(
          `[install] marker matched but declared dep dir(s) are empty: ` +
          `${contradicted.map((c) => (c.overlay ? `${c.depDir} (overlay)` : c.depDir)).join(", ")} ` +
          `— treating as a miss and reinstalling`,
        );
      }
      // Remove stale success before an install that could fail part-way through.
      await fsp.rm(markerFile, { force: true }).catch(() => {});

      if (this._installRunning) {
        return { started: true, joined: true };
      }

      this._installRunning = true;
      this._lastInstallResult = null;

      void this.runRealInstallCommands(commands, markerDir, markerFile, stamp);
      return { started: true };
    });

    app.get("/install/status", async () => ({
      running: this._installRunning,
      lastResult: this._lastInstallResult,
    }));

    app.get("/workspace/head-commit", async () => ({
      commit: await this.readSourceCommit(),
      runtimeKey: runtimeKey(),
    }));

    app.get<{ Querystring: { path?: string } }>("/workspace/dep-snapshot", async (request, reply) => {
      const rel = safeDepDirRelpath(request.query.path ?? "");
      if (!rel) return reply.code(400).send({ error: "invalid dep dir path" });
      const full = path.join(this.workspaceDir, rel);
      if (!fs.existsSync(full)) return reply.code(404).send({ error: `dep dir not found: ${rel}` });
      const { stream, done } = createDepSnapshotTar(this.workspaceDir, rel);
      // The producer withholds EOF until tar exits and destroys the stream on failure.
      done.catch((err: unknown) => {
        console.warn(`[dep-snapshot] tar failed for ${rel}:`, err instanceof Error ? err.message : String(err));
      });
      reply.header("content-type", "application/x-tar");
      return reply.send(stream);
    });

    app.post<{ Body: { packages?: string[] } }>("/mcp/install", async (request, reply) => {
      const { packages } = request.body ?? {};
      if (!Array.isArray(packages) || packages.some((p) => typeof p !== "string")) {
        return reply.code(400).send({ error: "packages must be an array of strings" });
      }
      // MCP installs run alongside agent.install and need the same Node ABI.
      await whenNodeRuntimeReady();

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

    app.post<{ Body: { config?: McpServerConfig } }>("/mcp/test", async (request, reply) => {
      const { config } = request.body ?? {};
      if (!config || typeof config !== "object") {
        return reply.code(400).send({ error: "config is required" });
      }
      await whenNodeRuntimeReady();
      const { testMcpServer } = await import("./mcp-test.js");
      const resolved = this.deps.mcpConfig.resolveMcpServerConfig(config);
      if (!resolved.ok) {
        return { ok: false, error: resolved.error };
      }
      return testMcpServer(resolved.config);
    });
  }

  stop(): void {
    if (this._installProcess) {
      killChild(this._installProcess);
      this._installProcess = null;
      this._installRunning = false;
    }
  }

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

  private recordMcpInstalled(pkg: string): void {
    const installed = this.readMcpInstalledMarker();
    installed.add(pkg);
    try {
      fs.writeFileSync(InstallController.MCP_INSTALLED_MARKER, JSON.stringify([...installed]));
    } catch (err) {
      console.warn("[mcp] failed to write installed marker:", getErrorMessage(err));
    }
  }

  private installMcpPackage(pkg: string): Promise<void> {
    const existing = this._mcpInstallMutex.get(pkg);
    if (existing) return existing;
    const run = new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install", "-g", pkg], {
        stdio: ["ignore", "pipe", "pipe"],
        // Keep /app's package.json out of resolution and use a writable cwd.
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

  // Update state before broadcasting so a status query sees the completed outcome.
  private finishInstallOk(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    this.writeMarker(markerDir, markerFile, stamp);
    this._lastInstallResult = { ok: true };
    this._installRunning = false;
    this._installProcess = null;
    this.broadcastSSE({ type: "install_done", data: {} });
  }

  private finishInstallFailed(message: string, extra: { command?: string; exitCode?: number } = {}): void {
    this._lastInstallResult = { ok: false, ...(extra.command ? { command: extra.command } : {}), message };
    this._installRunning = false;
    this._installProcess = null;
    this.broadcastSSE({
      type: "install_error",
      data: {
        ...(extra.command ? { command: extra.command } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        message,
      },
    });
  }

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
          this.finishInstallFailed(formatInstallFailureMessage(cmd, exitCode, stderrTail), {
            command: cmd,
            exitCode,
          });
          return;
        }
      }

      // Commands can hide failure with || true. Validate deps before stamping success.
      const { contradicting: empty, hoistedAway } = classifyEmptyDepDirs(this.workspaceDir);
      if (empty.length > 0) {
        const message = formatEmptyDepDirsFailureMessage(empty.map((c) => c.depDir));
        console.warn(`[install] ${message}`);
        this.finishInstallFailed(message);
        return;
      }

      const stale = staleDepDirs(this.workspaceDir, commands);
      if (stale.length > 0) {
        const message = formatStaleDepDirsFailureMessage(stale, MAX_REPORTED_MISMATCHES);
        console.warn(`[install] ${message}`);
        this.finishInstallFailed(message);
        return;
      }

      // This warning asserts success, so emit it only after every check passes.
      if (hoistedAway.length > 0) {
        const warning = formatHoistedDepDirsWarning(hoistedAway);
        console.warn(warning);
        this.broadcastSSE({ type: "install_log", data: { text: `${warning}\n`, stream: "stderr" } });
      }

      this.finishInstallOk(markerDir, markerFile, stamp);
    } catch (err) {
      this.finishInstallFailed(getErrorMessage(err));
    }
  }

  private writeMarker(markerDir: string, markerFile: string, stamp: InstallMarkerStamp): void {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, serializeMarker(makeMarker(stamp, new Date().toISOString())));
  }

  private async installMarkerMatches(
    markerFile: string,
    stamp: InstallMarkerStamp,
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = await fsp.readFile(markerFile, "utf8");
    } catch {
      return false;
    }
    const marker = parseMarker(raw);
    return marker !== null && markerMatches(marker, stamp);
  }

  private computeDepsHash(commands: string[]): string | null {
    let installInputs: string[] | null = null;
    try {
      installInputs = resolveShipitConfig(this.workspaceDir).agent.installInputs;
    } catch {
      // Unreadable/invalid config — fall back to the command-derived inputs.
    }
    return computeInstallDepsHash(this.workspaceDir, commands, installInputs);
  }

  // Log locally too: container recreation can run an install without an SSE viewer.
  private warnOnSkippedInstallOutput(commands: string[]): void {
    let depDirs: string[];
    try {
      depDirs = resolveShipitConfig(this.workspaceDir).agent.depDirs;
    } catch {
      return;
    }
    const warning = installSkipOutputWarning(commands, depDirs);
    if (!warning) return;
    console.warn(warning);
    this.broadcastSSE({ type: "install_log", data: { text: `${warning}\n`, stream: "stderr" } });
  }

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

  // Override the image's production NODE_ENV so test tools install; command prefixes still win.
  private runSingleInstallCommand(command: string): Promise<{ code: number; stderrTail: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: this.workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "development" },
      });
      this._installProcess = proc;

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
