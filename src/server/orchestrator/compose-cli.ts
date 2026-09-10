import { spawn } from "node:child_process";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";
import { composeProjectName } from "./compose-stack-reaper.js";

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
  composeFile: string;
  /** Absolute path outside the clone so auto-commit cannot stage the generated file. */
  overrideFile: string;
  /** Set from the project declaration, not from whether a conventional file exists. */
  noProjectFile?: boolean;
  composeRunner?: ComposeRunner;
  composeQuery?: ComposeQuery;
  /** Invalidate the API guard's container index before services can reach it. */
  onTopologyChange?: () => () => void;
}

export class ComposeCli {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private composeFile: string;
  private readonly overrideFile: string;
  private noProjectFile: boolean;
  private readonly runner: ComposeRunner;
  readonly query: ComposeQuery;
  private readonly onTopologyChange?: () => () => void;

  constructor(opts: ComposeCliOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeFile = opts.composeFile;
    this.overrideFile = opts.overrideFile;
    this.noProjectFile = opts.noProjectFile ?? false;
    this.runner = opts.composeRunner ?? defaultComposeRunner;
    this.query = opts.composeQuery ?? defaultComposeQuery;
    this.onTopologyChange = opts.onTopologyChange;
  }

  setComposeFile(file: string, noProjectFile = false): void {
    this.composeFile = file;
    this.noProjectFile = noProjectFile;
  }

  args(...extra: string[]): string[] {
    return [
      "compose",
      ...(this.noProjectFile ? [] : ["-f", this.composeFile]),
      "-f", this.overrideFile,
      "-p", composeProjectName(this.sessionId),
      ...extra,
    ];
  }

  // --build reevaluates changed build contexts even when an image is already cached.
  up(serviceNames?: string[], onOutput?: ComposeOutputSink): Promise<void> {
    return this.timedUp(
      serviceNames ?? [],
      onOutput,
      "up", "-d", "--build", "--remove-orphans", ...(serviceNames ?? []),
    );
  }

  upService(name: string, onOutput?: ComposeOutputSink): Promise<void> {
    return this.timedUp([name], onOutput, "up", "-d", "--build", name);
  }

  private async timedUp(
    serviceNames: string[],
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
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
      await this.upWithConflictRecovery(observe, ...subArgs);
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

  stop(name: string): Promise<void> {
    return this.run(undefined, "stop", name);
  }

  down(opts: { removeVolumes: boolean }): Promise<void> {
    const args = ["down", "--remove-orphans"];
    if (opts.removeVolumes) args.push("--volumes");
    return this.run(undefined, ...args);
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
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    // Keep the guard active through retries: a failed attempt can start some services.
    const endTopologyChange = this.onTopologyChange?.();
    try {
      await this.upAttempts(onOutput, ...subArgs);
    } finally {
      endTopologyChange?.();
    }
  }

  private async upAttempts(
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    try {
      await this.run(onOutput, ...subArgs);
    } catch (err) {
      const conflictId = extractConflictContainerId((err as Error).message);
      if (!conflictId) throw err;
      console.warn(
        `[compose:${this.sessionId}] Container-name conflict; removing ${conflictId.slice(0, 12)} and retrying`,
      );
      try {
        await this.query(["rm", "-f", conflictId], this.workspaceDir);
      } catch {
        throw err;
      }
      await this.run(onOutput, ...subArgs);
    }
  }

  private async run(
    onOutput: ComposeOutputSink | undefined,
    ...subArgs: string[]
  ): Promise<void> {
    const args = this.args(...subArgs);
    try {
      await this.runner(args, this.workspaceDir, onOutput);
    } finally {
      onOutput?.flush?.();
    }
  }
}

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

function defaultComposeRunner(
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

export function composeUpPhaseOf(line: string): "build" | "create" | null {
  if (COMPOSE_CREATE_LINE.test(line)) return "create";
  if (COMPOSE_BUILD_LINE.test(line) || BUILDKIT_STEP_LINE.test(line)) return "build";
  return null;
}
