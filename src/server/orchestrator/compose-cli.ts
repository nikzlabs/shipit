import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";
import { COMPOSE_PROJECT_LABEL, composeProjectName } from "./compose-stack-reaper.js";
import { composeStateDirForWorkspace } from "./session-state-dir.js";
import type { ConfinedComposeApi } from "./compose-helper.js";

export interface ComposeOutputSink {
  (chunk: string): void;
  /** Flush each process's trailing line before a retry starts. */
  flush?(): void;
}

export type ComposeRunner = (
  args: string[],
  cwd: string,
  onOutput?: ComposeOutputSink,
) => Promise<void>;

export type ComposeQuery = (args: string[], cwd: string) => Promise<string>;

export interface ComposeCliOptions {
  sessionId: string;
  workspaceDir: string;
  /** Runs `build` and `up` (docs/318-compose-remaining-escapes, Mechanism 1). */
  confined: Pick<ConfinedComposeApi, "build" | "up">;
  composeRunner?: ComposeRunner;
  composeQuery?: ComposeQuery;
  /** Invalidate the API guard's container index before services can reach it. */
  onTopologyChange?: () => () => void;
  /**
   * Re-attach ShipIt's own endpoints after the session network has been taken out from under them.
   * Owned here rather than by each caller: `refreshSecrets` reaches `up` without ever joining.
   */
  rejoinSessionNetwork?: () => Promise<void>;
  /** `<sessionDir>/state/compose`; defaults from `workspaceDir`. */
  composeStateDir?: string;
}

/** The files one start ran `up` from; `stop` loads them so a `pre_stop` hook still runs. */
export interface ComposeStartModel {
  /** Absent for a start of plugin services only, which the override defines in full. */
  snapshotFile?: string;
  overrideFile: string;
}

export interface ComposeBuild {
  /** The build model, given to `build` on stdin. */
  model: string;
  services: readonly string[];
}

type UpRecovery = "none" | "container" | "network";

// Compose's default project file names. Without `-f` it loads the first it finds in its working
// directory or any directory above it.
const COMPOSE_DEFAULT_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/**
 * The empty directory the orchestrator runs `ps`, `logs`, `stop`, and `down` in with `-p` and no
 * `-f`, so Compose finds the stack by its project label and opens no project file
 * (docs/318-compose-remaining-escapes, Mechanism 1).
 */
export function prepareModelFreeComposeDir(composeStateDir: string): string {
  const dir = path.join(composeStateDir, "no-model");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let d = dir; ; d = path.dirname(d)) {
    for (const name of COMPOSE_DEFAULT_FILES) {
      const found = path.join(d, name);
      if (fs.existsSync(found)) {
        throw new Error(
          `ShipIt runs Compose without a project file in ${dir}, but Compose would load ${found} `
          + "from a directory above it. Remove that file.",
        );
      }
    }
    if (path.dirname(d) === d) return dir;
  }
}

export class ComposeCli {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private readonly confined: Pick<ConfinedComposeApi, "build" | "up">;
  private readonly runner: ComposeRunner;
  readonly query: ComposeQuery;
  private readonly onTopologyChange?: () => () => void;
  private readonly rejoinFn?: () => Promise<void>;
  private readonly composeStateDirOption?: string;
  private modelFreeDirPath: string | null = null;

  constructor(opts: ComposeCliOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.confined = opts.confined;
    this.runner = opts.composeRunner ?? defaultComposeRunner;
    this.query = opts.composeQuery ?? defaultComposeQuery;
    this.onTopologyChange = opts.onTopologyChange;
    this.rejoinFn = opts.rejoinSessionNetwork;
    this.composeStateDirOption = opts.composeStateDir;
  }

