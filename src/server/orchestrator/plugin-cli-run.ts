import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import {
  CONTAINER_PLUGIN_DIR,
  CONTAINER_PLUGIN_SETTINGS_FILE,
  CONTAINER_PLUGIN_STATE_DIR,
  CONTAINER_PROJECT_DIR,
  PLUGIN_COMMIT_ENV,
  PLUGIN_PROJECT_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_STATE_ENV,
} from "../shared/plugin-contract.js";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { planPluginCommands } from "../shared/plugin-cli.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { destinationKey } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import {
  activeLinkPath,
  generationIdFor,
  readGenerationManifestAt,
  readGenerationRecordAt,
} from "./plugin-generations.js";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import { pluginContainerEnv } from "./plugin-container-env.js";
import {
  preparePluginNetns,
  UNCONTAINED_PLUGIN_EGRESS,
  type PluginEgressPolicy,
  type PluginNetns,
} from "./plugin-egress.js";
import { holdGeneration, type ReleaseHold } from "./plugin-leases.js";
import { assertOverlayVolumesMatch } from "./overlay-volume.js";
import {
  ensurePluginRuntimeOverlay,
  pluginRuntimeOverlaySpec,
  resolvePluginOverlayRoots,
  type PluginOverlaySpec,
} from "./plugin-overlay.js";
import { resolveLiveGenerations } from "./plugin-generations.js";
import {
  createPluginImportResolver,
  pluginSettingsPath,
  pluginStateDir,
  sessionRootForWorkspace,
  volumeSubpathFor,
} from "./plugin-state.js";
import { loadSatisfiedPluginCredentialNames } from "./plugin-credentials.js";
import type { SecretStore } from "./secret-store.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { chownToSessionWorker, identityForSession } from "./session-worker-uid.js";

// Separate from session networks, which expose the worker's credential broker.
export const PLUGIN_CLI_NETWORK = "shipit-plugin-cli";
export const PLUGIN_CLI_LABEL = "shipit-plugin-cli";
export const DEFAULT_PLUGIN_CLI_TIMEOUT_MS = 15 * 60_000;

const CLI_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const CLI_PIDS_LIMIT = 512;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export interface PluginCliDeps {
  docker: Docker;
  image: string;
  sessionId: string;
  workspaceDir: string;
  consumerRepoUrl: string | null;
  // Project secrets only; ShipIt's CredentialStore must never enter plugin containers.
  secretStore?: Pick<SecretStore, "loadSecrets">;
  workspaceVolume?: string;
  stateRoot?: string;
  depStoreDir?: string;
  // Resolve actual mounted volumes at call time; workspace config may have changed.
  overlayDepDirs?: () => Promise<readonly { depDir: string; volumeName: string }[]>;
  timeoutMs?: number;
  // Host grants and session policy can change between calls.
  egress?: () => PluginEgressPolicy;
  isCancelled?: () => boolean;
}

export interface PluginCliRequest {
  alias: string;
  // Manifest command name, before an import renames it.
  command: string;
  args: string[];
  cwd?: string;
  stdin?: string;
}

export interface PluginCliResult {
  error?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runPluginCommand(
  deps: PluginCliDeps,
  req: PluginCliRequest,
): Promise<PluginCliResult> {
  const held: { release?: ReleaseHold } = {};
  try {
    return await runHeldPluginCommand(deps, req, held);
  } finally {
    held.release?.();
  }
}

async function runHeldPluginCommand(
  deps: PluginCliDeps,
  req: PluginCliRequest,
  held: { release?: ReleaseHold },
): Promise<PluginCliResult> {
  const refuse = (error: string): PluginCliResult => ({ error, exitCode: 126, stdout: "", stderr: "" });

  let stateDir: string;
  let sessionRoot: string;
  try {
    stateDir = sessionStateDirForWorkspace(deps.workspaceDir);
    sessionRoot = sessionRootForWorkspace(deps.workspaceDir);
  } catch (err) {
    return refuse(`this session has no plugin state directory: ${message(err)}`);
  }

  const config = resolveShipitConfig(deps.workspaceDir);
  const use = config.plugins.uses.find((u) => u.alias.toLowerCase() === req.alias.toLowerCase());
  if (!use) {
    return refuse(`\`${req.alias}\` is not a plugin this project imports (check \`plugins.use\` in shipit.yaml).`);
  }
  // Use this resolver for other repositories; read the target from one pinned generation.
  const resolver = createPluginImportResolver(
    config.plugins,
    config.pluginExports,
    resolveLiveGenerations(stateDir, config.plugins.repos),
  );
  const repoName = resolver.repoNameFor(use);
  if (!repoName) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }
  const repo = config.plugins.repos.find((r) => r.name === repoName);
  const isSelf = repo?.source.kind === "self";

