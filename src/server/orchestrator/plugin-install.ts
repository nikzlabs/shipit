/**
 * docs/262 — run a plugin's `install`, in a container that holds nothing else.
 *
 * This is the third and last piece of the install redesign (plan §1b). The
 * first two are already in place: `activateGeneration` calls an injected
 * `runInstall` against the STAGING checkout, before anything is published, and
 * `plugin-overlay.ts` composes the copy-on-write layer install writes into.
 * This module is what actually executes a repo-authored command.
 *
 * **Where it runs is the whole point.** Two earlier attempts were rejected:
 *
 *  - In the **orchestrator** — this process holds ShipIt's own credentials (the
 *    PAT in the global git config) and has unrestricted host access.
 *  - In the **agent container** — that container can reach the worker's
 *    loopback credential broker (`/agent-ops/*`, which needs no worker token),
 *    so anything running there can obtain a real GitHub token. Scrubbing the
 *    environment does not close that: the route is listening either way.
 *
 * So the install gets a container of its own, and it holds exactly one thing:
 * the generation's overlay volume (the pristine checkout merged with its own
 * writable layer). No `/credentials`, no `/workspace`, no worker URL, no
 * session network, no inherited environment. Reqs 7 and 19 hold **by
 * construction** here rather than by convention.
 *
 * The image is the session-worker image, for its toolchain (node, npm, git) —
 * but its ENTRYPOINT is deliberately bypassed. That script prepares a session's
 * mounts and drops privileges for the worker; none of it applies here, and its
 * chown loop would walk mounts this container does not have.
 *
 * **The volume is removed when install finishes.** Publish renames the staging
 * directory, so the runtime volume for the same generation has a different
 * lowerdir over the SAME upper layer — and the kernel forbids one upperdir
 * backing two independently created overlay mounts. The upper layer is an
 * ordinary directory and survives, which is how install output outlives the
 * rename that made it reachable.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { CONTAINER_PLUGIN_DIR, PLUGIN_COMMIT_ENV } from "../shared/plugin-contract.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import type { PluginInstallJob, PluginInstallResult } from "./plugin-generations.js";
import { pluginsRoot } from "./plugin-generations.js";
import {
  adoptPluginDepBases,
  planPluginDepStore,
  pluginBasePinDir,
  pluginDepCacheDir,
  promotePluginDepDirs,
} from "./plugin-dep-store.js";
import {
  buildPluginOverlaySpec,
  createPluginOverlay,
  pluginWorkDir,
  removePluginOverlay,
  resolvePluginOverlayRoots,
  PLUGIN_OVERLAY_LABEL,
} from "./plugin-overlay.js";
import { chownToSessionWorker, chownTreeToSessionWorker, identityForSession } from "./session-worker-uid.js";
import { ensureUntrustedPluginNetwork, waitForContainerExit } from "./plugin-container.js";
import {
  preparePluginNetns,
  unreachableDeclaredHosts,
  UNCONTAINED_PLUGIN_EGRESS,
  PLUGIN_NETNS_LABEL,
  type PluginEgressPolicy,
  type PluginNetns,
} from "./plugin-egress.js";
import { PLUGIN_CLI_LABEL, sessionPathMount, type MountSpec } from "./plugin-cli-run.js";
import { DEP_CACHE_CONTAINER_PATH } from "../shared/fs-constants.js";
import { writeInstallRecord, type PluginInstallOutcome } from "./plugin-install-record.js";

/**
 * Where the merged checkout is mounted inside the install container. The
 * contract constant, not a second spelling of it: a plugin's `cli:` entrypoints
 * are declared relative to its repository root and must resolve at the same
 * path in every container that runs plugin code (`plugin-contract.ts`).
 */
export const PLUGIN_INSTALL_DIR = CONTAINER_PLUGIN_DIR;

