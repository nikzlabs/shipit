/**
 * ComposeCli — `docker compose` command construction + execution for a session.
 *
 * Extracted from {@link ServiceManager} (docs/201 Phase P8). The manager still
 * owns the start/stop/reconcile state machine, the install gate, log streaming,
 * and collaborator wiring; this class owns the narrow concern of *talking to the
 * compose CLI*:
 *
 *   - Building the common arg vector (`-f <file> -f override -p <project>`).
 *   - Running a command (resolve on exit 0 / reject otherwise) via the injected
 *     {@link ComposeRunner}, and querying stdout via the injected
 *     {@link ComposeQuery} (both overridable for tests).
 *   - `up`/`upService`/`stop`/`down` wrappers with the exact same flags.
 *   - Container-name conflict recovery on `up`.
 *   - Pre-start stale-container sweep (`killStaleContainers`).
 *
 * Behavior is preserved byte-for-byte from the previous inline implementation —
 * same flags, same `--volumes`/removeVolumes semantics, same single conflict
 * retry, same long-lived-sidecar exclusion in the stale sweep.
 */

import { spawn } from "node:child_process";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

/** Runs a docker compose command. Resolves on exit 0, rejects otherwise. */
export type ComposeRunner = (args: string[], cwd: string) => Promise<void>;

/** Runs a docker compose command and returns stdout. */
export type ComposeQuery = (args: string[], cwd: string) => Promise<string>;

export interface ComposeCliOptions {
  /** Session ID — drives the compose project name, labels, and network name. */
  sessionId: string;
  /** Absolute path to the workspace directory (compose cwd). */
  workspaceDir: string;
  /** Compose file path, relative to the workspace (e.g. "docker-compose.yml"). */
  composeFile: string;
  /** Optional override for running compose commands (useful for testing). */
  composeRunner?: ComposeRunner;
  /** Optional override for querying compose commands (useful for testing). */
  composeQuery?: ComposeQuery;
}

export class ComposeCli {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private readonly composeFile: string;
  private readonly runner: ComposeRunner;
  /** Exposed so the poller / direct-spawn callers can run their own queries. */
  readonly query: ComposeQuery;

  constructor(opts: ComposeCliOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeFile = opts.composeFile;
    this.runner = opts.composeRunner ?? defaultComposeRunner;
    this.query = opts.composeQuery ?? defaultComposeQuery;
  }

  /** Build common compose CLI args with the user file and override. */
  args(...extra: string[]): string[] {
    return [
      "compose",
      "-f", this.composeFile,
      "-f", ".shipit/compose.override.yml",
      "-p", `shipit-${this.sessionId.slice(0, 12)}`,
      ...extra,
    ];
  }

  /**
   * Run `docker compose up -d --build`, optionally for specific services only.
   *
   * `--build` matters for any service that declares a `build:` section (e.g.
   * the ShipIt-in-ShipIt dogfood `dev` service). Without it, `docker compose
   * up` only builds when the named image is *missing* — so a changed
   * `Dockerfile` or build context on a host that already has the cached image
   * is silently ignored, and the stale image runs forever. `--build` forces
   * Compose to re-evaluate the build every `up`; Docker's layer cache makes
   * the no-change case cheap (all cache hits). For services that only declare
   * `image:` (the common case — most user repos pull a prebuilt image), there
   * is nothing to build and `--build` is a harmless no-op.
   */
  up(serviceNames?: string[]): Promise<void> {
    return this.upWithConflictRecovery("up", "-d", "--build", "--remove-orphans", ...(serviceNames ?? []));
  }

  /** Run `docker compose up -d --build` for a specific manual service. */
  upService(name: string): Promise<void> {
    return this.upWithConflictRecovery("up", "-d", "--build", name);
  }

  /** Run `docker compose stop <service>`. */
  stop(name: string): Promise<void> {
    return this.run("stop", name);
  }

  /** Run `docker compose down --remove-orphans`, optionally dropping volumes. */
  down(opts: { removeVolumes: boolean }): Promise<void> {
    const args = ["down", "--remove-orphans"];
    if (opts.removeVolumes) args.push("--volumes");
    return this.run(...args);
  }

