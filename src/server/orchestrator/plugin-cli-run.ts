/**
 * docs/262 req 17 — run one imported plugin's companion CLI, in a container
 * that holds only what that plugin declared.
 *
 * **The boundary is the point, and it is `install`'s boundary** (plan §1b/§2).
 * A generated wrapper on the agent's PATH is ShipIt's own script; the command
 * itself never runs beside the wrapper, because the agent container can reach
 * the worker's loopback credential broker (`/agent-ops/*`, which needs no
 * token) and would therefore hand any plugin a real GitHub token. Req 19 holds
 * here by construction: this container has no `/credentials`, no worker URL, no
 * session network, and no inherited environment.
 *
 * What it DOES hold is exactly the in-session usage contract:
 *
 *  - `/plugin` — the generation's overlay volume, the pristine checkout merged
 *    with its install output. Under `repo: self` (req 27) it is the session's
 *    own working tree instead, mounted read-write, because there the plugin is
 *    deliberately live and editable.
 *  - `/project` — the consuming project's workspace (req 21), and the cwd, so a
 *    cwd-addressed tool behaves as it would have beside the agent. A plugin's
 *    durable output lands here as ordinary project changes (req 18).
 *  - `/plugin-state` — this import's shared state directory, the one writable
 *    surface that is neither project data nor plugin source, and the thing that
 *    makes "the CLI and the UI work on the same live state" true (reqs 17, 18).
 *  - `/plugin-settings.json` — read-only, when the import has validated
 *    settings (req 26).
 *  - the plugin's **declared** credential names, resolved from the consuming
 *    project's own secret store, and nothing else from it (req 23).
 *
 * **Collisions are re-checked here, not trusted from the wrapper** (req 20).
 * The wrapper is a file on a container filesystem and a declaration can change
 * under it; the requirement is that ShipIt reports the collision *before
 * running the ambiguous one*, so the run boundary re-derives the same plan and
 * refuses with the same message.
 *
 * The recheck covers the two domains this side can know — a name two imports
 * claim, and a name ShipIt reserves. It does NOT re-run the **PATH** probe: the
 * PATH that matters belongs to the agent container, which the orchestrator
 * cannot see. That domain is enforced where it is knowable, by the wrapper
 * generator refusing to write the file (`session/plugin-cli.ts`); a shadowing
 * name therefore never becomes a wrapper, and normal shell lookup runs the
 * program that was already there. What is left uncovered is a direct
 * `shipit plugin exec` for such a name, which is not the ambiguity req 20 is
 * about — nothing there is ambiguous, the caller named one import explicitly.
 *
 * Output is **buffered**, not streamed. Two hops of NDJSON relaying is real
 * machinery, and the plan already accepts per-call latency here ("a
 * credential-blind persistent runner is a later optimisation"). The cost is
 * that a long command shows nothing until it exits; the cap below is what keeps
 * that from becoming a memory problem.
 */

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
import { resolveShipitConfig } from "../shared/shipit-config.js";
import {
  activeLinkPath,
  readGenerationManifestAt,
  readGenerationRecordAt,
} from "./plugin-generations.js";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import { ensurePluginRuntimeOverlay, resolvePluginOverlayRoots } from "./plugin-overlay.js";
import {
  createPluginImportResolver,
  pluginSettingsPath,
  pluginStateDir,
  sessionRootForWorkspace,
} from "./plugin-state.js";
import { loadSatisfiedPluginCredentialNames } from "./plugin-credentials.js";
import type { SecretStore } from "./secret-store.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { chownToSessionWorker, sessionWorkerUid } from "./session-worker-uid.js";

/**
 * Dedicated network for CLI invocation containers — separate from install's,
 * so the two are independently deniable and a rule change to one cannot widen
 * the other. See `plugin-container.ts` for why it is not the default
 * bridge and not the session's network.
 */
export const PLUGIN_CLI_NETWORK = "shipit-plugin-cli";

/** Stamped on the container so an orphan is identifiable and sweepable. */
export const PLUGIN_CLI_LABEL = "shipit-plugin-cli";