/**
 * Dedicated network for install containers. Never the default bridge, and
 * never a session's network.
 *
 * Install needs outbound access — `npm ci` fetches. But outbound includes the
 * host gateway, and ShipIt's own API is published there. The orchestrator's
 * container-origin guard reads "source IP I do not recognise" as "browser or
 * host" and lets it straight through, so an install container on any
 * unregistered network would have had MORE API reach than an agent container:
 * enumerate sessions, then ask `/api/sessions/<id>/git/credential` for a real
 * GitHub token. Its own network exists so the whole subnet can be declared
 * untrusted **before the first container joins it** — registering a container's
 * address after it starts leaves the first request unguarded, and that request
 * is precisely the one worth making.
 */
export const PLUGIN_INSTALL_NETWORK = "shipit-plugin-install";

/** Stamped on the install container so an orphan is identifiable and sweepable. */
export const PLUGIN_INSTALL_LABEL = "shipit-plugin-install";

/**
 * How long one install command may run before it is killed. Generous — a cold
 * `npm ci` on a large plugin is minutes — but bounded: without it a hung
 * install would hold the per-repo activation queue open for the life of the
 * process, and every later refresh of that repository behind it.
 */
export const DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Memory ceiling for the install container. */
const INSTALL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
/** Fork bomb ceiling, matching the session container's order of magnitude. */
const INSTALL_PIDS_LIMIT = 512;
/** How much of a failed install's output travels back into the failure reason. */
const LOG_TAIL_LINES = 40;
const REASON_MAX_CHARS = 2000;

export interface PluginInstallDeps {
  docker: Docker;
  /** Image to run install in — the session-worker image, for its toolchain. */
  image: string;
  sessionId: string;
  /** The session's state dir, the same one activation stages generations into. */
  stateDir: string;
  /**
   * req 28 — the ORCHESTRATOR state dir, which holds the shared dependency
   * store (`overlay-base/`, shared by every session). Distinct from `stateRoot`
   * below, which exists only to translate paths for the daemon and is absent in
   * bind-mount deployments. Omitted → no store, and install behaves exactly as
   * it did before req 28.
   */
  depStoreDir?: string;
  /**
   * Name of the workspace volume, and the orchestrator-visible root that maps
   * onto it. Both omitted in dev/dogfood, where the state dir is a bind mount
   * and the daemon sees the same paths this process does.
   */
  workspaceVolume?: string;
  stateRoot?: string;
  timeoutMs?: number;
  /**
   * docs/262 req 24 — this session's egress posture, read when the install runs
   * rather than when the runner is built: activation can be triggered by a
   * refresh long after the session opened. Absent only where there is no
   * container manager, which is also where there is no install container.
   */
  egress?: () => PluginEgressPolicy;
}

/** One export's install command, already trimmed and known non-empty. */
interface InstallCommand {
  plugin: string;
  command: string;
}

/**
 * The selected exports that actually declare an install, in manifest order.
 * Pure — an export without `install` contributes nothing, and a repository
 * where nothing is selected or nothing installs skips the container entirely.
 */
export function installCommands(exportsList: readonly PluginExport[]): InstallCommand[] {
  return exportsList
    .filter((e): e is PluginExport & { install: string } => Boolean(e.install?.trim()))
    .map((e) => ({ plugin: e.name, command: e.install.trim() }));
}

/**
 * What a completed install was built from. Install is re-run whenever this
 * changes — which for a consumer generation means "whenever the commit
 * changes", since the commit determines the content of every input.
 *
 * It exists for the case that is NOT a new commit: an install that succeeded
 * and then had its publish fail leaves a populated upper layer, and the next
 * attempt re-stages the same commit. Re-running there is not wrong, only
 * wasted; the stamp turns it into a no-op.
 */
export function installStamp(job: PluginInstallJob): string {
  return JSON.stringify({ commit: job.commit, commands: installCommands(job.exports) });
}

/** Path of the stamp — beside the upper/work dirs, never inside the merged view. */
export function installStampPath(stateDir: string, repoName: string, commit: string): string {
  return path.join(pluginWorkDir(stateDir, repoName, commit), "install-stamp.json");
}

/**
 * Build the `runInstall` hook `activateGeneration` calls. Returns
 * `{ok: false}` rather than throwing: a failed install is a failed activation,
 * and the caller's contract is that the prior generation stays live (req 15).
 */