  /**
   * Kill and remove any containers from a previous compose stack for this
   * session. Uses the `shipit-parent-session` label so no compose files needed.
   */
  async killStaleContainers(): Promise<void> {
    const stdout = await this.query(
      ["ps", "-aq", "--filter", `label=shipit-parent-session=${this.sessionId}`],
      this.workspaceDir,
    );
    let ids = stdout.split("\n").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    // The Tier B resolver and Tier C SNI proxy (docs/172, SHI-90) share the agent's
    // netns and are LONG-LIVED sidecars, not stale compose containers — they carry
    // shipit-parent-session only so destroy-time cleanup reaps them. Exclude them
    // from this pre-start sweep, or we'd SIGKILL them ~1s after the agent launches
    // and leave the session with no resolver / no HTTPS. Docker `--filter` has no
    // label negation, so subtract a query per keep-label and union the results.
    //
    // SHI-222: the keep-list must be INCARNATION-aware. Both labels are keyed on
    // the session id, which is stable across container recreations — so a naive
    // label match also spares the sidecars of a PREVIOUS, dead agent container
    // (the session OOM'd and was recreated). Those share a torn-down namespace
    // and are pure garbage; sparing them is exactly the leak. Keep a sidecar only
    // while its netns parent is still running.
    const keep = new Set<string>();
    for (const label of [EGRESS_RESOLVER_LABEL, EGRESS_PROXY_LABEL]) {
      const out = await this.query(
        [
          "ps", "-aq",
          "--filter", `label=shipit-parent-session=${this.sessionId}`,
          "--filter", `label=${label}=${this.sessionId}`,
        ],
        this.workspaceDir,
      );
      for (const id of out.split("\n").map(s => s.trim()).filter(Boolean)) {
        if (await this.hasLiveNetnsParent(id)) keep.add(id);
      }
    }
    ids = ids.filter(id => !keep.has(id));
    if (ids.length === 0) return;
    console.log(`[compose:${this.sessionId}] Removing ${ids.length} stale container(s)`);
    await this.query(["rm", "-f", ...ids], this.workspaceDir);
    // Also remove the old network if it exists
    try {
      await this.query(
        ["network", "rm", `shipit-session-${this.sessionId}`],
        this.workspaceDir,
      );
    } catch {
      // Network may not exist or may be in use — that's fine
    }
  }

  /**
   * Is `id`'s netns parent (`HostConfig.NetworkMode: container:<parentId>`) still
   * a running container? — the incarnation test for {@link killStaleContainers}'s
   * egress-sidecar keep-list (SHI-222).
   *
   * The agent container carries no `RestartPolicy`, so it never legitimately goes
   * running → stopped → running underneath a live sidecar: "parent not running"
   * always means "this sidecar's namespace is gone", never "wait a moment."
   *
   * Fails **safe toward keeping**. A false reap costs a running session its DNS
   * and HTTPS; a false keep costs one stale container that the boot janitor's
   * parent-liveness sweep (`egress-orphan-reaper.ts`) reaps anyway. So anything
   * we can't positively establish — an unreadable sidecar, a non-netns network
   * mode — resolves to "keep". Only an unambiguous answer (parent inspect says
   * not-running, or the parent is simply gone) reaps.
   */
  private async hasLiveNetnsParent(id: string): Promise<boolean> {
    let parentId: string;
    try {
      const mode = (
        await this.query(["inspect", "-f", "{{.HostConfig.NetworkMode}}", id], this.workspaceDir)
      ).trim();
      if (!mode.startsWith("container:")) return true; // not netns-sharing → not ours to judge
      parentId = mode.slice("container:".length).trim();
      if (!parentId) return true;
    } catch {
      return true; // can't tell → keep (preserves the pre-SHI-222 behavior)
    }
    try {
      const running = (
        await this.query(["inspect", "-f", "{{.State.Running}}", parentId], this.workspaceDir)
      ).trim();
      return running === "true";
    } catch {
      // The parent container doesn't exist any more — this sidecar is an orphan
      // from a previous incarnation. Let the sweep take it.
      return false;
    }
  }

  /**
   * Run `docker compose up …` and, on a Docker container-name conflict
   * (a stale container with the predicted name exists but compose doesn't
   * adopt it — e.g., labels drifted across orchestrator versions, the prior
   * teardown was interrupted, or another `up` call raced and left a zombie),
   * force-remove the conflicting container by ID and retry once.
   *
   * Why this lives here, not in `killStaleContainers()`: the broad pre-start
   * label sweep was over-aggressive — it SIGKILLed healthy preview containers
   * on every config reconcile (see efa1ec150 / docs/127-restart-agent §"Out
   * of scope"). This handler is surgical: it only removes the *specific*
   * container Docker named in the conflict error, so working stacks aren't
   * disturbed. The conflicting container can't be useful anyway — its name
   * is blocking the create we're about to issue.
   */
  private async upWithConflictRecovery(...subArgs: string[]): Promise<void> {
    try {
      await this.run(...subArgs);
    } catch (err) {
      const conflictId = extractConflictContainerId((err as Error).message);
      if (!conflictId) throw err;
      console.warn(
        `[compose:${this.sessionId}] Container-name conflict; removing ${conflictId.slice(0, 12)} and retrying`,
      );
      try {
        await this.query(["rm", "-f", conflictId], this.workspaceDir);
      } catch {
        // Removal failed — surface the original conflict error so the cause
        // is clear, rather than masking it with the removal failure.
        throw err;
      }
      await this.run(...subArgs);
    }
  }

  /** Run a docker compose command and resolve/reject based on exit code. */
  private run(...subArgs: string[]): Promise<void> {
    const args = this.args(...subArgs);
    return this.runner(args, this.workspaceDir);
  }
}

// ---------------------------------------------------------------------------
// Default compose runner / query
// ---------------------------------------------------------------------------

function defaultComposeRunner(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

function defaultComposeQuery(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the conflicting container ID out of a Docker compose-up error.
 *
 * The daemon's name-collision message looks like:
 *   `… The container name "/shipit-…-dev-1" is already in use by container
 *    "6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631". …`
 *
 * Returns the 64-hex container ID when present, otherwise `undefined` so the
 * caller can rethrow the original error untouched.
 */
export function extractConflictContainerId(message: string): string | undefined {
  const m = /already in use by container "([0-9a-f]{12,64})"/.exec(message);
  return m?.[1];
}