/**
 * How long one companion-CLI call may run. Generous, because a companion CLI is
 * a real program — but bounded, because the shim's transport is deliberately
 * unbounded and a hung command would otherwise hold an agent turn open forever.
 */
export const DEFAULT_PLUGIN_CLI_TIMEOUT_MS = 15 * 60_000;

/** Memory ceiling, matching the install container's order of magnitude. */
const CLI_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const CLI_PIDS_LIMIT = 512;
/** Per-stream output cap. Buffered output cannot be unbounded. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export interface PluginCliDeps {
  docker: Docker;
  /** The session-worker image, for its toolchain — its ENTRYPOINT is bypassed. */
  image: string;
  sessionId: string;
  workspaceDir: string;
  /** The consuming project's remote — the secret store is keyed by it (req 23). */
  consumerRepoUrl: string | null;
  /**
   * The consuming project's secret store. Typed as the load method alone, the
   * same narrowing `plugin-credentials.ts` uses, so no caller can pass a store
   * that knows about ShipIt's own credentials — `CredentialStore` (the GitHub
   * token, tracker tokens, agent routes) does not fit this parameter.
   */
  secretStore?: Pick<SecretStore, "loadSecrets">;
  /** Volume name + orchestrator-visible state root; both omitted in dev/dogfood. */
  workspaceVolume?: string;
  stateRoot?: string;
  timeoutMs?: number;
  /**
   * Whether the session this call belongs to is gone (archived, reset,
   * disposed). Without it the `"cancelled"` branch below is unreachable and a
   * hung command keeps its project and state mounts, and its network, for the
   * full timeout after the session it served stopped existing — which is
   * precisely why `install` takes the same hook (review finding).
   */
  isCancelled?: () => boolean;
}

export interface PluginCliRequest {
  /** The `use:` entry's alias — the import, not the plugin. */
  alias: string;
  /** The command as the plugin's manifest declares it (pre-rename). */
  command: string;
  args: string[];
  /** The wrapper's working directory in the agent container. */
  cwd?: string;
  stdin?: string;
}

export interface PluginCliResult {
  /** Set when ShipIt refused to run — a bad alias, a collision, no generation. */
  error?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one command. Returns a result rather than throwing: every failure here is
 * something the agent needs to read, and an exception would reach it as an
 * opaque 500 with the reason in the orchestrator's log.
 */
export async function runPluginCommand(
  deps: PluginCliDeps,
  req: PluginCliRequest,
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
  const resolver = createPluginImportResolver(config.plugins, config.pluginExports, stateDir);
  const repoName = resolver.repoNameFor(use);
  if (!repoName) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }
  const repo = config.plugins.repos.find((r) => r.name === repoName);
  const isSelf = repo?.source.kind === "self";

  // **Resolve `active` exactly ONCE, here, and read every fact about the live
  // generation out of that one answer** (sibling report, docs/262). Docker
  // resolves a bind source and a `volume.subpath` at container-CREATION time,
  // and each of `readActiveManifest`, `readActiveGeneration` and a `realpath`
  // for the lowerdir follows the symlink independently — so a refresh landing
  // between them produced an entrypoint from generation A, a
  // `SHIPIT_PLUGIN_COMMIT` and volume NAME from B, and a lowerdir from C. That
  // last pair is the damaging one: a volume named for B whose lower tree is C's
  // and whose writable layer is B's, left on disk under B's name for every
  // later caller. Pinning the directory first makes the whole call describe one
  // generation or fail.
  let pinned: PinnedGeneration | null = null;
  if (!isSelf) {
    try {
      pinned = pinGeneration(stateDir, repoName);
    } catch (err) {
      return refuse(`\`${repoName}\`'s active checkout could not be resolved: ${message(err)}`);
    }
    if (!pinned) {
      return refuse(`\`${repoName}\` has no active version in this session yet — run \`shipit plugin refresh ${repoName}\`.`);
    }
  }

  // For THIS repository the manifest comes from the pinned directory, never
  // from a fresh symlink read — the entrypoint the container runs and the tree
  // it is mounted from have to be the same generation. Other repositories keep
  // the resolver: they contribute only to the collision verdict below, where a
  // slightly older read cannot corrupt a mount.
  const exported = pinned
    ? pinned.exports.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null
    : resolver.exportFor(use);
  if (!exported) {
    return refuse(`\`${req.alias}\` has no live plugin version right now — refresh it, or check the Plugins tab.`);
  }