  /** Runs every time, for the services `up` starts, so an edited Dockerfile or context is picked up. */
  async build(build: ComposeBuild | undefined, onOutput?: ComposeOutputSink): Promise<void> {
    if (!build || build.services.length === 0) return;
    const start = Date.now();
    try {
      await this.confined.build({ buildModel: build.model, services: build.services, ...(onOutput ? { onOutput } : {}) });
    } finally {
      console.log(
        `[timing] compose.build for ${this.sessionId} services=${build.services.join(",")} total=${Date.now() - start}ms`,
      );
    }
  }

  up(
    serviceNames: string[],
    start: { model: ComposeStartModel; serviceEnvDir?: string },
    onOutput?: ComposeOutputSink,
  ): Promise<void> {
    return this.timedUp(serviceNames, onOutput, (sink) => this.confined.up({
      ...(start.model.snapshotFile ? { snapshotFile: start.model.snapshotFile } : {}),
      overrideFile: start.model.overrideFile,
      services: serviceNames,
      ...(start.serviceEnvDir ? { serviceEnvDir: start.serviceEnvDir } : {}),
      onOutput: sink,
    }));
  }

  private async timedUp(
    serviceNames: string[],
    onOutput: ComposeOutputSink | undefined,
    attempt: (sink: ComposeOutputSink) => Promise<void>,
  ): Promise<void> {
    const start = Date.now();
    let buildAt: number | undefined;
    let createAt: number | undefined;
    let partial = "";
    const observe: ComposeOutputSink = Object.assign(
      (chunk: string) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          const phase = composeUpPhaseOf(line);
          if (phase === "build") buildAt ??= Date.now();
          else if (phase === "create") createAt ??= Date.now();
        }
        onOutput?.(chunk);
      },
      {
        flush: () => {
          if (partial) {
            const phase = composeUpPhaseOf(partial);
            if (phase === "build") buildAt ??= Date.now();
            else if (phase === "create") createAt ??= Date.now();
            partial = "";
          }
          onOutput?.flush?.();
        },
      },
    );
    try {
      await this.upWithConflictRecovery(observe, attempt);
    } finally {
      const end = Date.now();
      const parts = [`total=${end - start}ms`];
      if (buildAt !== undefined) parts.push(`build=${(createAt ?? end) - buildAt}ms`);
      if (createAt !== undefined) parts.push(`create=${end - createAt}ms`);
      console.log(
        `[timing] compose.up for ${this.sessionId} ` +
          `services=${serviceNames.join(",") || "all"} ${parts.join(" ")}`,
      );
    }
  }

  /** For `ps` and `logs`: run with `modelFreeDir()` as the working directory. */
  modelFreeArgs(...extra: string[]): string[] {
    return ["compose", "-p", composeProjectName(this.sessionId), ...extra];
  }

  modelFreeDir(): string {
    this.modelFreeDirPath ??= prepareModelFreeComposeDir(this.composeStateDir());
    return this.modelFreeDirPath;
  }

  /** `model` is null when the start's files are gone; Compose then cannot run a `pre_stop` hook. */
  stopFrom(name: string, model: ComposeStartModel | null): Promise<void> {
    if (!model) {
      console.log(
        `[compose:${this.sessionId}] stopping ${name} without the model it was started from — `
        + "a pre_stop hook, if it has one, did not run",
      );
      return this.runner(this.modelFreeArgs("stop", name), this.modelFreeDir());
    }
    return this.runner(
      [
        "compose",
        ...(model.snapshotFile ? ["-f", model.snapshotFile] : []),
        "-f", model.overrideFile,
        "-p", composeProjectName(this.sessionId), "stop", name,
      ],
      this.composeStateDir(),
    );
  }

  /** Whether the service has a container, in any state. */
  async hasContainer(service: string): Promise<boolean> {
    const out = await this.query(
      ["ps", "-aq", ...this.projectFilter(), "--filter", `label=${COMPOSE_SERVICE_LABEL}=${service}`],
      this.workspaceDir,
    );
    return out.trim().length > 0;
  }

  async runningServices(): Promise<string[]> {
    const out = await this.query(
      ["ps", ...this.projectFilter(), "--filter", "status=running", "--format", `{{.Label "${COMPOSE_SERVICE_LABEL}"}}`],
      this.workspaceDir,
    );
    return [...new Set(out.split("\n").map((s) => s.trim()).filter((s) => SERVICE_NAME.test(s)))];
  }

  /**
   * Removes, by name, this project's containers of services `keep` does not hold; `up` runs without
   * `--remove-orphans`, because its model holds only this start's services.
   */
  async removeOrphanContainers(keep: ReadonlySet<string>): Promise<string[]> {
    const out = await this.query(
      [
        "ps", "-a", ...this.projectFilter(), "--format",
        `{{.Names}}\t{{.Label "${COMPOSE_SERVICE_LABEL}"}}\t{{.Label "com.docker.compose.oneoff"}}`,
      ],
      this.workspaceDir,
    );
    const orphans: string[] = [];
    for (const line of out.split("\n")) {
      const [container, service, oneoff] = line.trim().split("\t");
      if (!container || !service || !SERVICE_NAME.test(service) || oneoff === "True") continue;
      if (!keep.has(service)) orphans.push(container);
    }
    if (orphans.length === 0) return [];
    console.log(`[compose:${this.sessionId}] Removing orphan container(s) ${orphans.join(", ")}`);
    await this.query(["rm", "-f", ...orphans], this.workspaceDir);
    return orphans;
  }

  private projectFilter(): string[] {
    return ["--filter", `label=${COMPOSE_PROJECT_LABEL}=${composeProjectName(this.sessionId)}`];
  }

  /**
   * `--volumes` still takes each container's anonymous volumes; the declared named ones are
   * unknown without a model, so they go by their project label.
   */
  async downModelFree(opts: { removeVolumes: boolean }): Promise<void> {
    const args = this.modelFreeArgs("down", "--remove-orphans");
    if (opts.removeVolumes) args.push("--volumes");
    await this.runner(args, this.modelFreeDir());
    if (opts.removeVolumes) await this.removeProjectVolumes();
  }

  async removeProjectVolumes(): Promise<string[]> {
    const project = composeProjectName(this.sessionId);
    const out = await this.query(
      ["volume", "ls", "-q", "--filter", `label=${COMPOSE_PROJECT_LABEL}=${project}`],
      this.workspaceDir,
    );
    const removed: string[] = [];
    for (const name of out.split("\n").map(s => s.trim()).filter(Boolean)) {
      try {
        await this.query(["volume", "rm", name], this.workspaceDir);
        removed.push(name);
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] could not remove volume ${name}:`, (err as Error).message);
      }
    }
    return removed;
  }

  private composeStateDir(): string {
    return this.composeStateDirOption ?? composeStateDirForWorkspace(this.workspaceDir);
  }

  async killStaleContainers(): Promise<void> {
    const stdout = await this.query(
      ["ps", "-aq", "--filter", `label=shipit-parent-session=${this.sessionId}`],
      this.workspaceDir,
    );
    let ids = stdout.split("\n").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    // Keep egress sidecars only while their network-namespace parent remains alive.
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
    try {
      await this.query(
        ["network", "rm", `shipit-session-${this.sessionId}`],
        this.workspaceDir,
      );
    } catch {
      // The network can be absent or still in use.
    }
  }

  /** Keep sidecars when parent state is unknown; a false removal breaks DNS and HTTPS. */
  private async hasLiveNetnsParent(id: string): Promise<boolean> {
    let parentId: string;
    try {
      const mode = (
        await this.query(["inspect", "-f", "{{.HostConfig.NetworkMode}}", id], this.workspaceDir)
      ).trim();
      if (!mode.startsWith("container:")) return true;
      parentId = mode.slice("container:".length).trim();
      if (!parentId) return true;
    } catch {
      return true;
    }
    try {
      // ps distinguishes absence from daemon failure and includes paused parents.
      const out = (
        await this.query(
          ["ps", "-q", "--no-trunc", "--filter", `id=${parentId}`],
          this.workspaceDir,
        )
      ).trim();
      return out.length > 0;
    } catch {
      return true;
    }
  }

  private async upWithConflictRecovery(
    onOutput: ComposeOutputSink,
    attempt: (sink: ComposeOutputSink) => Promise<void>,
  ): Promise<void> {
    // Keep the guard active through retries: a failed attempt can start some services.
    const endTopologyChange = this.onTopologyChange?.();
    try {
      await this.upAttempts(onOutput, attempt);
    } finally {
      endTopologyChange?.();
    }
  }

  private async upAttempts(
    onOutput: ComposeOutputSink,
    attempt: (sink: ComposeOutputSink) => Promise<void>,
  ): Promise<void> {
    try {
      await this.runUp(onOutput, attempt);
    } catch (err) {
      const recovery = await this.clearUpBlocker(err as Error);
      if (recovery === "none") throw err;
      try {
        await this.runUp(onOutput, attempt);
      } finally {
        // The retry recreates the network, so re-attach even when it failed: `up` creates the
        // network before the step that failed as often as not.
        if (recovery === "network") await this.rejoinSessionNetwork();
      }
    }
  }

  /** Resolve a failure `up` cannot make progress past on its own; "none" when a retry is pointless. */
  private async clearUpBlocker(err: Error): Promise<UpRecovery> {
    const conflictId = extractConflictContainerId(err.message);
    if (conflictId) {
      console.warn(
        `[compose:${this.sessionId}] Container-name conflict; removing ${conflictId.slice(0, 12)} and retrying`,
      );
      try {
        await this.query(["rm", "-f", conflictId], this.workspaceDir);
      } catch {
        return "none";
      }
      return "container";
    }

    const network = extractActiveEndpointNetwork(err.message);
    if (network === `shipit-session-${this.sessionId}`) {
      return await this.recreateSessionNetwork(network) ? "network" : "none";
    }
    return "none";
  }

  /**
   * Compose recreates the session network whenever its definition changes (planning#584 added a
   * stack label, changing the config hash), but its `network rm` fails while ShipIt's own
   * out-of-band endpoints are attached — the session's agent container and the orchestrator, which
   * joins every session network to route previews. Compose owns neither, so it can never clear
   * them and the `up` fails identically forever. Endpoints Compose DOES own are left alone: it
   * removes those itself and recovers unaided.
   *
   * Remove the network here rather than leaving it to the retried `up`: that would widen the
   * window between the disconnect and the removal to a whole build, and the poller's network heal
   * re-attaches the agent inside it.
   */
  private async recreateSessionNetwork(network: string): Promise<boolean> {
    console.warn(
      `[compose:${this.sessionId}] Network ${network} has active endpoints; ` +
        `disconnecting ShipIt's own and recreating it`,
    );
    // Two passes: the poller's network heal can re-attach the agent between the disconnect and
    // the removal, and covering that here is far less machinery than serialising with the poller.
    let severed = false;
    for (let pass = 0; pass < 2; pass++) {
      let disconnected = 0;
      for (const endpoint of [`agent-${this.sessionId.slice(0, 12)}`, os.hostname()]) {
        try {
          await this.query(["network", "disconnect", "-f", network, endpoint], this.workspaceDir);
          disconnected++;
          severed = true;
        } catch {
          // Not attached, or already gone.
        }
      }
      // Nothing of ours holds it, so the retry would fail identically.
      if (disconnected === 0) break;
      try {
        await this.query(["network", "rm", network], this.workspaceDir);
        return true;
      } catch {
        // Either a re-attach raced us, or an endpoint we do not own still holds it.
      }
    }
    // Put back what we took before the caller reports the original failure — the alternative
    // leaves the session detached from a network that still exists.
    if (severed) await this.rejoinSessionNetwork();
    return false;
  }

  private async rejoinSessionNetwork(): Promise<void> {
    try {
      await this.rejoinFn?.();
    } catch (err) {
      // Never mask the `up` failure this runs alongside.
      console.warn(
        `[compose:${this.sessionId}] re-attaching to the session network failed:`,
        (err as Error).message,
      );
    }
  }

  private async runUp(
    onOutput: ComposeOutputSink,
    attempt: (sink: ComposeOutputSink) => Promise<void>,
  ): Promise<void> {
    try {
      await attempt(onOutput);
    } finally {
      onOutput.flush?.();
    }
  }
}

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