export function createPluginInstallRunner(
  deps: PluginInstallDeps,
): (job: PluginInstallJob) => Promise<PluginInstallResult> {
  return async (job) => {
    // docs/266 — one place to record what this attempt did, so no terminal path
    // can return without leaving the answer somewhere a session can read
    // (`plugin-install-record.ts` explains why the generation record cannot
    // carry it).
    const record = (outcome: PluginInstallOutcome, detail?: string): void =>
      writeInstallRecord(pluginsRoot(deps.stateDir), job.repoName, {
        commit: job.commit,
        at: new Date().toISOString(),
        outcome,
        ...(detail ? { detail } : {}),
      });

    const commands = installCommands(job.exports);
    // Nothing declares an install, so nothing happened and nothing is recorded.
    // The absence is the honest answer here, and `describeInstallRecord` renders
    // it as an absence with both its causes named rather than as "fine".
    if (commands.length === 0) return { ok: true };

    // **Every path out of the body below leaves a record, including the ones
    // that THROW** (review finding). The documented contract is that this runner
    // returns `{ok:false}` rather than throwing, and the daemon calls after the
    // install — releasing the overlay volume, promoting to the shared store,
    // dropping the netns — can each break it. An install that ran and then died
    // in one of those used to leave a session reading "no install record", which
    // is the wrong half of the one distinction this record exists to make. The
    // error still propagates unchanged; only the diagnostic is added.
    try {
      return await runInstallOnce(deps, job, commands, record);
    } catch (err) {
      record("failed", `the install did not complete: ${message(err)}`);
      throw err;
    }
  };
}