  // req 20, at the run boundary. The wrapper that called us is a file, and the
  // declaration may have changed since it was written; the requirement is that
  // an ambiguous name is reported rather than run. No `isTaken` — see the
  // module docstring: the PATH that matters is the agent container's.
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

  // The plugin's own tree. Tracked: the generation's overlay volume, so the CLI
  // sees the SAME merged checkout+install-output the installer produced. Self:
  // the working tree itself, live and writable — req 27's whole point.
  const mounts: MountSpec[] = [];
  let commit: string | null = null;
  if (!pinned) {
    mounts.push(sessionPathMount(deps, deps.workspaceDir, CONTAINER_PLUGIN_DIR, false));
  } else {
    commit = pinned.commit;
    try {
      const roots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
      const volume = await ensurePluginRuntimeOverlay(deps.docker, {
        sessionId: deps.sessionId,
        repoName,
        // Both from the SAME pinned directory, so the volume's name and its
        // lowerdir can never describe two different generations.
        commit: pinned.commit,
        stateDir,
        checkoutDir: pinned.dir,
        ...roots,
      });
      // A NAMED volume, so it needs no path translation: the daemon already
      // knows where it is, which is exactly why install could get away with one
      // bind and this cannot.
      mounts.push({ Type: "volume", Source: volume, Target: CONTAINER_PLUGIN_DIR, ReadOnly: false });
    } catch (err) {
      return refuse(`\`${repoName}\`'s plugin tree could not be prepared: ${message(err)}`);
    }
  }

  // The import's state directory. Normally already there (a prepare pass runs
  // at the end of every activation round), but created here too: a CLI call is
  // allowed to be the first thing that happens in a session, and an absent
  // directory would otherwise appear inside the plugin as a bind mount Docker
  // created as root — unwritable, for a reason nothing explains.
  const hostStateDir = pluginStateDir(sessionRoot, use.alias);
  try {
    fs.mkdirSync(hostStateDir, { recursive: true });
    chownToSessionWorker(hostStateDir);
  } catch (err) {
    return refuse(`\`${use.alias}\`'s shared state directory could not be prepared: ${message(err)}`);
  }

  const hostSettings = pluginSettingsPath(sessionRoot, use.alias);
  const hasSettings = fs.existsSync(hostSettings);

  mounts.push(sessionPathMount(deps, deps.workspaceDir, CONTAINER_PROJECT_DIR, false));
  mounts.push(sessionPathMount(deps, hostStateDir, CONTAINER_PLUGIN_STATE_DIR, false));
  if (hasSettings) {
    mounts.push(sessionPathMount(deps, hostSettings, CONTAINER_PLUGIN_SETTINGS_FILE, true));
  }

  const env = [
    `${PLUGIN_PROJECT_ENV}=${CONTAINER_PROJECT_DIR}`,
    `${PLUGIN_STATE_ENV}=${CONTAINER_PLUGIN_STATE_DIR}`,
    ...(hasSettings ? [`${PLUGIN_SETTINGS_ENV}=${CONTAINER_PLUGIN_SETTINGS_FILE}`] : []),
    // req 15 — readable by the plugin itself, and UNSET under `repo: self`,
    // which is how a plugin tells a live working tree from an exact commit.
    ...(commit ? [`${PLUGIN_COMMIT_ENV}=${commit}`] : []),
    "HOME=/tmp",
    "npm_config_update_notifier=false",
    ...declaredCredentialEnv(deps, exported.credentials),
  ];

  try {
    // Fail closed, before anything starts: a plugin container ShipIt cannot
    // deny at its own API is not one to run.
    await ensureUntrustedPluginNetwork(deps.docker, PLUGIN_CLI_NETWORK);
  } catch (err) {
    return refuse(`the plugin network could not be prepared: ${message(err)}`);
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
    });
  } catch (err) {
    // The daemon refusing to create or start the container is the ordinary
    // failure mode of a plugin whose entrypoint is not executable or has no
    // shebang — a mistake in the plugin, reported as one. Letting it throw
    // would reach the agent as an opaque 500 with the cause only in the
    // orchestrator's log.
    return refuse(`\`${surfaced.name}\` could not be started (${entry}): ${message(err)}`);
  }
}

