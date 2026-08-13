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
import type { PluginExport } from "../shared/plugin-repos.js";
import type { PluginInstallJob } from "./plugin-generations.js";
import {
  buildPluginOverlaySpec,
  createPluginOverlay,
  pluginWorkDir,
  removePluginOverlay,
  resolvePluginOverlayRoots,
  PLUGIN_OVERLAY_LABEL,
} from "./plugin-overlay.js";
import { chownToSessionWorker, chownTreeToSessionWorker, sessionWorkerUid } from "./session-worker-uid.js";
import { registerUntrustedContainerNetwork } from "./api-container-guard.js";

/** Where the merged checkout is mounted inside the install container. */
export const PLUGIN_INSTALL_DIR = "/plugin";

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
/** How often the wait loop notices a timeout or a disposed session. */
const CANCELLATION_POLL_MS = 2_000;
/** How long to wait for a killed container to actually be gone. */
const REAP_GRACE_MS = 10_000;

export interface PluginInstallDeps {
  docker: Docker;
  /** Image to run install in — the session-worker image, for its toolchain. */
  image: string;
  sessionId: string;
  /** The session's state dir, the same one activation stages generations into. */
  stateDir: string;
  /**
   * Name of the workspace volume, and the orchestrator-visible root that maps
   * onto it. Both omitted in dev/dogfood, where the state dir is a bind mount
   * and the daemon sees the same paths this process does.
   */
  workspaceVolume?: string;
  stateRoot?: string;
  timeoutMs?: number;
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
): (job: PluginInstallJob) => Promise<{ ok: boolean; reason?: string }> {
  return async (job) => {
    const commands = installCommands(job.exports);
    if (commands.length === 0) return { ok: true };

    const stampPath = installStampPath(deps.stateDir, job.repoName, job.commit);
    const stamp = installStamp(job);
    if (readStamp(stampPath) === stamp) {
      console.log(`[plugins] ${job.repoName}: install already done for ${job.commit.slice(0, 9)}`);
      return { ok: true };
    }

    let spec;
    try {
      // Before anything else, and fail-closed: an install container ShipIt
      // cannot deny at its own API is not one to start.
      await ensureInstallNetwork(deps.docker);
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
      return { ok: false, reason: `could not prepare the plugin's writable layer: ${message(err)}` };
    }

    let outcome: { ok: boolean; reason?: string };
    try {
      outcome = { ok: true };
      for (const { plugin, command } of commands) {
        // Between commands as well as before the first: disposal during a long
        // install must not start the next one.
        if (job.isCancelled?.()) {
          outcome = { ok: false, reason: "the session went away during install" };
          break;
        }
        const failure = await runInstallContainer(deps, job, spec.volumeName, command);
        if (failure) {
          outcome = { ok: false, reason: `install for \`${plugin}\` ${failure}` };
          break;
        }
      }
    } catch (err) {
      outcome = { ok: false, reason: `install could not run: ${message(err)}` };
    }

    // The volume MUST go, and whether it went is part of the result. The
    // runtime volume for this generation is created over the same upper layer
    // with the PUBLISHED lowerdir, and the kernel forbids two mounts over one
    // upperdir — so publishing a generation whose install volume is still held
    // would produce a generation reported active whose runtime mount cannot be
    // built. A release failure is therefore an install failure, not a warning.
    const released = await removePluginOverlay(deps.docker, spec.volumeName);
    if (!released) {
      return {
        ok: false,
        reason: `the plugin's writable layer could not be released (volume ${spec.volumeName} is still held)`,
      };
    }
    if (outcome.ok) await fsp.writeFile(stampPath, stamp).catch(() => undefined);
    return outcome;
  };
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

function readStamp(stampPath: string): string | null {
  try {
    return fs.readFileSync(stampPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Create the install network if it does not exist, and declare its subnet
 * untrusted to the orchestrator's API guard.
 *
 * **Fails closed.** If the network cannot be created, or it has no IPv4 subnet
 * to register (the guard's CIDR match is IPv4-only), no install runs — a
 * container that ShipIt cannot deny at the API is not one to start.
 *
 * Idempotent and cheap to repeat: an existing network is inspected rather than
 * recreated, and registration is a set insert.
 */
async function ensureInstallNetwork(docker: Docker): Promise<void> {
  let info: { IPAM?: { Config?: { Subnet?: string }[] } };
  try {
    info = await docker.getNetwork(PLUGIN_INSTALL_NETWORK).inspect();
  } catch {
    try {
      await docker.createNetwork({ Name: PLUGIN_INSTALL_NETWORK, Driver: "bridge" });
    } catch (err) {
      // A concurrent create is fine — the inspect below settles it either way.
      if (errStatus(err) !== 409) throw err;
    }
    info = await docker.getNetwork(PLUGIN_INSTALL_NETWORK).inspect();
  }

  const subnets = (info.IPAM?.Config ?? [])
    .map((c) => c.Subnet)
    .filter((s): s is string => Boolean(s));
  const registered = subnets.filter((s) => registerUntrustedContainerNetwork(s));
  if (registered.length === 0) {
    throw new Error(
      `network ${PLUGIN_INSTALL_NETWORK} has no IPv4 subnet to deny `
      + `(saw ${subnets.length > 0 ? subnets.join(", ") : "none"})`,
    );
  }
}

function errStatus(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err
    ? (err as { statusCode: number }).statusCode
    : 0;
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
): Promise<string | null> {
  const uid = sessionWorkerUid();
  const container = await deps.docker.createContainer({
    Image: deps.image,
    Labels: { [PLUGIN_INSTALL_LABEL]: deps.sessionId },
    // Bypass the session-worker entrypoint: it prepares a session's mounts and
    // drops privileges for the worker, none of which applies to this container.
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [command],
    WorkingDir: PLUGIN_INSTALL_DIR,
    ...(uid !== null ? { User: `${uid}:${uid}` } : {}),
    // The generation's env and nothing else. Notably absent: everything in this
    // process's environment, the worker URL, and any credential.
    Env: [
      `SHIPIT_PLUGIN_COMMIT=${job.commit}`,
      "HOME=/tmp",
      "npm_config_update_notifier=false",
    ],
    HostConfig: {
      // The one mount. `/plugin` is the merged view: pristine checkout below,
      // this generation's writable layer above.
      Binds: [`${volumeName}:${PLUGIN_INSTALL_DIR}`],
      // Its own network (see PLUGIN_INSTALL_NETWORK): never a session's, and
      // never the default bridge, whose addresses ShipIt's own API guard reads
      // as a trusted host caller.
      NetworkMode: PLUGIN_INSTALL_NETWORK,
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
    const code = await waitForExit(container, timeoutMs, job.isCancelled);
    if (code === "timeout") return `did not finish within ${Math.round(timeoutMs / 1000)}s`;
    if (code === "cancelled") return "was stopped because the session went away";
    if (code !== 0) return `exited ${code}${await logTail(container)}`;
    return null;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** Sentinel for "the poll slice elapsed" — an exit result is always an object. */
const TICK = "tick" as const;

/**
 * Wait for the container, stopping it when it outstays the timeout or when its
 * session goes away.
 *
 * **The post-kill wait is bounded too.** The obvious shape — kill, then await
 * the same `wait()` promise — assumes the kill worked. A kill that fails (a
 * daemon hiccup, a container in a state Docker will not signal) leaves that
 * promise unresolved forever, and a nominal ten-minute timeout becomes an
 * unbounded hang holding the repository's activation queue and the generation's
 * volume. So the reap has its own deadline, and the caller treats "stopped, we
 * think" as a failure either way.
 */
async function waitForExit(
  container: Docker.Container,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<number | "timeout" | "cancelled"> {
  const wait = container.wait() as Promise<{ StatusCode?: number }>;
  // Attached immediately: `wait` is raced below, so an early rejection with
  // nothing listening would surface as an unhandled rejection.
  const settled = wait.catch(() => ({ StatusCode: -1 }));

  const started = Date.now();
  let stopReason: "timeout" | "cancelled" | null = null;
  while (stopReason === null) {
    const slice = Math.min(CANCELLATION_POLL_MS, Math.max(0, timeoutMs - (Date.now() - started)));
    const outcome = await Promise.race([settled, tickAfter(slice)]);
    if (outcome !== TICK) return outcome.StatusCode ?? -1;
    if (isCancelled?.()) stopReason = "cancelled";
    else if (Date.now() - started >= timeoutMs) stopReason = "timeout";
  }

  // Kill, then reap — but never wait on the kill having worked.
  await container.kill().catch(() => undefined);
  await Promise.race([settled, sleep(REAP_GRACE_MS)]);
  return stopReason;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `sleep`, resolving to the poll sentinel so it can be raced against an exit. */
async function tickAfter(ms: number): Promise<typeof TICK> {
  await sleep(ms);
  return TICK;
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
 * Boot-only crash recovery: remove every install container this orchestrator's
 * predecessor left behind, **and every plugin generation volume**.
 *
 * An install is awaited inside one activation, in this process, so it cannot
 * outlive the process that started it — at boot, either artifact is an orphan
 * by definition, whatever state it is in. That makes the test liveness-free,
 * unlike the session sweeps that cross-reference the DB.
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

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [PLUGIN_INSTALL_LABEL] },
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
    console.warn("[plugins] could not list install containers:", message(err));
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