/** The body of {@link createPluginInstallRunner}, with the recording wrapper around it. */
async function runInstallOnce(
  deps: PluginInstallDeps,
  job: PluginInstallJob,
  commands: readonly InstallCommand[],
  record: (outcome: PluginInstallOutcome, detail?: string) => void,
): Promise<PluginInstallResult> {

    const stampPath = installStampPath(deps.stateDir, job.repoName, job.commit);
    const stamp = installStamp(job);
    const layerDirs = {
      upperdir: path.join(pluginWorkDir(deps.stateDir, job.repoName, job.commit), "upper"),
      workdir: path.join(pluginWorkDir(deps.stateDir, job.repoName, job.commit), "work"),
    };

    // This generation's own layer is already installed — the
    // succeeded-then-failed-to-publish re-stage. Checked BEFORE the store,
    // because it is the one case where the upper layer holds output no store hit
    // would reproduce (a build artifact outside any declared dep dir).
    //
    // docs/266 reqs 5, 6 — `--force` skips it, and skips the store hit below.
    // Both are correct for an ordinary activation and both would make a forced
    // re-install a no-op that reports success, which is the exact failure the
    // retry exists to break out of: a consumer whose live version is unusable
    // has no way to tell a defect from a bad install, and "run it again" must
    // therefore actually run it again.
    const recorded = job.force ? null : readStamp(stampPath);
    if (recorded?.stamp === stamp && pinsResolve(deps.depStoreDir, recorded.basePins)) {
      console.log(`[plugins] ${job.repoName}: install already done for ${job.commit.slice(0, 9)}`);
      record("skipped-stamp", "this version's writable layer was already installed for these inputs");
      return { ok: true, ...(recorded.basePins.length > 0 ? { basePins: recorded.basePins } : {}) };
    }

    // req 28 — the shared dependency store. A hit means this repository's own
    // install, at this exact dep state, under this runtime, already produced a
    // tree some other session (or an earlier commit of this one) put in the
    // store: mount it and run nothing. That — not a faster install — is what
    // stops a plugin on a busy tracked branch from paying a cold cost per
    // commit, because `npm ci` deletes `node_modules` before it starts and would
    // ignore a warm base anyway.
    const plan = deps.depStoreDir
      ? planPluginDepStore({ source: job.source, exports: job.exports, checkoutDir: job.stagingDir })
      : null;
    if (plan && deps.depStoreDir && !job.force) {
      const pins = adoptPluginDepBases(deps.depStoreDir, plan);
      if (pins) {
        // The layer is cleared for the same reason install clears it: nothing
        // above the base may be left over from an attempt that failed, and no
        // successful attempt for this commit can be here (the stamp check above
        // is what that would have matched).
        await prepareLayer(layerDirs, stampPath);
        await writeStamp(stampPath, stamp, pins);
        console.log(
          `[plugins] ${job.repoName}: ${job.commit.slice(0, 9)} reuses shared dependencies — install skipped`,
        );
        record(
          "skipped-store",
          "these dependency inputs were already in the shared store, so no install command ran; "
          + "anything the install would ALSO have built is not in that store",
        );
        return { ok: true, basePins: pins };
      }
    }

    let spec;
    try {
      // Before anything else, and fail-closed: an install container ShipIt
      // cannot deny at its own API is not one to start.
      await ensureUntrustedPluginNetwork(deps.docker, PLUGIN_INSTALL_NETWORK);
      const roots = await resolvePluginOverlayRoots(deps.docker, deps.workspaceVolume, deps.stateRoot);
      spec = buildPluginOverlaySpec({
        sessionId: deps.sessionId,
        repoName: job.repoName,
        commit: job.commit,
        stateDir: deps.stateDir,
        checkoutDir: job.stagingDir,
        ...roots,
      });
      await prepareLayer(spec.orchDirs, stampPath);
      // The install runs as the worker uid, and overlayfs takes the merged
      // directory's permissions from the LOWER dir — a root-owned checkout
      // would leave the plugin root unwritable and every install would fail at
      // its first file. This is also the ownership handoff for a generation
      // staged after the session container booted, which the entrypoint's
      // boot-time chown cannot cover. No-op when the non-root runtime is off.
      chownTreeToSessionWorker(job.stagingDir);
      await createPluginOverlay(deps.docker, spec);
    } catch (err) {
      const reason = `could not prepare the plugin's writable layer: ${message(err)}`;
      record("failed", reason);
      return { ok: false, reason };
    }

    // req 24 — resolved ONCE, outside the try, and reused by both the namespace
    // and the failure message: a policy read twice could report blocked hosts
    // against a different allowlist from the one the namespace was built with.
    const policy = deps.egress?.() ?? UNCONTAINED_PLUGIN_EGRESS;
    let outcome: { ok: boolean; reason?: string };
    let netns: PluginNetns | null = null;
    try {
      // req 24 — the same egress the session's own code gets, and fail-closed
      // for the same reason the network above is. ONE namespace for the whole
      // run: a generation's install commands are one logical install, and each
      // namespace costs a holder plus its sidecars.
      netns = await preparePluginNetns({
        docker: deps.docker,
        sessionId: deps.sessionId,
        network: PLUGIN_INSTALL_NETWORK,
        holderImage: deps.image,
        policy,
      });
      outcome = { ok: true };
      for (const { plugin, command } of commands) {
        // Between commands as well as before the first: disposal during a long
        // install must not start the next one.
        if (job.isCancelled?.()) {
          outcome = { ok: false, reason: "the session went away during install" };
          break;
        }
        const failure = await runInstallContainer(
          deps, job, spec.volumeName, command, netns.networkMode,
        );
        if (failure) {
          outcome = {
            ok: false,
            reason: `install for \`${plugin}\` ${failure}${blockedHostsClause(policy, job)}`,
          };
          break;
        }
      }
    } catch (err) {
      outcome = { ok: false, reason: `install could not run: ${message(err)}` };
    } finally {
      // The holder owns the namespace every install container ran in, so it has
      // to outlive them and then go — on the failure paths too.
      await netns?.release();
    }

    // The volume MUST go, and whether it went is part of the result. The
    // runtime volume for this generation is created over the same upper layer
    // with the PUBLISHED lowerdir, and the kernel forbids two mounts over one
    // upperdir — so publishing a generation whose install volume is still held
    // would produce a generation reported active whose runtime mount cannot be
    // built. A release failure is therefore an install failure, not a warning.
    const released = await removePluginOverlay(deps.docker, spec.volumeName);
    if (!released) {
      const reason = `the plugin's writable layer could not be released (volume ${spec.volumeName} is still held)`;
      record("failed", reason);
      return { ok: false, reason };
    }
    if (!outcome.ok) {
      record("failed", outcome.reason);
      return outcome;
    }

    // req 28 — hand what was just installed to the store, so the next commit,
    // and every other session, mounts it instead of installing it again. Runs
    // AFTER the volume is released: the tree leaves the upper layer here, and it
    // must not move under a mount. A directory that cannot be promoted stays
    // where install left it and pins nothing — still a complete generation.
    if (!plan || !deps.depStoreDir) {
      await writeStamp(stampPath, stamp, []);
      record("succeeded");
      return { ok: true };
    }

    const promoted = await promotePluginDepDirs({
      depStoreDir: deps.depStoreDir,
      plan,
      commit: job.commit,
      upperDir: spec.orchDirs.upperdir,
      repoName: job.repoName,
    });
    const basePins = promoted.map((p) => p.pin).filter((pin): pin is string => pin !== null);

    // **Every declared directory must be in one place or the other** (review
    // finding). Promotion is meant to be an optimization whose failure leaves
    // the generation self-contained, and for every failure BEFORE the rename it
    // is. After the rename it is not: the tree is in the store and gone from the
    // upper layer, so a `publishBase` that then fails to write its pointer — a
    // full disk is enough — leaves the directory in neither, and publishing that
    // generation would give the plugin no dependencies at all with nothing
    // saying why. Checked rather than reasoned about, because the reasoning is
    // what was wrong: an install whose output cannot be accounted for is a
    // failed install, which degrades to the prior version (req 15).
    const lost = promoted.filter((p) => p.lost).map((p) => p.depDir);
    if (lost.length > 0) {
      const reason = `the installed \`${lost.join("`, `")}\` could not be stored — install ran but its output was lost`;
      record("failed", reason);
      return { ok: false, reason };
    }

    await writeStamp(stampPath, stamp, basePins);
    record("succeeded");
    return { ok: true, ...(basePins.length > 0 ? { basePins } : {}) };
}

