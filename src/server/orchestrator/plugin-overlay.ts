/**
 * docs/262 — the copy-on-write layer a plugin's own code runs against.
 *
 * Requirement 7 puts dependency installation and build output somewhere that is
 * "neither plugin source nor project data", so the generation checkout stays
 * pristine and everything `install` writes lands in an upper layer beside it:
 *
 *   <state>/plugins/<repo>/generations/<sha>/     the checkout — never written
 *   <state>/plugins/<repo>/work/<sha>/upper/      install output lives here
 *   <state>/plugins/<repo>/work/<sha>/work/       overlayfs scratch (must be empty)
 *
 * The merged view of those two exists ONLY inside a container that attaches the
 * volume. It cannot be produced on the host: a host-side `mount -t overlay`
 * needs CAP_SYS_ADMIN, which the orchestrator does not have, and docs/183
 * rejected the privileged variant. `createOverlayVolume` instead asks the
 * DAEMON to do the mount when a container attaches the named volume — which is
 * also why one volume can be shared coherently by the installer, the services,
 * and (later) the CLI-invocation containers.
 *
 * **The paths in a spec are DAEMON-HOST paths, not orchestrator paths.** The
 * orchestrator sees a generation under its own `/workspace/...`; in production
 * that is inside a Docker volume, and the daemon knows nothing about it. Same
 * translation docs/183 does: `resolveVolumeMountpoint()` gives the volume's
 * daemon-host root, and each path is that root plus the tail after the
 * orchestrator's own state root. Getting this wrong fails quietly — the volume
 * is created happily and the mount comes up empty, far from the cause. In dev /
 * dogfood there is no volume and both sides see the same path, so the
 * translation is the identity.
 *
 * **One volume per generation, and only one live at a time over an upper
 * layer.** Driver options are fixed once consumers hold a volume, and the
 * kernel forbids one upperdir backing two independently created overlay
 * mounts. That matters here because install runs BEFORE publish, against the
 * staging directory, which is then renamed: the install volume (lowerdir =
 * staging) is therefore removed before the runtime volume (lowerdir = the
 * published generation) is created over the SAME upper layer. The upper layer
 * survives the swap — it is an ordinary directory — so install output outlives
 * the rename that made it reachable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { chownToSessionWorker } from "./session-worker-uid.js";
import {
  createOverlayVolume,
  removeOverlayVolume,
  resolveVolumeMountpoint,
  volumeExists,
  type OverlaySpec,
} from "./overlay-volume.js";
import { pluginsRoot, WORK_SUBDIR } from "./plugin-generations.js";

/** Marks a volume as belonging to one plugin generation, for orphan cleanup. */
export const PLUGIN_OVERLAY_LABEL = "shipit-plugin-generation";

export interface PluginOverlaySpec extends OverlaySpec {
  /**
   * The lower/upper/work dirs as the ORCHESTRATOR sees them. It must create
   * upper and work itself before the daemon mounts the overlay — overlayfs
   * refuses a missing upperdir, and a non-empty workdir.
   */
  orchDirs: { lowerdir: string; upperdir: string; workdir: string };
}

/**
 * Name a generation's volume. Keyed by session AND commit: per generation,
 * never per repository, because a volume's driver options cannot change while
 * consumers hold it.
 *
 * **The 12-character session prefix is load-bearing, not cosmetic.** The disk
 * janitor's orphan sweep matches `^shipit-([a-f0-9-]{12})_` and compares the
 * captured prefix against `sessionId.slice(0, 12)` for every live session
 * (`sweepOrphanSessionVolumes`, startup-janitor.ts). A shorter prefix does not
 * match the pattern at all, so a crash-orphaned volume would never be
 * reclaimed — it would simply accumulate.
 */
export function pluginOverlayVolumeName(sessionId: string, repoName: string, commit: string): string {
  return `shipit-${sessionId.slice(0, 12)}_plugin-${safeSegment(repoName)}-${nameHash(repoName)}-${commit.slice(0, 12)}`;
}

/**
 * A volume-name-safe rendering of a declared repo name, for READING — the hash
 * beside it is what makes the name unique.
 *
 * The rendering is lossy: `foo.bar` and `foo-bar` are both legal declarations
 * (`plugin-repos.ts`) and both render to `foo-bar`. Two such repositories in
 * one session that resolve to commits sharing a 12-character prefix — forks of
 * one history, which is the ordinary case for a fork — would then have received
 * the SAME volume name over different lower and upper dirs, so activating one
 * would delete or corrupt the other's. Req 14 says repositories fail
 * independently; sharing a name is the opposite of independent.
 */
function safeSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** Disambiguates names the segment rendering flattens together. */
function nameHash(name: string): string {
  return crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
}

/** Where a generation's writable layer lives, as the orchestrator sees it. */
export function pluginWorkDir(stateDir: string, repoName: string, commit: string): string {
  return path.join(pluginsRoot(stateDir), repoName, WORK_SUBDIR, commit);
}

/**
 * Compose the spec for one generation's overlay.
 *
 * `checkoutDir` is the lowerdir and is passed in rather than derived, because
 * during install it is the STAGING directory and after publish it is the
 * generation directory — two different paths over the same upper layer, which
 * is exactly why this takes it as an argument.
 *
 * Pure: no Docker, no filesystem. `volumeMountpoint`/`stateRoot` translate to
 * daemon-host paths; omit both in dev, where the two views coincide.
 */
