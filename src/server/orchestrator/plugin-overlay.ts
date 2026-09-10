import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import { chownToSessionWorker } from "./session-worker-uid.js";
import {
  createOverlayVolume,
  overlayVolumeState,
  removeOverlayVolume,
  resolveVolumeMountpoint,
  volumeExists,
  type OverlaySpec,
} from "./overlay-volume.js";
import {
  pluginsRoot,
  readGenerationRecordAt,
  splitGenerationId,
  WORK_SUBDIR,
} from "./plugin-generations.js";
import { pluginBasePinDir } from "./plugin-dep-store.js";

export const PLUGIN_OVERLAY_LABEL = "shipit-plugin-generation";

export interface PluginOverlaySpec extends OverlaySpec {
  // Local paths; the inherited spec uses daemon-host paths.
  orchDirs: { lowerdir: string; upperdir: string; workdir: string };
}

export function pluginOverlayVolumeName(
  sessionId: string,
  repoName: string,
  generationId: string,
): string {
  const { commit, revision } = splitGenerationId(generationId);
  const build = revision ? `${commit.slice(0, 12)}-${revision}` : commit.slice(0, 12);
  // The orphan sweep requires a 12-character session prefix.
  return `shipit-${sessionId.slice(0, 12)}_plugin-${safeSegment(repoName)}-${nameHash(repoName)}-${build}`;
}

function safeSegment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

// Distinguish names such as foo.bar and foo-bar that safeSegment merges.
function nameHash(name: string): string {
  return crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
}

export function pluginWorkDir(stateDir: string, repoName: string, generationId: string): string {
  return path.join(pluginsRoot(stateDir), repoName, WORK_SUBDIR, generationId);
}

export function buildPluginOverlaySpec(args: {
  sessionId: string;
  repoName: string;
  generationId: string;
  stateDir: string;
  // Staging during install; the published directory during runtime.
  checkoutDir: string;
  depBases?: readonly string[];
  volumeMountpoint?: string;
  stateRoot?: string;
}): PluginOverlaySpec {
  const work = pluginWorkDir(args.stateDir, args.repoName, args.generationId);
  const orchDirs = {
    lowerdir: args.checkoutDir,
    upperdir: path.join(work, "upper"),
    workdir: path.join(work, "work"),
  };
  const toDaemon = (p: string): string => daemonPath(p, args.stateRoot, args.volumeMountpoint);
  // Overlay lowerdirs are ordered highest priority first: source overrides bases.
  const lowerdirs = [orchDirs.lowerdir, ...(args.depBases ?? [])].map(toDaemon);
  return {
    volumeName: pluginOverlayVolumeName(args.sessionId, args.repoName, args.generationId),
    lowerdir: lowerdirs.join(":"),
    upperdir: toDaemon(orchDirs.upperdir),
    workdir: toDaemon(orchDirs.workdir),
    orchDirs,
  };
}

function daemonPath(p: string, stateRoot?: string, volumeMountpoint?: string): string {
  if (!stateRoot || !volumeMountpoint) return p;
  const root = stateRoot.endsWith("/") ? stateRoot.slice(0, -1) : stateRoot;
  if (p !== root && !p.startsWith(`${root}/`)) return p;
  return path.join(volumeMountpoint, path.relative(root, p));
}

export async function resolvePluginOverlayRoots(
  docker: Docker,
  workspaceVolume: string | undefined,
  stateRoot: string | undefined,
): Promise<{ volumeMountpoint?: string; stateRoot?: string }> {
  if (!workspaceVolume || !stateRoot) return {};
  return { volumeMountpoint: await resolveVolumeMountpoint(docker, workspaceVolume), stateRoot };
}

// The caller must create upperdir and an empty workdir before the daemon mounts.
export async function createPluginOverlay(docker: Docker, spec: PluginOverlaySpec): Promise<void> {
  await createOverlayVolume(docker, spec, { [PLUGIN_OVERLAY_LABEL]: spec.volumeName });
}

export interface PluginRuntimeOverlayArgs {
  sessionId: string;
  repoName: string;
  generationId: string;
  stateDir: string;
  checkoutDir: string;
  depStoreDir?: string;
  volumeMountpoint?: string;
  stateRoot?: string;
}

export function pluginRuntimeOverlaySpec(args: PluginRuntimeOverlayArgs): PluginOverlaySpec {
  return buildPluginOverlaySpec({ ...args, depBases: resolvePinnedDepBases(args) });
}

const ensureQueues = new Map<string, Promise<void>>();
// Services and CLIs share one volume: two overlay mounts cannot share an upperdir.
// Serialize inspect/create and retain the upperdir's install output.
export async function ensurePluginRuntimeOverlay(
  docker: Docker,
  args: PluginRuntimeOverlayArgs,
): Promise<string> {
  const spec = pluginRuntimeOverlaySpec(args);
  const previous = ensureQueues.get(spec.volumeName) ?? Promise.resolve();
  // eslint-disable-next-line no-restricted-syntax -- chaining a serial queue; awaiting `previous` here would be the race
  const work = previous.then(async () => {
    // Docker can recreate a missing named volume as a plain local volume.
    if (await overlayVolumeState(docker, spec) === "match") return;
    for (const dir of [spec.orchDirs.upperdir, spec.orchDirs.workdir]) {
      fs.mkdirSync(dir, { recursive: true });
      chownToSessionWorker(dir);
    }
    chownToSessionWorker(path.dirname(spec.orchDirs.upperdir));
    await createPluginOverlay(docker, spec);
  });
  // A failed call must not reject subsequent calls in the queue.
  const tail = work.catch(() => undefined);
  ensureQueues.set(spec.volumeName, tail);
  try {
    await work;
  } finally {
    await tail;
    if (ensureQueues.get(spec.volumeName) === tail) ensureQueues.delete(spec.volumeName);
  }
  return spec.volumeName;
}

// Read pins from the resolved generation. A missing base means missing dependencies.
function resolvePinnedDepBases(args: { checkoutDir: string; depStoreDir?: string }): string[] {
  const pins = readGenerationRecordAt(args.checkoutDir)?.basePins ?? [];
  if (pins.length === 0) return [];
  if (!args.depStoreDir) {
    throw new Error("this generation shares its dependencies, but the dependency store is not configured");
  }
  return pins.map((pin) => {
    const dir = pluginBasePinDir(args.depStoreDir!, pin);
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(
        `its shared dependency layer (${pin}) is gone — run \`shipit plugin refresh\` to install them again`,
      );
    }
    return dir;
  });
}

// Verify removal before mounting the same upperdir over the published checkout.
export async function removePluginOverlay(docker: Docker, volumeName: string): Promise<boolean> {
  await removeOverlayVolume(docker, volumeName);
  try {
    return !(await volumeExists(docker, volumeName));
  } catch {
    return false;
  }
}