/**
 * The clause that turns a package-manager DNS error into the guided onboarding
 * step req 24 asks for.
 *
 * A plugin's FIRST activation has no live generation, so the Plugins card cannot
 * show its declared hosts or the "Allow" buttons — the card resolves them from
 * live generations only (`plugin-hosts.ts`). Containing `install` made that
 * reachable: an install pulling from a vendor host now fails where it used to
 * succeed, and the failure the user sees is whatever `npm` printed. This appends
 * the declared hosts the session does not currently permit, so the reason on the
 * degraded card names them and says where to grant them.
 *
 * Empty when nothing is denied, when the plugin declared nothing, or when every
 * declared host is already allowed — in which case the install failed for some
 * other reason and saying "egress" would be a wrong guess.
 */
function blockedHostsClause(policy: PluginEgressPolicy, job: PluginInstallJob): string {
  const declared = job.exports.flatMap((e) => e.hosts ?? []);
  const blocked = unreachableDeclaredHosts(policy, declared);
  if (blocked.length === 0) return "";
  return `\n\nThis plugin declares ${blocked.map((h) => `\`${h}\``).join(", ")}, which `
    + `${blocked.length === 1 ? "is" : "are"} not in this session's egress allowlist. `
    + "Allow it in the Plugins tab (or Settings → Network egress) and refresh the plugin.";
}

/**
 * Give the generation a clean writable layer: overlayfs refuses a missing
 * upperdir and a non-empty workdir, and a half-populated upper from an install
 * that failed earlier would otherwise be merged in as if it had succeeded.
 * The stamp is dropped first, so a crash between here and the install leaves
 * nothing claiming the layer is current.
 */