export function buildPluginOverlaySpec(args: {
  sessionId: string;
  repoName: string;
  commit: string;
  stateDir: string;
  /** Lowerdir as the orchestrator sees it — staging during install, the generation after. */
  checkoutDir: string;
  /** Daemon-host mountpoint of the state volume. Omit in dev (no volume). */
  volumeMountpoint?: string;
  /** Orchestrator-visible root of that same volume. Omit in dev. */
  stateRoot?: string;
}): PluginOverlaySpec {
  const work = pluginWorkDir(args.stateDir, args.repoName, args.commit);
  const orchDirs = {
    lowerdir: args.checkoutDir,
    upperdir: path.join(work, "upper"),
    workdir: path.join(work, "work"),
  };
  const toDaemon = (p: string): string => daemonPath(p, args.stateRoot, args.volumeMountpoint);
  return {
    volumeName: pluginOverlayVolumeName(args.sessionId, args.repoName, args.commit),
    lowerdir: toDaemon(orchDirs.lowerdir),
    upperdir: toDaemon(orchDirs.upperdir),
    workdir: toDaemon(orchDirs.workdir),
    orchDirs,
  };
}

/**
 * Re-root an orchestrator path onto the daemon's view of the same volume.
 * Identity when either side is unknown (dev/dogfood bind mounts, where both
 * processes see one path) or when the path is outside the state root — better
 * to pass it through unchanged than to silently rewrite something unrelated.
 */
function daemonPath(p: string, stateRoot?: string, volumeMountpoint?: string): string {
  if (!stateRoot || !volumeMountpoint) return p;
  const root = stateRoot.endsWith("/") ? stateRoot.slice(0, -1) : stateRoot;
  if (p !== root && !p.startsWith(`${root}/`)) return p;
  return path.join(volumeMountpoint, path.relative(root, p));
}

/**
 * Resolve the daemon-host mountpoint once per call site. Returns `{}` in dev,
 * where there is no volume and the identity translation is correct.
 */
export async function resolvePluginOverlayRoots(
  docker: Docker,
  workspaceVolume: string | undefined,
  stateRoot: string | undefined,
): Promise<{ volumeMountpoint?: string; stateRoot?: string }> {
  if (!workspaceVolume || !stateRoot) return {};
  return { volumeMountpoint: await resolveVolumeMountpoint(docker, workspaceVolume), stateRoot };
}

/**
 * Create the volume for a spec. The caller must have created `orchDirs.upperdir`
 * and `orchDirs.workdir` first — the daemon mounts lazily, so a missing upper or
 * a dirty workdir surfaces later, at container start, as an opaque failure.
 */
export async function createPluginOverlay(docker: Docker, spec: PluginOverlaySpec): Promise<void> {
  await createOverlayVolume(docker, spec, { [PLUGIN_OVERLAY_LABEL]: spec.volumeName });
}

/**
 * The **runtime** volume for a published generation: the same upper layer
 * install wrote into, now under the published checkout as its lowerdir.
 *
 * Idempotent, and shared on purpose — the CLI invocation container
 * (`plugin-cli-run.ts`) and, when it lands, a plugin service both attach ONE
 * volume per generation. Creating a second one over the same upperdir is not an
 * option the kernel offers, so "ensure" rather than "create" is the only shape
 * that lets two independent callers ask for it.
 *
 * Existing → returned untouched. Absent → the upper and work directories are
 * created if they are missing (a plugin with no `install` never had them) and
 * handed to the session-worker UID, which is what every consumer runs as. The
 * directories are never *cleared*: that is install's job, before it writes, and
 * doing it here would delete the install output this volume exists to expose.
 */
export async function ensurePluginRuntimeOverlay(
  docker: Docker,
  args: {
    sessionId: string;
    repoName: string;
    commit: string;
    stateDir: string;
    /** The PUBLISHED generation directory — resolve `active` before calling. */
    checkoutDir: string;
    volumeMountpoint?: string;
    stateRoot?: string;
  },
): Promise<string> {
  const spec = buildPluginOverlaySpec(args);
  if (await volumeExists(docker, spec.volumeName)) return spec.volumeName;

  for (const dir of [spec.orchDirs.upperdir, spec.orchDirs.workdir]) {
    fs.mkdirSync(dir, { recursive: true });
    chownToSessionWorker(dir);
  }
  chownToSessionWorker(path.dirname(spec.orchDirs.upperdir));
  await createPluginOverlay(docker, spec);
  return spec.volumeName;
}

/**
 * Drop a generation's volume, and say whether it is actually gone. Called
 * before re-creating one over the same upper layer with a different lowerdir
 * (staging → published), and when a generation is pruned. Removing the volume
 * does NOT remove the upper layer — that is an ordinary directory, and it is
 * what carries install output across the rename.
 *
 * **The return value matters.** `removeOverlayVolume` is deliberately
 * best-effort: it swallows a 409 (still in use) because for a session's own
 * teardown the orphan sweep is a sufficient backstop. Here it is not — a volume
 * that is still held cannot be re-created over the same upperdir, so the caller
 * must not publish a generation whose runtime mount would then be unbuildable.
 * Verify rather than assume.
 */
export async function removePluginOverlay(docker: Docker, volumeName: string): Promise<boolean> {
  await removeOverlayVolume(docker, volumeName);
  try {
    return !(await volumeExists(docker, volumeName));
  } catch {
    // The daemon could not answer; treat an unknown state as "still held".
    return false;
  }
}
