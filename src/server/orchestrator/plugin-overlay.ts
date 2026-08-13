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

import path from "node:path";
import type Docker from "dockerode";
import {
  createOverlayVolume,
  removeOverlayVolume,
  resolveVolumeMountpoint,
  type OverlaySpec,
} from "./overlay-volume.js";
import { pluginsRoot } from "./plugin-generations.js";

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
 * consumers hold it. The `shipit-<session-prefix>_` shape matches the existing
 * convention so orphan collection can find these the same way.
 */
export function pluginOverlayVolumeName(sessionId: string, repoName: string, commit: string): string {
  return `shipit-${sessionId.slice(0, 8)}_plugin-${safeSegment(repoName)}-${commit.slice(0, 12)}`;
}

/** A volume-name-safe rendering of a declared repo name. */
function safeSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/** Where a generation's writable layer lives, as the orchestrator sees it. */
export function pluginWorkDir(stateDir: string, repoName: string, commit: string): string {
  return path.join(pluginsRoot(stateDir), repoName, "work", commit);
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
 * Drop a generation's volume. Called before re-creating one over the same upper
 * layer with a different lowerdir (staging → published), and when a generation
 * is pruned. Removing the volume does NOT remove the upper layer — that is an
 * ordinary directory, and it is what carries install output across the rename.
 */
export async function removePluginOverlay(docker: Docker, volumeName: string): Promise<void> {
  await removeOverlayVolume(docker, volumeName);
}
