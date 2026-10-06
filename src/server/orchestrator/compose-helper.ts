/**
 * Confined Compose containers (docs/318-compose-remaining-escapes, Mechanism 1). Every Compose
 * command that reads a session's project files runs in a throwaway container of a minimal helper
 * image that mounts only what that command needs, so the kernel confines each path and symlink
 * the project names.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import type { SessionIdentity } from "../shared/session-identity.js";
import { killChild } from "../shared/kill-child.js";
import { composeSpawnEnv, type ComposeOutputSink } from "./compose-cli.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { composeStateDirForWorkspace, sessionScratchDirForWorkspace } from "./session-state-dir.js";
import { identityForSession } from "./session-worker-uid.js";
import { stackLabel, stackLabelFilters } from "./stack-label.js";

export const COMPOSE_HELPER_LABEL = "shipit-compose-helper";
export const COMPOSE_HELPER_IMAGE_ENV = "SESSION_COMPOSE_HELPER_IMAGE";
/** Docker-host path of SHIPIT_SERVICE_ENV_DIR when that directory is outside the workspace volume. */
export const SERVICE_ENV_HOST_DIR_ENV = "SHIPIT_SERVICE_ENV_HOST_DIR";

const WORKSPACE_VOLUME_ROOT = "/workspace";
const CONTAINER_DOCKER_SOCKET = "/var/run/docker.sock";
const HELPER_TMPFS = "/tmp:rw,nosuid,nodev,noexec,mode=1777,size=128m";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_STDOUT_BYTES = 64 * 1024 * 1024;
const READ_TIMEOUT_MS = 120_000;
const MAX_ERROR_STDERR = 8_000;

// Copies the project file to the tmpfs first so its length and bytes agree, frames it on stdout as
// `<length>\n<bytes>`, then execs `docker compose config`, which writes after it.
const RAW_THEN_EXEC = [
  "set -e",
  'f=$1; max=$2; shift 2',
  'head -c "$((max + 1))" -- "$f" > /tmp/project-file',
  "n=$(wc -c < /tmp/project-file)",
  'if [ "$n" -gt "$max" ]; then echo "$f is larger than $max bytes" >&2; exit 65; fi',
  "printf '%s\\n' \"$n\"",
  "cat /tmp/project-file",
  "rm -f /tmp/project-file",
  'exec "$@"',
].join("\n");

export type ComposeHelperImage =
  | { status: "ready"; name: string; id: string }
  | { status: "missing"; name: string | undefined; reason: string };

let helperImage: ComposeHelperImage = {
  status: "missing",
  name: undefined,
  reason: "ShipIt did not resolve it at startup",
};

/** Pinned by id, as `resolveWorkerImageId` pins the worker image. */
export async function resolveComposeHelperImage(
  docker: Pick<Docker, "getImage">,
  name: string | undefined,
): Promise<ComposeHelperImage> {
  if (!name) return { status: "missing", name, reason: `${COMPOSE_HELPER_IMAGE_ENV} is not set` };
  try {
    const info = await docker.getImage(name).inspect();
    if (info.Id) return { status: "ready", name, id: info.Id };
    return { status: "missing", name, reason: "Docker reported no image id" };
  } catch (err) {
    return { status: "missing", name, reason: message(err) };
  }
}

export function setComposeHelperImage(image: ComposeHelperImage): void {
  helperImage = image;
}

export function composeHelperImage(): ComposeHelperImage {
  return helperImage;
}

export type ComposeHelperErrorKind =
  | "unavailable" | "start" | "failed" | "timeout" | "cancelled" | "output-limit";

export class ComposeHelperError extends Error {
  constructor(
    message: string,
    readonly kind: ComposeHelperErrorKind,
    /** The project file's raw bytes, when a failed `config` run got as far as reading it. */
    readonly projectFile?: Buffer,
  ) {
    super(message);
    this.name = "ComposeHelperError";
  }
}

export interface HelperRunRequest {
  /** The whole `docker` argv, starting with `run`. */
  args: string[];
  containerName: string;
  stdin?: string;
  onOutput?: ComposeOutputSink;
  captureStdout?: boolean;
  maxStdoutBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HelperRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  interrupted?: "timeout" | "cancelled" | "output-limit";
}