/**
 * One live generation, resolved ONCE: its concrete directory, the commit its
 * record names, and the manifest that directory carries.
 *
 * Everything downstream reads from this rather than from the `active` symlink,
 * which is what keeps the entrypoint, the commit, the volume name and the
 * lowerdir describing one generation — see the call site for the failure the
 * per-fact reads produced.
 */
interface PinnedGeneration {
  dir: string;
  commit: string;
  exports: PluginExport[];
}

/**
 * Resolve `active` and read the generation behind it. `null` when the
 * repository has no live generation; throws only when the link exists but
 * cannot be resolved, which the caller reports as its own failure.
 */
function pinGeneration(stateDir: string, repoName: string): PinnedGeneration | null {
  const link = activeLinkPath(stateDir, repoName);
  if (!fs.existsSync(link)) return null;
  const dir = fs.realpathSync(link);
  const record = readGenerationRecordAt(dir);
  // A directory with no readable record is not a generation this may run: the
  // commit is req 15's identity, and inventing one would mis-name the volume.
  if (!record) return null;
  return { dir, commit: record.commit, exports: readGenerationManifestAt(dir) };
}

/**
 * One mount, in whichever form the runtime actually has.
 *
 * **This is not cosmetic, and a plain bind is wrong in production** (review
 * finding). The orchestrator sees a session under its own `/workspace/...`; in
 * production that whole tree lives inside a named volume the daemon knows
 * nothing about, so handing those paths to Docker as bind sources creates
 * empty, root-owned directories instead of the project — `/project` would not
 * be the project and `/plugin-state` would not be the state a plugin service is
 * writing to, which is reqs 17, 18, 21 and 27 all silently untrue. The
 * established translation is a volume mount with `VolumeOptions.Subpath`
 * (`container-lifecycle.ts`, and `compose-generator.ts` for service
 * containers); this mirrors it.
 *
 * The subpath is taken relative to `stateRoot` — the orchestrator-visible root
 * of that volume — rather than a hardcoded `/workspace/`, which is the same
 * pair `resolvePluginOverlayRoots` already threads through for the overlay's
 * daemon paths. Both must be present for the volume form: `workspaceVolume`
 * alone cannot say where the volume begins.
 *
 * `install` sidesteps all of this because its ONE mount is a named volume, and
 * a name needs no translation. Every other mount here is a session path.
 */