async function prepareLayer(
  orchDirs: { upperdir: string; workdir: string },
  stampPath: string,
): Promise<void> {
  await fsp.rm(stampPath, { force: true });
  await fsp.rm(orchDirs.upperdir, { recursive: true, force: true });
  await fsp.rm(orchDirs.workdir, { recursive: true, force: true });
  await fsp.mkdir(orchDirs.upperdir, { recursive: true });
  await fsp.mkdir(orchDirs.workdir, { recursive: true });
  // The install container runs unprivileged; the orchestrator is root.
  chownToSessionWorker(path.dirname(orchDirs.upperdir));
  chownToSessionWorker(orchDirs.upperdir);
  chownToSessionWorker(orchDirs.workdir);
}

/**
 * The stamp file, which records BOTH what was installed and where its shared
 * dependency bases ended up (req 28).
 *
 * The pins have to travel with the stamp: a stamp hit skips the install, and a
 * generation that skips its install still has to be told which bases to mount —
 * the answer is not derivable from anything else once the tree has left the
 * upper layer. Fail-closed on anything unexpected, including the pre-req-28
 * plain-string format: an unreadable stamp only ever costs a reinstall.
 */
function readStamp(stampPath: string): { stamp: string; basePins: string[] } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stampPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { stamp, basePins } = parsed as Record<string, unknown>;
    if (typeof stamp !== "string") return null;
    if (basePins !== undefined && (!Array.isArray(basePins) || basePins.some((p) => typeof p !== "string"))) {
      return null;
    }
    return { stamp, basePins: (basePins as string[] | undefined) ?? [] };
  } catch {
    return null;
  }
}

async function writeStamp(stampPath: string, stamp: string, basePins: string[]): Promise<void> {
  await fsp.writeFile(stampPath, JSON.stringify({ stamp, basePins })).catch(() => undefined);
}

/**
 * Whether every pin a stamp recorded still names a base that exists. A base a
 * sweep removed makes the stamp a lie — the generation would mount a lowerdir
 * that is gone — so the stamp stops matching and the install runs again.
 */
function pinsResolve(depStoreDir: string | undefined, pins: readonly string[]): boolean {
  if (pins.length === 0) return true;
  if (!depStoreDir) return false;
  return pins.every((pin) => {
    const dir = pluginBasePinDir(depStoreDir, pin);
    return dir !== null && fs.existsSync(dir);
  });
}

/**
 * Run one install command to completion. Returns a failure clause on a
 * non-zero exit or a timeout, and `null` on success.
 */