export type HelperRunner = (req: HelperRunRequest) => Promise<HelperRunResult>;

export interface HelperRunnerDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  removeContainer?: (name: string) => Promise<void>;
}

/**
 * Killing the `docker run` client leaves its container running, so every early end also removes
 * the container by name, and the result waits for that removal.
 */
export function createHelperRunner(deps: HelperRunnerDeps = {}): HelperRunner {
  const spawnFn = deps.spawn ?? spawn;
  const removeContainer = deps.removeContainer ?? removeContainerByName;
  return (req) => new Promise<HelperRunResult>((resolve) => {
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let interrupted: HelperRunResult["interrupted"];
    let removal: Promise<void> = Promise.resolve();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawnFn("docker", req.args, {
      stdio: [req.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: composeSpawnEnv(),
    });

    const interrupt = (why: NonNullable<HelperRunResult["interrupted"]>): void => {
      if (settled || interrupted) return;
      interrupted = why;
      removal = removeContainer(req.containerName).catch((err: unknown) => {
        console.warn(`[compose-helper] could not remove ${req.containerName}:`, message(err));
      });
      killChild(proc);
    };
    const onAbort = (): void => interrupt("cancelled");
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      const result: HelperRunResult = {
        code,
        stdout: Buffer.concat(chunks),
        stderr,
        ...(interrupted ? { interrupted } : {}),
      };
      void (async () => {
        await removal;
        resolve(result);
      })();
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      req.onOutput?.(chunk.toString());
      if (!req.captureStdout) return;
      stdoutBytes += chunk.length;
      if (req.maxStdoutBytes !== undefined && stdoutBytes > req.maxStdoutBytes) {
        interrupt("output-limit");
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > MAX_ERROR_STDERR) stderr = stderr.slice(-MAX_ERROR_STDERR);
      req.onOutput?.(text);
    });
    proc.on("error", (err) => {
      stderr += err.message;
      settle(null);
    });
    proc.on("close", (code) => settle(code));

    if (req.stdin !== undefined) {
      // The container can exit before reading all of it; that surfaces as its own failure.
      proc.stdin?.on("error", () => {});
      proc.stdin?.end(req.stdin);
    }
    if (req.timeoutMs !== undefined) {
      const timeoutMs = req.timeoutMs;
      timer = setTimeout(() => interrupt("timeout"), timeoutMs);
      timer.unref?.();
    }
    if (req.signal?.aborted) interrupt("cancelled");
    else req.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function removeContainerByName(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", ["rm", "-f", name], { stdio: "ignore", env: composeSpawnEnv() });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker rm -f ${name} exited ${code}`));
    });
  });
}

/** `p` relative to the workspace volume's root, or null when it is not inside that volume. */
export function workspaceVolumeSubpath(p: string): string | null {
  const rel = path.posix.relative(WORKSPACE_VOLUME_ROOT, p);
  return rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel) ? null : rel;
}

/**
 * Docker-host path of a ShipIt directory outside the workspace volume, for a bind source. A path
 * inside the volume has none ShipIt can name — the volume's `Mountpoint` is the daemon's own path,
 * which on Docker Desktop is not a host path, and Docker creates and mounts an empty directory for
 * a bind source that is missing — so it is mounted as the volume (`ConfinedCompose.shipitMount`).
 * Without a workspace volume (the bind deployment) the orchestrator's path is the host's.
 */