  // Pin once so a concurrent refresh cannot mix the manifest, commit, and mounted tree.
  let pinned: PinnedGeneration | null = null;
  if (!isSelf) {
    if (!repo) {
      return refuse(`\`${repoName}\` is not a declared plugin repository in this project.`);
    }
    try {
      pinned = pinGeneration(deps.sessionId, stateDir, repoName, destinationKey(repo.source));
    } catch (err) {
      return refuse(`\`${repoName}\`'s active checkout could not be resolved: ${message(err)}`);
    }
    if (pinned) held.release = pinned.release;
    if (!pinned) {
      return refuse(`\`${repoName}\` has no active version in this session yet — run \`shipit plugin refresh ${repoName}\`.`);
    }
  }

  const exported = pinned
    ? pinned.exports.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null
    : resolver.exportFor(use);
  if (!exported) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }

  // Recheck import collisions; PATH collisions are checked by the worker's wrapper generator.
  const plan = planPluginCommands(config.plugins.uses, (u) => {
    const uRepo = resolver.repoNameFor(u);
    if (pinned && uRepo === repoName) {
      return {
        repo: uRepo,
        exported: pinned.exports.find((e) => e.name.toLowerCase() === u.plugin.toLowerCase()) ?? null,
      };
    }
    return { repo: uRepo, exported: resolver.exportFor(u) };
  });
  const surfaced = plan.commands.find(
    (c) => c.alias.toLowerCase() === use.alias.toLowerCase()
      && c.declared.toLowerCase() === req.command.toLowerCase(),
  );
  if (!surfaced) {
    const issues = plan.issues.get(repoName) ?? [];
    return refuse(
      issues.length > 0
        ? issues.join("\n")
        : `\`${req.command}\` is not a command \`${exported.name}\` exports.`,
    );
  }

  const mounts: MountSpec[] = [];
  const mountErrors: string[] = [];
  const addSessionMount = (hostPath: string, target: string, readOnly: boolean): void => {
    try {
      mounts.push(sessionPathMount(deps, hostPath, target, readOnly));
    } catch (err) {
      mountErrors.push(message(err));
    }
  };
  const workspaceTreeTargets: string[] = [];
  let commit: string | null = null;
  let overlaySpec: PluginOverlaySpec | undefined;
  if (!pinned) {
    addSessionMount(deps.workspaceDir, CONTAINER_PLUGIN_DIR, false);
    workspaceTreeTargets.push(CONTAINER_PLUGIN_DIR, CONTAINER_PROJECT_DIR);
  } else {
    commit = pinned.commit;
    try {
      const roots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
      const overlayArgs = {
        sessionId: deps.sessionId,
        repoName,
        generationId: pinned.generationId,
        stateDir,
        checkoutDir: pinned.dir,
        ...(deps.depStoreDir ? { depStoreDir: deps.depStoreDir } : {}),
        ...roots,
      };
      overlaySpec = pluginRuntimeOverlaySpec(overlayArgs);
      const volume = await ensurePluginRuntimeOverlay(deps.docker, overlayArgs);
      // Only install may write a tracked generation; services share this same volume.
      mounts.push({ Type: "volume", Source: volume, Target: CONTAINER_PLUGIN_DIR, ReadOnly: true });
    } catch (err) {
      return refuse(`\`${repoName}\`'s plugin tree could not be prepared: ${message(err)}`);
    }
  }

  // Create before mounting so Docker cannot leave a root-owned, unwritable state directory.
  const hostStateDir = pluginStateDir(sessionRoot, use.alias);
  try {
    fs.mkdirSync(hostStateDir, { recursive: true });
    chownToSessionWorker(hostStateDir);
  } catch (err) {
    return refuse(`\`${use.alias}\`'s shared state directory could not be prepared: ${message(err)}`);
  }

  const hostSettings = pluginSettingsPath(sessionRoot, use.alias);
  const hasSettings = fs.existsSync(hostSettings);

  addSessionMount(deps.workspaceDir, CONTAINER_PROJECT_DIR, false);
  addSessionMount(hostStateDir, CONTAINER_PLUGIN_STATE_DIR, false);
  if (hasSettings) {
    addSessionMount(hostSettings, CONTAINER_PLUGIN_SETTINGS_FILE, true);
  }
  // Missing overlays may break dependent commands; keep dependency-free commands usable.
  try {
    for (const { depDir, volumeName } of (await deps.overlayDepDirs?.()) ?? []) {
      for (const target of workspaceTreeTargets) {
        mounts.push({
          Type: "volume",
          Source: volumeName,
          Target: path.posix.join(target, depDir),
        });
      }
    }
  } catch (err) {
    console.warn(
      `[plugins:${deps.sessionId}] could not resolve this session's overlay dep dirs for `
      + `\`${req.command}\` — a plugin that loads a dependency out of the project's tree will `
      + `fail to import it:`,
      message(err),
    );
  }
  if (mountErrors.length > 0) {
    return refuse(
      `this session's files could not be mounted into the plugin container: ${mountErrors.join("; ")}.`,
    );
  }

  const env = [
    `${PLUGIN_PROJECT_ENV}=${CONTAINER_PROJECT_DIR}`,
    `${PLUGIN_STATE_ENV}=${CONTAINER_PLUGIN_STATE_DIR}`,
    ...(hasSettings ? [`${PLUGIN_SETTINGS_ENV}=${CONTAINER_PLUGIN_SETTINGS_FILE}`] : []),
    ...(commit ? [`${PLUGIN_COMMIT_ENV}=${commit}`] : []),
    // Tracked imports use install's tool paths. Self imports use the image's tools.
    ...(await pluginContainerEnv(deps.docker, deps.image, { toolchain: pinned !== null })),
    ...declaredCredentialEnv(deps, exported.credentials.map((c) => c.name)),
  ];

  try {
    await ensureUntrustedPluginNetwork(deps.docker, PLUGIN_CLI_NETWORK);
  } catch (err) {
    return refuse(`the plugin network could not be prepared: ${message(err)}`);
  }

  let netns: PluginNetns;
  try {
    netns = await preparePluginNetns({
      docker: deps.docker,
      sessionId: deps.sessionId,
      network: PLUGIN_CLI_NETWORK,
      holderImage: deps.image,
      policy: deps.egress?.() ?? UNCONTAINED_PLUGIN_EGRESS,
    });
  } catch (err) {
    return refuse(`this session's network policy could not be applied to the plugin container: ${message(err)}`);
  }

  const entry = path.posix.join(CONTAINER_PLUGIN_DIR, surfaced.entry);
  try {
    return await execute(deps, {
      mounts,
      env,
      entry,
      args: req.args,
      workingDir: mapWorkingDir(deps.workspaceDir, req.cwd),
      stdin: req.stdin ?? "",
      networkMode: netns.networkMode,
      overlaySpec,
    });
  } catch (err) {
    return refuse(`\`${surfaced.name}\` could not be started (${entry}): ${message(err)}`);
  } finally {
    await netns.release();
  }
}