interface MountSpec {
  Type: "bind" | "volume";
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

export function sessionPathMount(
  deps: Pick<PluginCliDeps, "workspaceVolume" | "stateRoot">,
  hostPath: string,
  target: string,
  readOnly: boolean,
): MountSpec {
  const root = deps.stateRoot?.replace(/\/$/, "");
  const inside = root && (hostPath === root || hostPath.startsWith(`${root}/`));
  if (!deps.workspaceVolume || !inside) {
    // Dev / dogfood: the state dir is a bind mount and the daemon sees the same
    // paths this process does, so the identity translation is the correct one.
    // A path OUTSIDE the volume gets the same treatment for the same reason
    // `daemonPath` passes it through — better unchanged than silently rewritten
    // to somewhere unrelated.
    return { Type: "bind", Source: hostPath, Target: target, ReadOnly: readOnly };
  }
  return {
    Type: "volume",
    Source: deps.workspaceVolume,
    Target: target,
    ReadOnly: readOnly,
    VolumeOptions: { Subpath: path.relative(root, hostPath) },
  };
}

/**
 * Only the names the plugin declared, and only those the consuming project has
 * a value for.
 *
 * A missing one is deliberately omitted rather than sent empty: req 23 wants a
 * missing key to be a visible, named gap (the Plugins tab's needs rows), and an
 * empty-string credential turns that into an authentication error from a
 * third-party API instead.
 *
 * **Nothing outside the consuming project's own `SecretStore` can reach here**
 * (req 23, last sentence). This module does not import `CredentialStore` and
 * could not use one if it did: the dep is typed as `loadSecrets` alone, and the
 * key is the consuming session's remote — never the plugin repository's, which
 * is the trap `plan.md` §3 records for the "Add key…" affordance and which
 * applies identically on the read side.
 */
function declaredCredentialEnv(deps: PluginCliDeps, declared: readonly string[]): string[] {
  if (declared.length === 0 || !deps.consumerRepoUrl || !deps.secretStore) return [];
  // WHICH names count as satisfied is the credential slice's decision, taken
  // once (`loadSatisfiedPluginCredentialNames`: SecretStore only, keyed by the
  // consuming session's remote, non-empty values only). Delivery reads it
  // rather than re-deriving it, so the card cannot say "satisfied" while the
  // container gets nothing, or the reverse.
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

/**
 * Where the command runs, translated from the wrapper's own cwd.
 *
 * A companion CLI is invoked the way any other command is — from wherever the
 * agent happens to be — so a cwd inside the workspace is carried across as the
 * matching path under `/project`. Anything else (a cwd outside the workspace,
 * a path that no longer exists, one that escapes) falls back to the project
 * root: Docker would otherwise CREATE the working directory, which for a path
 * under `/project` means writing a stray directory into the user's repository.
 */
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
}

/** Create, attach, run, and collect. */
async function execute(deps: PluginCliDeps, spec: ExecuteSpec): Promise<PluginCliResult> {
  const uid = sessionWorkerUid();
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_CLI_LABEL]: deps.sessionId },
    // The image's ENTRYPOINT prepares a session's mounts and drops privileges
    // for the worker; none of that applies here, and its chown loop would walk
    // mounts this container does not have.
    Entrypoint: [spec.entry],
    Cmd: spec.args,
    WorkingDir: spec.workingDir,
    Env: spec.env,
    ...(uid !== null ? { User: `${uid}:${uid}` } : {}),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: {
      // Cast the same way `container-lifecycle.ts` does: dockerode's
      // `MountSettings` demands every `VolumeOptions` field, while the daemon
      // accepts `Subpath` alone.
      Mounts: spec.mounts as unknown as Docker.MountSettings[],
      NetworkMode: PLUGIN_CLI_NETWORK,
      AutoRemove: false, // removed below, after the exit code is read
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: CLI_MEMORY_BYTES,
      PidsLimit: CLI_PIDS_LIMIT,
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_CLI_TIMEOUT_MS;
  try {
    // Attached BEFORE start: output written between start and attach is simply
    // gone, and for a command that only prints one line that is all of it.
    const stream = await container.attach({
      stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
    });
    const out = new Capture();
    const err = new Capture();
    deps.docker.modem.demuxStream(stream, out.sink, err.sink);

    await container.start();
    // `StdinOnce` closes the container's stdin on end, so a command reading to
    // EOF terminates whether or not the caller piped anything.
    stream.end(spec.stdin);

    const code = await waitForContainerExit(container, timeoutMs, deps.isCancelled);
    // `wait` can resolve before the attach stream has delivered its last
    // chunk — the container is gone and the bytes are still in flight — so a
    // command that prints one line and exits could report nothing at all.
    // Bounded, because a stream that never ends must not outlive the container
    // it belonged to.
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
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** How long the output stream may take to finish after the container exits. */
const STREAM_DRAIN_MS = 5_000;

/**
 * Resolve once the hijacked attach stream is done, or after a short grace.
 *
 * Never rejects: an errored stream means the output is as complete as it is
 * going to get, and the exit code — which came from the daemon, not from
 * here — is still the answer the caller needs.
 */
function streamSettled(stream: Duplex): Promise<void> {
  // Checked first, and not just for speed: an already-finished stream emits
  // neither `end` nor `close` again, so a listener-only implementation would
  // pay the full grace period on the common path — every short command.
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

/**
 * A bounded sink for one output stream.
 *
 * Buffered output has to have a ceiling: this text crosses two HTTP hops and
 * lands in an agent's context. Truncation is announced in the stream itself
 * rather than silently — output that stops mid-sentence reads as a crashed
 * command.
 */
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