export function composeHelperDaemonPath(opts: {
  workspaceVolume?: string;
  serviceEnvDir?: string;
  serviceEnvHostDir?: string;
}): (orchestratorPath: string) => Promise<string> {
  const { workspaceVolume, serviceEnvDir, serviceEnvHostDir } = opts;
  return async (p) => {
    if (workspaceVolume && workspaceVolumeSubpath(p) !== null) {
      throw new Error(`${p} is inside the workspace volume ${workspaceVolume}, which has no Docker-host path.`);
    }
    const inServiceEnv = serviceEnvDir !== undefined && isWithin(p, serviceEnvDir);
    if (inServiceEnv && serviceEnvHostDir) {
      return path.posix.join(serviceEnvHostDir, path.posix.relative(serviceEnvDir, p));
    }
    if (!workspaceVolume) return p;
    if (inServiceEnv) {
      throw new Error(
        `ShipIt keeps service environment files in ${serviceEnvDir} (SHIPIT_SERVICE_ENV_DIR), `
        + "outside the workspace volume, so it cannot tell Docker where they are. Set "
        + `${SERVICE_ENV_HOST_DIR_ENV} to that directory's path on the Docker host.`,
      );
    }
    throw new Error(`ShipIt does not know the Docker-host path of ${p}, which is outside the workspace volume.`);
  };
}

export function composeRegistryLoginDir(stateDir: string): string {
  return path.join(stateDir, "compose-registry-login");
}

export function dockerClientConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"), "config.json");
}

/**
 * Copies the orchestrator's Docker client configuration as `config.json` into `loginDir`, a
 * root-only directory `up` mounts as its DOCKER_CONFIG. Returns false, and removes an earlier
 * copy, when there is none.
 */
