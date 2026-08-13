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
} from "./plugin-overlay.js";
import { chownToSessionWorker, chownTreeToSessionWorker, sessionWorkerUid } from "./session-worker-uid.js";

/** Where the merged checkout is mounted inside the install container. */
export const PLUGIN_INSTALL_DIR = "/plugin";

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

    try {
      for (const { plugin, command } of commands) {
        const failure = await runInstallContainer(deps, job, spec.volumeName, command);
        if (failure) return { ok: false, reason: `install for \`${plugin}\` ${failure}` };
      }
      await fsp.writeFile(stampPath, stamp).catch(() => undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `install could not run: ${message(err)}` };
    } finally {
      // Always: the runtime volume for this generation is created over the same
      // upper layer with the PUBLISHED lowerdir, and two live mounts cannot
      // share an upperdir. Removing the volume keeps the layer.
      await removePluginOverlay(deps.docker, spec.volumeName);
    }
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
      // The default bridge, never the session's network — a plugin's install
      // has no business reaching the session's services or its worker.
      NetworkMode: "bridge",
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
    const code = await waitWithTimeout(container, timeoutMs);
    if (code === "timeout") return `did not finish within ${Math.round(timeoutMs / 1000)}s`;
    if (code !== 0) return `exited ${code}${await logTail(container)}`;
    return null;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/**
 * Wait for the container, killing it if it outstays the timeout. The kill is
 * what resolves the underlying `wait()`, so the container is always reaped —
 * abandoning the promise would leave it running with the volume attached, and
 * the volume could then not be removed.
 */
async function waitWithTimeout(
  container: Docker.Container,
  timeoutMs: number,
): Promise<number | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const wait = container.wait() as Promise<{ StatusCode?: number }>;
  // Swallowed here, not at the await: `wait` is raced, so an early rejection
  // with nothing attached would surface as an unhandled rejection.
  const settled = wait.catch(() => ({ StatusCode: -1 }));
  try {
    const outcome = await Promise.race([
      settled,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (outcome !== "timeout") return outcome.StatusCode ?? -1;
    // Kill, then reap: the kill is what resolves `wait`, and leaving the
    // container running would hold the volume open so it could not be removed.
    await container.kill().catch(() => undefined);
    await settled;
    return "timeout";
  } finally {
    if (timer) clearTimeout(timer);
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
 * Boot-only crash recovery: remove every install container this orchestrator's
 * predecessor left behind.
 *
 * An install is awaited inside one activation, in this process, so it cannot
 * outlive the process that started it — at boot, a container carrying the label
 * is an orphan by definition, whatever state it is in. That makes the test
 * liveness-free, unlike the session sweeps that cross-reference the DB.
 *
 * Worth reaping rather than leaving to `docker system prune`: a surviving
 * install container still holds its generation's overlay volume, and a held
 * volume cannot be removed — so the generation's writable layer is stuck with
 * it, and the next activation of that commit cannot re-create the mount.
 *
 * Never throws. Returns the number removed.
 */
export async function reapOrphanPluginInstalls(
  docker: Docker,
  opts: { paceMs?: number } = {},
): Promise<number> {
  let containers: { Id: string }[];
  try {
    containers = await docker.listContainers({
      all: true,
      filters: { label: [PLUGIN_INSTALL_LABEL] },
    });
  } catch (err) {
    // Docker unavailable — this is a backstop, so the orphans simply wait for
    // the next boot.
    console.warn("[plugins] could not list install containers:", message(err));
    return 0;
  }
  let removed = 0;
  for (const { Id } of containers) {
    try {
      await docker.getContainer(Id).remove({ force: true });
      removed++;
    } catch {
      // Already gone, or being removed by something else — either is fine.
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  if (removed > 0) console.log(`[plugins] removed ${removed} orphan install container(s)`);
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