async function runInstallContainer(
  deps: PluginInstallDeps,
  job: PluginInstallJob,
  volumeName: string,
  command: string,
  networkMode: string,
): Promise<string | null> {
  // docs/268 — a plugin container writes THIS session's workspace and overlay,
  // so it runs as this session's identity rather than the one global uid. A
  // session that predates per-session identities resolves to that global value,
  // so its plugin containers are unchanged.
  const identity = identityForSession(deps.sessionId);
  const depCache = resolveDepCacheMount(deps, job);
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_INSTALL_LABEL]: deps.sessionId },
    // Bypass the session-worker entrypoint: it prepares a session's mounts and
    // drops privileges for the worker, none of which applies to this container.
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [command],
    WorkingDir: PLUGIN_INSTALL_DIR,
    ...(identity !== null ? { User: `${identity.uid}:${identity.gid}` } : {}),
    // The generation's env and nothing else. Notably absent: everything in this
    // process's environment, the worker URL, and any credential.
    Env: [
      `${PLUGIN_COMMIT_ENV}=${job.commit}`,
      "HOME=/tmp",
      "npm_config_update_notifier=false",
      // req 28 — point the package managers at this plugin repository's own
      // download cache, the same names and the same layout every session
      // container uses (`container-lifecycle.ts`). Set only when the cache is
      // actually mounted, so a container without it cannot write a cache into
      // its own throwaway layer under a path that suggests otherwise.
      ...(depCache
        ? [
          `npm_config_cache=${DEP_CACHE_CONTAINER_PATH}/npm`,
          `YARN_CACHE_FOLDER=${DEP_CACHE_CONTAINER_PATH}/yarn`,
          `PNPM_STORE_DIR=${DEP_CACHE_CONTAINER_PATH}/pnpm`,
        ]
        : []),
    ],
    HostConfig: {
      // `/plugin` is the merged view: pristine checkout below, this generation's
      // writable layer above.
      Binds: [`${volumeName}:${PLUGIN_INSTALL_DIR}`],
      // req 28 — and the repository's download cache, so a dep-state change
      // installs from disk instead of re-downloading what an earlier commit
      // already fetched. It holds package tarballs and nothing else: no
      // credential is reachable through it, and it is keyed by the plugin
      // repository, so one repository's cached content can never appear under
      // another's name (reqs 15, 19).
      ...(depCache ? { Mounts: [depCache] as unknown as Docker.MountSettings[] } : {}),
      // Its own network (see PLUGIN_INSTALL_NETWORK): never a session's, and
      // never the default bridge, whose addresses ShipIt's own API guard reads
      // as a trusted host caller. On a contained session this is instead the
      // namespace of a holder ON that network, already carrying the session's
      // own egress policy (req 24, `plugin-egress.ts`) — still never a session
      // container's namespace, which is what req 19 forbids.
      NetworkMode: networkMode,
      AutoRemove: false, // removed below, after the exit code is read
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: INSTALL_MEMORY_BYTES,
      PidsLimit: INSTALL_PIDS_LIMIT,
      // A writable /tmp so package managers have a scratch dir and a HOME
      // without writing either into the plugin's layer.
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m" },
    },
  });

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_INSTALL_TIMEOUT_MS;
  try {
    await container.start();
    const code = await waitForContainerExit(container, timeoutMs, job.isCancelled);
    if (code === "timeout") return `did not finish within ${Math.round(timeoutMs / 1000)}s`;
    if (code === "cancelled") return "was stopped because the session went away";
    if (code !== 0) return `exited ${code}${await logTail(container)}`;
    return null;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/**
 * The plugin repository's own download cache, as a mount — req 28's "does not
 * re-download what an earlier commit already fetched".
 *
 * **A volume+Subpath mount, never a plain bind, wherever the state root lives in
 * a named volume.** The orchestrator sees the cache under its own
 * `/workspace/...`; in production that tree is inside a volume the daemon knows
 * nothing about, so a bind of that path would silently produce a fresh empty
 * root-owned directory — the failure would be invisible (an install that works,
 * slowly) and production-only. `sessionPathMount` is the established
 * translation, shared with the companion-CLI surface.
 *
 * **Absent rather than fatal on any failure**, which is the opposite of what
 * that surface does with the same helper, and deliberately: there, a mount that
 * silently resolves to an empty directory means `/project` is not the project.
 * Here the worst case is a cold download, so an install must never fail over it.
 */
function resolveDepCacheMount(deps: PluginInstallDeps, job: PluginInstallJob): MountSpec | null {
  if (!deps.depStoreDir) return null;
  try {
    const dir = pluginDepCacheDir(deps.depStoreDir, job.source);
    fs.mkdirSync(dir, { recursive: true });
    // The install runs as the worker uid; a root-created cache dir would be
    // unwritable, and npm treats an unwritable cache as a hard error.
    chownToSessionWorker(dir);
    return sessionPathMount(deps, dir, DEP_CACHE_CONTAINER_PATH, false);
  } catch (err) {
    console.warn(
      `[plugins] ${job.repoName}: no shared download cache for this install:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * The tail of a failed install's output, so the degraded card says what went
 * wrong instead of only that something did. Best-effort and bounded — this
 * text is repo-authored and ends up in the UI.
 */
async function logTail(container: Docker.Container): Promise<string> {
  try {
    const raw = await container.logs({ stdout: true, stderr: true, tail: LOG_TAIL_LINES });
    const text = demultiplex(raw).trim();
    if (!text) return "";
    const clipped = text.length > REASON_MAX_CHARS ? `…${text.slice(-REASON_MAX_CHARS)}` : text;
    return `:\n${clipped}`;
  } catch {
    return "";
  }
}

/**
 * Boot-only crash recovery: remove every plugin container this orchestrator's
 * predecessor left behind — `install` containers, **companion-CLI invocation
 * containers** (`plugin-cli-run.ts`), and the **netns holders and egress
 * sidecars** that contain either (`plugin-egress.ts`) — **and every plugin
 * generation volume**.
 *
 * Each of those containers is awaited inside one call, in this process, so
 * none can outlive the process that started it — at boot, every such artifact
 * is an orphan by definition, whatever state it is in. That makes the test
 * liveness-free, unlike the session sweeps that cross-reference the DB.
 *
 * **The volumes have to go with the containers, and no other sweep will do
 * it.** The disk janitor's orphan-volume pass filters on `dangling=true`, so a
 * volume an orphaned container still holds is invisible to it; and on the next
 * boot, when it IS dangling, the same pass deliberately preserves every volume
 * whose session prefix belongs to a live session. A crashed install's volume
 * therefore survived every existing sweep. Removing it here is safe precisely
 * because it is cheap to rebuild: the volume is a mount description over
 * directories that outlive it, so the next activation re-creates it.
 *
 * Ordering matters: this must run BEFORE the janitor's volume pass, or the
 * volume is still attached when that pass looks.
 *
 * Never throws. Returns the number of artifacts removed.
 */
export async function reapOrphanPluginInstalls(
  docker: Docker,
  opts: { paceMs?: number } = {},
): Promise<number> {
  let removed = 0;
  const pace = async (): Promise<void> => {
    if (opts.paceMs) await sleep(opts.paceMs);
  };

  // Every kind of plugin container: `install`, a companion-CLI invocation, and
  // the netns holders + egress sidecars that contain them (req 24,
  // `plugin-egress.ts`). None can outlive the process that started it — each is
  // awaited inside one call and released in a `finally` — so at boot anything
  // still labelled is an orphan by definition, whatever state it is in. The
  // holders matter more than the workloads here, not less: they are the only
  // ones with a `RestartPolicy` sidecar attached, and a leaked holder keeps a
  // resolver and an SNI proxy running for nothing.
  for (const label of [PLUGIN_INSTALL_LABEL, PLUGIN_CLI_LABEL, PLUGIN_NETNS_LABEL]) {
    try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [label] },
    });
    for (const { Id } of containers) {
      try {
        await docker.getContainer(Id).remove({ force: true });
        removed++;
      } catch {
        // Already gone, or being removed by something else — either is fine.
      }
      await pace();
    }
  } catch (err) {
    // Docker unavailable — this is a backstop, so the orphans wait for the
    // next boot. Fall through: the volume pass fails the same way if so.
    console.warn(`[plugins] could not list ${label} containers:`, message(err));
    }
  }

  try {
    const volumes = await docker.listVolumes({ filters: { label: [PLUGIN_OVERLAY_LABEL] } });
    for (const { Name } of volumes.Volumes ?? []) {
      if (await removePluginOverlay(docker, Name)) removed++;
      await pace();
    }
  } catch (err) {
    console.warn("[plugins] could not list generation volumes:", message(err));
  }

  if (removed > 0) console.log(`[plugins] removed ${removed} orphan install artifact(s)`);
  return removed;
}

/**
 * Strip Docker's stream framing from a log buffer.
 *
 * A container without a TTY — this one — has its output multiplexed: every
 * chunk carries an 8-byte header (stream id, three zero bytes, then a 32-bit
 * big-endian length). Reading the buffer as text puts that framing in the
 * middle of the message, and this text is what the degraded card shows the
 * user. Anything that does not parse as a frame is returned verbatim, so a TTY
 * container or an already-decoded buffer is passed through unharmed.
 */
function demultiplex(raw: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const stream = raw[offset];
    // Header shape: a valid frame's stream id is 0/1/2 and bytes 1..3 are zero.
    if (stream > 2 || raw[offset + 1] !== 0 || raw[offset + 2] !== 0 || raw[offset + 3] !== 0) {
      return raw.toString("utf-8");
    }
    const size = raw.readUInt32BE(offset + 4);
    if (offset + 8 + size > raw.length) return raw.toString("utf-8");
    parts.push(raw.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  if (offset !== raw.length) return raw.toString("utf-8");
  return Buffer.concat(parts).toString("utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