interface PinnedGeneration {
  dir: string;
  commit: string;
  generationId: string;
  exports: PluginExport[];
  release: ReleaseHold;
}

function pinGeneration(
  sessionId: string,
  stateDir: string,
  repoName: string,
  expectedSource: string,
): PinnedGeneration | null {
  const link = activeLinkPath(stateDir, repoName);
  if (!fs.existsSync(link)) return null;
  const dir = fs.realpathSync(link);
  const record = readGenerationRecordAt(dir);
  if (!record) return null;
  // A changed repository declaration must not execute the previous repository's active tree.
  if (record.source !== expectedSource) return null;
  // No await between resolving active and holding it: refresh could otherwise prune the tree.
  const generationId = generationIdFor(dir, record);
  const release = holdGeneration({ sessionId, repoName, generationId });
  if (!release) {
    throw new Error("the version it resolved was replaced mid-call — run the command again");
  }
  return { dir, commit: record.commit, generationId, exports: readGenerationManifestAt(dir), release };
}

export interface MountSpec {
  Type: "bind" | "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

export class PluginMountError extends Error {}

// Volume-backed paths need translation: a bind would name the daemon's filesystem instead.
export function sessionPathMount(
  deps: Pick<PluginCliDeps, "workspaceVolume" | "stateRoot">,
  hostPath: string,
  target: string,
  readOnly: boolean,
): MountSpec {
  if (!deps.workspaceVolume) {
    return { Type: "bind", Source: hostPath, Target: target, ReadOnly: readOnly };
  }
  const subpath = deps.stateRoot ? volumeSubpathFor(deps.stateRoot, hostPath) : null;
  if (subpath === null) {
    throw new PluginMountError(
      `\`${target}\` (${hostPath}) is not inside this deployment's session volume`,
    );
  }
  return {
    Type: "volume",
    Source: deps.workspaceVolume,
    Target: target,
    ReadOnly: readOnly,
    VolumeOptions: { Subpath: subpath },
  };
}

function declaredCredentialEnv(deps: PluginCliDeps, declared: readonly string[]): string[] {
  if (declared.length === 0 || !deps.consumerRepoUrl || !deps.secretStore) return [];
  const satisfied = loadSatisfiedPluginCredentialNames(deps.secretStore, deps.consumerRepoUrl);
  const wanted = declared.filter((name) => satisfied.has(name));
  if (wanted.length === 0) return [];
  try {
    const stored = deps.secretStore.loadSecrets(deps.consumerRepoUrl);
    return wanted.map((name) => `${name}=${stored[name]}`);
  } catch {
    return [];
  }
}

// Reject absent directories so Docker cannot create stray paths in the project.
export function mapWorkingDir(workspaceDir: string, cwd: string | undefined): string {
  if (!cwd) return CONTAINER_PROJECT_DIR;
  const rel = path.posix.relative(CONTAINER_WORKSPACE_DIR, path.posix.normalize(cwd));
  if (!rel) return CONTAINER_PROJECT_DIR;
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) return CONTAINER_PROJECT_DIR;
  try {
    if (!fs.statSync(path.join(workspaceDir, rel)).isDirectory()) return CONTAINER_PROJECT_DIR;
  } catch {
    return CONTAINER_PROJECT_DIR;
  }
  return path.posix.join(CONTAINER_PROJECT_DIR, rel);
}