// Compose's own rule for service names; anything else in `ps` output is not one.
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Compose can expose these through interpolation and secrets.environment; never add credentials.
// Workspace file-reference validation must also prevent reads of /proc and other host paths.
const COMPOSE_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_BUILDKIT",
  "BUILDKIT_PROGRESS",
  "COMPOSE_DOCKER_CLI_BUILD",
] as const;

/** Required for every Docker command that parses a Compose file, including log readers. */
export function composeSpawnEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMPOSE_ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const MAX_ERROR_STDERR = 8_000;

export function defaultComposeRunner(
  args: string[],
  cwd: string,
  onOutput?: ComposeOutputSink,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: composeSpawnEnv(),
    });

    let stderr = "";
    // Drain both pipes even without a sink, or a full pipe can block the process.
    proc.stdout?.on("data", (chunk: Buffer) => {
      onOutput?.(chunk.toString());
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > MAX_ERROR_STDERR) stderr = stderr.slice(-MAX_ERROR_STDERR);
      onOutput?.(text);
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
      env: composeSpawnEnv(),
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

export function extractConflictContainerId(message: string): string | undefined {
  const m = /already in use by container "([0-9a-f]{12,64})"/.exec(message);
  return m?.[1];
}

const COMPOSE_CREATE_LINE =
  /\b(?:Container|Network|Volume)\b.*\b(?:Creating|Created|Starting|Started|Recreating|Recreated|Running)\b/;

// Pulls count as build time: both prepare the image before container creation.
const COMPOSE_BUILD_LINE =
  /(?:\bBuilding\b|\bBuilt\b|\bPulling\b|\bPulled\b|\bDownloading\b|\bExtracting\b|load build definition|exporting to image|naming to)/;

const BUILDKIT_STEP_LINE = /^\s*(?:#\d+\s|=>)/;

/** `defaultComposeRunner`'s own rejection text, ahead of the first line of the command's stderr. */
const RUNNER_FAILURE_PREFIX = /^docker compose \S+ failed \(exit [^)]*\): /;

// The name carries an id on some daemon versions and not others. Requiring the surrounding daemon
// record keeps a bare mention of the phrase from reading as one.
const ACTIVE_ENDPOINTS_LINE =
  /(?:Error response from daemon|while removing network).*?\bnetwork ([^\s"]+?)(?: id [0-9a-f]+)? has active endpoints/;

/**
 * The network a failed `up` could not remove. A rejected `up` reports the tail of its whole
 * stderr, build output included, so a build that echoes a daemon error — even a complete one —
 * must not be able to trigger a destructive recovery against a healthy network.
 */
export function extractActiveEndpointNetwork(message: string): string | undefined {
  for (const raw of message.split("\n")) {
    // Strip our own wrapper first: it is glued to stderr's first line, hiding its build prefix.
    const line = raw.replace(RUNNER_FAILURE_PREFIX, "");
    if (BUILDKIT_STEP_LINE.test(line)) continue;
    const m = ACTIVE_ENDPOINTS_LINE.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

export function composeUpPhaseOf(line: string): "build" | "create" | null {
  if (COMPOSE_CREATE_LINE.test(line)) return "create";
  if (COMPOSE_BUILD_LINE.test(line) || BUILDKIT_STEP_LINE.test(line)) return "build";
  return null;
}