export function stageRegistryLogin(loginDir: string, sourceFile = dockerClientConfigFile()): boolean {
  let body: Buffer | null = null;
  try {
    body = fs.readFileSync(sourceFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[compose-helper] could not read the Docker client configuration ${sourceFile}:`, message(err));
    }
  }
  fs.mkdirSync(loginDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(loginDir).isDirectory()) throw new Error(`${loginDir} is not a directory.`);
  fs.chmodSync(loginDir, 0o700);
  const target = path.join(loginDir, "config.json");
  if (body === null) {
    fs.rmSync(target, { force: true });
    return false;
  }
  // Starts of other sessions may read it at the same time.
  const tmp = path.join(loginDir, `.config.json.${process.pid}.${randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return true;
}

export interface ConfinedComposeOptions {
  sessionId: string;
  workspaceDir: string;
  /** Defaults to `<sessionDir>/scratch`. */
  scratchDir?: string;
  /** Defaults to `<sessionDir>/state/compose`. */
  composeStateDir?: string;
  /** WORKSPACE_VOLUME; absent in the bind deployment. */
  workspaceVolume?: string;
  /** See `composeHelperDaemonPath`. */
  daemonPath: (orchestratorPath: string) => Promise<string>;
  /** Where `up` gets the registry login; see `composeRegistryLoginDir`. */
  registryLoginDir?: string;
  dockerClientConfigFile?: string;
  stackName?: string;
  dockerSocketHostPath?: string;
  image?: () => ComposeHelperImage;
  identity?: () => SessionIdentity | null;
  socketGid?: () => number | null;
  env?: () => NodeJS.ProcessEnv;
  run?: HelperRunner;
}

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type HelperCommand = "config" | "read" | "build" | "up";

interface HelperSpec extends RunOptions {
  command: HelperCommand;
  user: string;
  groupAdd?: number;
  workdir: string;
  mounts: string[];
  env: NodeJS.ProcessEnv;
  cmd: string[];
  stdin?: string;
  onOutput?: ComposeOutputSink;
  captureStdout?: boolean;
  maxStdoutBytes?: number;
}

export type ConfinedComposeApi = Pick<
  ConfinedCompose,
  "config" | "readProjectFile" | "readWorkspaceFile" | "build" | "up"
>;

export class ConfinedCompose {
  private readonly sessionId: string;
  private readonly project: string;
  private readonly workspaceDir: string;
  private readonly scratchDir: string;
  private readonly composeStateDir: string;
  private readonly workspaceVolume?: string;
  private readonly daemonPath: (p: string) => Promise<string>;
  private readonly registryLoginDir?: string;
  private readonly dockerClientConfigFile?: string;
  private readonly stackName?: string;
  private readonly dockerSocketHostPath: string;
  private readonly image: () => ComposeHelperImage;
  private readonly identity: () => SessionIdentity | null;
  private readonly socketGid: () => number | null;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly run: HelperRunner;

  constructor(opts: ConfinedComposeOptions) {
    this.sessionId = opts.sessionId;
    this.project = composeProjectName(opts.sessionId);
    this.workspaceDir = opts.workspaceDir;
    this.scratchDir = opts.scratchDir ?? sessionScratchDirForWorkspace(opts.workspaceDir);
    this.composeStateDir = opts.composeStateDir ?? composeStateDirForWorkspace(opts.workspaceDir);
    this.workspaceVolume = opts.workspaceVolume;
    this.daemonPath = opts.daemonPath;
    this.registryLoginDir = opts.registryLoginDir;
    this.dockerClientConfigFile = opts.dockerClientConfigFile;
    this.stackName = opts.stackName;
    this.dockerSocketHostPath = opts.dockerSocketHostPath ?? CONTAINER_DOCKER_SOCKET;
    this.image = opts.image ?? composeHelperImage;
    this.identity = opts.identity ?? (() => identityForSession(opts.sessionId));
    this.socketGid = opts.socketGid ?? defaultSocketGid;
    this.env = opts.env ?? (() => process.env);
    this.run = opts.run ?? createHelperRunner();
  }

  /**
   * `docker compose config --no-consistency <services>`; `stdin` is an extra model file (`-f -`).
   * Also returns the project file's raw bytes, read in the same container.
   */
  async config(opts: RunOptions & {
    projectFile: string;
    services: readonly string[];
    stdin?: string;
  }): Promise<{ stdout: string; projectFile: Buffer }> {
    const compose = [
      "docker", "compose", "-p", this.project, "-f", opts.projectFile,
      ...(opts.stdin !== undefined ? ["-f", "-"] : []),
      "config", "--no-consistency", ...positional(opts.services),
    ];
    const result = await this.runHelper({
      ...opts,
      command: "config",
      user: this.sessionUser(),
      workdir: this.workspaceDir,
      mounts: this.projectMounts(true),
      // Interpolation happens here, so the environment is exactly the one Compose had before.
      env: composeSpawnEnv(this.env()),
      cmd: ["sh", "-c", RAW_THEN_EXEC, "sh", opts.projectFile, String(MAX_FILE_BYTES), ...compose],
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      captureStdout: true,
      maxStdoutBytes: MAX_CONFIG_STDOUT_BYTES,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    });
    const framed = splitFramed(result.stdout);
    if (result.code !== 0) {
      throw this.failure("config", "docker compose config", result, { pathFix: true }, framed?.projectFile);
    }
    if (!framed) {
      throw new ComposeHelperError(
        "ShipIt's Compose helper returned output it could not read the project file from.",
        "failed",
      );
    }
    return { stdout: framed.rest.toString(), projectFile: framed.projectFile };
  }

  readProjectFile(projectFile: string, opts: RunOptions = {}): Promise<Buffer> {
    return this.readWorkspaceFile(projectFile, opts);
  }

  /** A file of this session's workspace or scratch; relative paths are from the workspace. */
  async readWorkspaceFile(file: string, opts: RunOptions = {}): Promise<Buffer> {
    const abs = path.posix.resolve(this.workspaceDir, file);
    if (!isWithin(abs, this.workspaceDir) && !isWithin(abs, this.scratchDir)) {
      throw new ComposeHelperError(
        `ShipIt reads only files inside this session's workspace; ${file} is outside it.`,
        "failed",
      );
    }
    const result = await this.runHelper({
      ...opts,
      command: "read",
      user: this.sessionUser(),
      workdir: this.workspaceDir,
      mounts: this.projectMounts(true),
      env: composeSpawnEnv(this.env()),
      cmd: ["head", "-c", String(MAX_FILE_BYTES + 1), "--", abs],
      captureStdout: true,
      maxStdoutBytes: MAX_FILE_BYTES + 1,
      timeoutMs: opts.timeoutMs ?? READ_TIMEOUT_MS,
    });
    if (result.code !== 0) throw this.failure("read", `Reading ${file}`, result, { pathFix: true });
    if (result.stdout.length > MAX_FILE_BYTES) {
      throw new ComposeHelperError(`${file} is larger than ${MAX_FILE_BYTES} bytes.`, "failed");
    }
    return result.stdout;
  }

  /** `docker compose build` of the build model on stdin; the workspace is writable, no ShipIt file is mounted. */
  async build(opts: RunOptions & {
    buildModel: string;
    services: readonly string[];
    onOutput?: ComposeOutputSink;
  }): Promise<void> {
    const gid = this.socketGid();
    const result = await this.runHelper({
      ...opts,
      command: "build",
      user: this.sessionUser(),
      ...(gid !== null ? { groupAdd: gid } : {}),
      workdir: this.workspaceDir,
      mounts: [...this.projectMounts(false), this.socketMount()],
      env: {
        ...this.socketEnv(),
        // Build tooling keeps its state here; it goes with the container.
        HOME: "/tmp",
        DOCKER_CONFIG: "/tmp/.docker",
        BUILDX_CONFIG: "/tmp/.docker/buildx",
      },
      cmd: ["docker", "compose", "-p", this.project, "-f", "-", "build", ...positional(opts.services)],
      stdin: opts.buildModel,
    });
    if (result.code !== 0) {
      throw this.failure("build", "docker compose build", result, { pathFix: true, registryNote: true });
    }
  }

  /**
   * `docker compose up -d --no-build` from ShipIt's own files; it sees no workspace, so it runs as
   * root to read the root-only override, service-env files, and registry login. Each mounted
   * directory must exist: a volume subpath that is missing fails the container start.
   */
  async up(opts: RunOptions & {
    snapshotFile?: string;
    overrideFile: string;
    services: readonly string[];
    /** This session's service-env directory, when a service has an env file there. */
    serviceEnvDir?: string;
    onOutput?: ComposeOutputSink;
  }): Promise<void> {
    const files = [...(opts.snapshotFile ? [opts.snapshotFile] : []), opts.overrideFile];
    for (const file of files) {
      if (!isWithin(file, this.composeStateDir)) {
        throw new ComposeHelperError(`${file} is not in ${this.composeStateDir}, the only directory \`up\` sees.`, "failed");
      }
    }
    let loginDir: string | null = null;
    if (this.registryLoginDir) {
      try {
        if (stageRegistryLogin(this.registryLoginDir, this.dockerClientConfigFile)) loginDir = this.registryLoginDir;
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] could not copy the registry login for \`up\`:`, message(err));
      }
    }
    let mounts: string[];
    try {
      mounts = [
        await this.shipitMount(this.composeStateDir),
        ...(opts.serviceEnvDir ? [await this.shipitMount(opts.serviceEnvDir)] : []),
        ...(loginDir ? [await this.shipitMount(loginDir)] : []),
        this.socketMount(),
      ];
    } catch (err) {
      throw new ComposeHelperError(`ShipIt could not mount its Compose files: ${message(err)}`, "unavailable");
    }
    const result = await this.runHelper({
      ...opts,
      command: "up",
      user: "0:0",
      workdir: this.composeStateDir,
      mounts,
      env: {
        ...this.socketEnv(),
        HOME: "/tmp",
        DOCKER_CONFIG: loginDir ?? "/tmp/.docker",
      },
      cmd: [
        "docker", "compose", "-p", this.project, ...files.flatMap((f) => ["-f", f]),
        "up", "-d", "--no-build", ...positional(opts.services),
      ],
    });
    if (result.code !== 0) throw this.failure("up", "docker compose up", result, {});
  }

  private async runHelper(spec: HelperSpec): Promise<HelperRunResult> {
    const image = this.image();
    if (image.status !== "ready") {
      throw new ComposeHelperError(
        `ShipIt cannot run Compose for this session: its Compose helper image`
        + `${image.name ? ` (${image.name})` : ""} was not available when ShipIt started (${image.reason}). `
        + "Rebuild ShipIt's images with the deployment's build script, which builds the compose-helper "
        + "image, and restart ShipIt.",
        "unavailable",
      );
    }
    const containerName = `${COMPOSE_HELPER_LABEL}-${spec.command}-${this.sessionId.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
    const labels = { [COMPOSE_HELPER_LABEL]: this.sessionId, ...stackLabel(this.stackName) };
    const args = [
      "run", "--rm", "--name", containerName,
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      "--pull", "never",
      "--network", "none",
      "--read-only", "--tmpfs", HELPER_TMPFS,
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--user", spec.user,
      ...(spec.groupAdd !== undefined ? ["--group-add", String(spec.groupAdd)] : []),
      "--workdir", spec.workdir,
      ...(spec.stdin !== undefined ? ["-i"] : []),
      ...spec.mounts.flatMap((m) => ["--mount", m]),
      ...Object.entries(spec.env).flatMap(([k, v]) => (v === undefined ? [] : ["-e", `${k}=${v}`])),
      image.id,
      ...spec.cmd,
    ];
    try {
      return await this.run({
        args,
        containerName,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
        ...(spec.onOutput ? { onOutput: spec.onOutput } : {}),
        ...(spec.captureStdout ? { captureStdout: true } : {}),
        ...(spec.maxStdoutBytes !== undefined ? { maxStdoutBytes: spec.maxStdoutBytes } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
    } finally {
      spec.onOutput?.flush?.();
    }
  }

  private failure(
    command: HelperCommand,
    what: string,
    result: HelperRunResult,
    notes: { pathFix?: boolean; registryNote?: boolean },
    projectFile?: Buffer,
  ): ComposeHelperError {
    const stderr = result.stderr.trim();
    if (result.interrupted === "timeout") {
      return new ComposeHelperError(`${what} did not finish in time; ShipIt stopped its helper container.`, "timeout", projectFile);
    }
    if (result.interrupted === "cancelled") {
      return new ComposeHelperError(`${what} was cancelled; ShipIt stopped its helper container.`, "cancelled", projectFile);
    }
    if (result.interrupted === "output-limit") {
      return new ComposeHelperError(`${what} produced more output than ShipIt accepts.`, "output-limit", projectFile);
    }
    // `docker run` itself: 125 is a daemon error, 126/127 a command the image cannot run.
    if (result.code === null || result.code === 125 || result.code === 126 || result.code === 127) {
      return new ComposeHelperError(
        `ShipIt could not start its Compose helper container for \`${command}\` (exit ${result.code}): ${stderr}`,
        "start",
        projectFile,
      );
    }
    let text = `${what} failed (exit ${result.code}): ${stderr}`;
    if (notes.pathFix && PATH_READ_FAILURE.test(stderr)) {
      text += "\n\nCompose runs in a container that holds only this session's workspace, so every file "
        + "the project names, and every symlink it follows, must point inside the workspace.";
    }
    if (notes.registryNote && REGISTRY_AUTH_FAILURE.test(stderr)) {
      text += "\n\nBuilds do not get ShipIt's registry login (only the service images `up` pulls do), "
        + "so a base image that needs it cannot be pulled here. Use a base image the build can pull "
        + "without a login, or publish the image and name it with `image:` instead.";
    }
    return new ComposeHelperError(text, "failed", projectFile);
  }

  private sessionUser(): string {
    const id = this.identity();
    return id ? `${id.uid}:${id.gid}` : "0:0";
  }

  /** The workspace and scratch at their orchestrator paths, so paths in a model mean the same inside. */
  private projectMounts(readOnly: boolean): string[] {
    const mounts = [this.workspaceMount(this.workspaceDir, readOnly)];
    if (fs.existsSync(this.scratchDir)) mounts.push(this.workspaceMount(this.scratchDir, readOnly));
    return mounts;
  }

  // A subpath of the shared volume, like the workspace mount of `.` (`workspaceVolumeMount`): neither
  // directory can be swapped for a symlink, because its parent is mounted into no container.
  private workspaceMount(dir: string, readOnly: boolean): string {
    assertMountable(dir);
    const ro = readOnly ? ",readonly" : "";
    if (!this.workspaceVolume) return `type=bind,src=${dir},dst=${dir}${ro}`;
    const rel = workspaceVolumeSubpath(dir);
    if (rel === null) {
      throw new ComposeHelperError(`${dir} is not inside the workspace volume ${this.workspaceVolume}.`, "unavailable");
    }
    return `type=volume,src=${this.workspaceVolume},dst=${dir},volume-subpath=${rel}${ro}`;
  }

  // One of ShipIt's own directories, read-only. Inside the workspace volume it is mounted as the
  // volume, never by a host path (see `composeHelperDaemonPath`).
  private async shipitMount(dir: string): Promise<string> {
    if (this.workspaceVolume && workspaceVolumeSubpath(dir) !== null) return this.workspaceMount(dir, true);
    assertMountable(dir);
    const src = await this.daemonPath(dir);
    assertMountable(src);
    return `type=bind,src=${src},dst=${dir},readonly`;
  }

  private socketMount(): string {
    assertMountable(this.dockerSocketHostPath);
    return `type=bind,src=${this.dockerSocketHostPath},dst=${CONTAINER_DOCKER_SOCKET}`;
  }

  // Only the mounted socket reaches the daemon; the orchestrator's contexts and certificates are not here.
  private socketEnv(): NodeJS.ProcessEnv {
    const env = composeSpawnEnv(this.env());
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_CERT_PATH;
    delete env.DOCKER_TLS_VERIFY;
    return { ...env, DOCKER_HOST: `unix://${CONTAINER_DOCKER_SOCKET}`, TMPDIR: "/tmp" };
  }
}