interface ExecuteSpec {
  mounts: MountSpec[];
  env: string[];
  entry: string;
  args: string[];
  workingDir: string;
  stdin: string;
  networkMode: string;
  overlaySpec?: PluginOverlaySpec;
}

async function execute(deps: PluginCliDeps, spec: ExecuteSpec): Promise<PluginCliResult> {
  const identity = identityForSession(deps.sessionId);
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_CLI_LABEL]: deps.sessionId },
    // Bypass the worker entrypoint, which prepares mounts this container does not have.
    Entrypoint: [spec.entry],
    Cmd: spec.args,
    WorkingDir: spec.workingDir,
    Env: spec.env,
    ...(identity !== null ? { User: `${identity.uid}:${identity.gid}` } : {}),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: {
      // Docker accepts Subpath alone; dockerode requires all VolumeOptions fields.
      Mounts: spec.mounts as unknown as Docker.MountSettings[],
      NetworkMode: spec.networkMode,
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: CLI_MEMORY_BYTES,
      PidsLimit: CLI_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_CLI_TIMEOUT_MS;
  try {
    if (spec.overlaySpec) {
      await assertOverlayVolumesMatch(deps.docker, [spec.overlaySpec], {
        sessionId: deps.sessionId,
      });
    }
    // Attach before start to capture even commands that exit immediately.
    const stream = await container.attach({
      stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
    });
    const out = new Capture();
    const err = new Capture();
    deps.docker.modem.demuxStream(stream, out.sink, err.sink);

    await container.start();
    stream.end(spec.stdin);

    const code = await waitForContainerExit(container, timeoutMs, deps.isCancelled);
    // Container exit can precede the last output chunk.
    await streamSettled(stream as unknown as Duplex);
    if (code === "timeout") {
      return {
        error: `\`${path.posix.basename(spec.entry)}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        exitCode: 124,
        stdout: out.text(),
        stderr: err.text(),
      };
    }
    if (code === "cancelled") {
      return { error: "the session went away while the command was running", exitCode: 125, stdout: out.text(), stderr: err.text() };
    }
    return { exitCode: typeof code === "number" ? code : 1, stdout: out.text(), stderr: err.text() };
  } finally {
    await container.remove({ force: true }).catch((err: unknown) => {
      console.warn(
        `[plugins:${deps.sessionId}] could not remove the companion-CLI container ${container.id} — `
        + "it is stranded until the next orchestrator restart:",
        message(err),
      );
    });
  }
}

const STREAM_DRAIN_MS = 5_000;

function streamSettled(stream: Duplex): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, STREAM_DRAIN_MS);
    timer.unref?.();
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

class Capture {
  readonly sink = new PassThrough();
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  constructor() {
    this.sink.on("data", (chunk: Buffer) => {
      if (this.size >= MAX_STREAM_BYTES) {
        this.truncated = true;
        return;
      }
      const room = MAX_STREAM_BYTES - this.size;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(slice);
      this.size += slice.length;
      if (slice.length < chunk.length) this.truncated = true;
    });
  }

  text(): string {
    const body = Buffer.concat(this.chunks).toString("utf-8");
    return this.truncated ? `${body}\n…[output truncated by ShipIt at 8 MiB]\n` : body;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