// Stat, open, and read errors on a path, from Compose, BuildKit, or `head`.
const PATH_READ_FAILURE =
  /\b(?:open|lstat|stat|readlink|cannot open)\b[^\n]*?:\s*(?:no such file or directory|permission denied|not a directory|too many levels of symbolic links)|unable to prepare context/i;

const REGISTRY_AUTH_FAILURE =
  /\b(?:unauthorized|authentication required|pull access denied|no basic auth credentials|failed to authorize|failed to fetch (?:oauth|anonymous) token)\b|denied: requested access/i;

/** Service names after `--`, so a name cannot be read as an option. */
function positional(services: readonly string[]): string[] {
  return services.length > 0 ? ["--", ...services] : [];
}

function splitFramed(stdout: Buffer): { projectFile: Buffer; rest: Buffer } | null {
  const nl = stdout.indexOf(0x0a);
  if (nl < 0) return null;
  const length = Number(stdout.subarray(0, nl).toString().trim());
  if (!Number.isSafeInteger(length) || length < 0 || nl + 1 + length > stdout.length) return null;
  return {
    projectFile: stdout.subarray(nl + 1, nl + 1 + length),
    rest: stdout.subarray(nl + 1 + length),
  };
}

// `--mount` is comma-separated; ShipIt's paths never hold a comma.
function assertMountable(p: string): void {
  if (!path.posix.isAbsolute(p) || /[,"\n]/.test(p)) {
    throw new ComposeHelperError(`ShipIt cannot mount ${JSON.stringify(p)} into its Compose helper.`, "unavailable");
  }
}

function isWithin(p: string, dir: string): boolean {
  const rel = path.posix.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.posix.isAbsolute(rel));
}

function defaultSocketGid(): number | null {
  const host = process.env.DOCKER_HOST;
  const socket = host?.startsWith("unix://") ? host.slice("unix://".length) : CONTAINER_DOCKER_SOCKET;
  try {
    return fs.statSync(socket).gid;
  } catch {
    return null;
  }
}

/**
 * Removes helper containers an earlier orchestrator process left behind. One this process started
 * is live, so a helper created at or after boot is kept.
 */
export async function reapOrphanComposeHelpers(
  docker: Pick<Docker, "listContainers" | "getContainer">,
  opts: { stackName?: string; paceMs?: number; bootMs?: number } = {},
): Promise<number> {
  const bootSeconds = Math.floor((opts.bootMs ?? Date.now() - process.uptime() * 1000) / 1000);
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [COMPOSE_HELPER_LABEL, ...stackLabelFilters(opts.stackName)] },
  });
  let removed = 0;
  for (const { Id, Created } of containers) {
    if (typeof Created === "number" && Created >= bootSeconds) continue;
    try {
      await docker.getContainer(Id).remove({ force: true });
      removed++;
    } catch {
      // It may have exited and removed itself.
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return removed;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
