import crypto from "node:crypto";
import path from "node:path";
import type Docker from "dockerode";

// Keep immutable bases outside dep-cache, which sessions mount read-write.
export const OVERLAY_BASE_SUBDIR = "overlay-base";

// Names must match the orphan-volume sweep's shipit-<12-char session prefix>_ pattern.
export const OVERLAY_VOLUME_SUFFIX = "_overlay";

export const OVERLAY_MANAGED_LABEL = "shipit-managed";

export function overlayVolumeName(sessionId: string, depDir?: string): string {
  const base = `shipit-${sessionId.slice(0, 12)}${OVERLAY_VOLUME_SUFFIX}`;
  if (depDir === undefined) return base;
  return `${base}-${depDirDiscriminator(depDir)}`;
}

export function depDirDiscriminator(depDir: string): string {
  return crypto.createHash("sha256").update(depDir).digest("hex").slice(0, 8);
}

export function overlayScopeHash(repoUrl: string, runtimeKey: string, depDir?: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(repoUrl)
    .update("\0")
    .update(runtimeKey);
  if (depDir !== undefined) {
    hash.update("\0").update(depDir);
  }
  return hash.digest("hex").slice(0, 16);
}

export function overlayBaseDir(stateDir: string, scopeHash: string): string {
  return path.join(stateDir, OVERLAY_BASE_SUBDIR, scopeHash);
}

// Never rename or delete a mounted generation: overlay readdir depends on its dentries.
export function overlayBaseGenDir(stateDir: string, scopeHash: string, generation: number): string {
  return path.join(stateDir, OVERLAY_BASE_SUBDIR, scopeHash, `g${generation}`);
}

// Absolute daemon-host paths. Upper and work must share a filesystem; work must be empty.
export interface OverlaySpec {
  volumeName: string;
  lowerdir: string;
  upperdir: string;
  workdir: string;
}

let createChain: Promise<void> = Promise.resolve();

async function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const prev = createChain;
  let release!: () => void;
  createChain = new Promise<void>((r) => { release = r; });
  try {
    await prev;
  } catch {
    // A previous failure must not block later callers.
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function resolveVolumeMountpoint(
  docker: Docker,
  volumeName: string,
): Promise<string> {
  const info = await docker.getVolume(volumeName).inspect();
  if (!info.Mountpoint) {
    throw new Error(`Volume ${volumeName} has no Mountpoint`);
  }
  return info.Mountpoint;
}

export function overlayDriverOpts(spec: OverlaySpec): string {
  return `lowerdir=${spec.lowerdir},upperdir=${spec.upperdir},workdir=${spec.workdir}`;
}

export type OverlayVolumeState = "absent" | "match" | "mismatch";

export interface OverlayVolumeReading {
  state: OverlayVolumeState;
  observedOpts?: string;
}

// Ignore label drift: it does not change mounts and should not trigger a stack teardown.
export async function readOverlayVolume(
  docker: Docker,
  spec: OverlaySpec,
): Promise<OverlayVolumeReading> {
  let info: { Options?: Record<string, string> | null };
  try {
    info = await docker.getVolume(spec.volumeName).inspect();
  } catch (err) {
    if (errStatus(err) === 404) return { state: "absent" };
    throw err;
  }
  const observedOpts = info.Options?.o;
  if (observedOpts === overlayDriverOpts(spec)) return { state: "match", observedOpts };
  return { state: "mismatch", ...(observedOpts ? { observedOpts } : {}) };
}

export async function overlayVolumeState(
  docker: Docker,
  spec: OverlaySpec,
): Promise<OverlayVolumeState> {
  return (await readOverlayVolume(docker, spec)).state;
}

// Re-read holders on each attempt: a concurrent Compose reconcile can recreate them.
export async function releaseOverlayVolumeHolders(
  docker: Docker,
  volumeNames: string[],
  opts: { sessionId?: string } = {},
): Promise<string[]> {
  if (volumeNames.length === 0) return [];
  const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
  let holders: { Id: string; Names?: string[] }[];
  try {
    holders = await docker.listContainers({
      all: true,
      filters: { volume: volumeNames },
    });
  } catch (err) {
    console.warn(
      `${tag} could not list the containers holding ${volumeNames.join(", ")}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
  const released: string[] = [];
  for (const holder of holders) {
    try {
      await docker.getContainer(holder.Id).remove({ force: true });
      released.push(holder.Id);
    } catch (err) {
      if (errStatus(err) === 404) continue;
      console.warn(
        `${tag} could not remove ${holder.Names?.[0] ?? holder.Id} before recreating its overlay volume:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (released.length > 0) {
    console.log(
      `${tag} removed ${released.length} container(s) holding ${volumeNames.length} ` +
      `overlay volume(s) whose base generation rotated — they are recreated over the new generation`,
    );
  }
  return released;
}

const OVERLAY_CREATE_ATTEMPTS = 3;
const OVERLAY_CREATE_RETRY_MS = 250;

export interface OverlayVolumeCreateResult {
  unchanged: boolean;
  // Removed holders require a Compose reconcile.
  releasedHolders: string[];
}

// Docker silently reuses existing volumes and ignores new options. Verify after creation.
// Only session dep-dir callers may release holders; plugin overlays share theirs deliberately.
export async function createOverlayVolume(
  docker: Docker,
  spec: OverlaySpec,
  labels: Record<string, string> = {},
  opts: { releaseHolders?: boolean; sessionId?: string } = {},
): Promise<OverlayVolumeCreateResult> {
  return serialize(async () => {
    const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
    const releasedHolders: string[] = [];
    for (let attempt = 1; attempt <= OVERLAY_CREATE_ATTEMPTS; attempt++) {
      const state = await overlayVolumeState(docker, spec);
      if (state === "match") {
        return { unchanged: attempt === 1 && releasedHolders.length === 0, releasedHolders };
      }
      if (state === "mismatch") {
        if (opts.releaseHolders) {
          releasedHolders.push(
            ...(await releaseOverlayVolumeHolders(docker, [spec.volumeName], opts)),
          );
        }
        await removeVolumeIfExists(docker, spec.volumeName);
      }
      await docker.createVolume({
        Name: spec.volumeName,
        Driver: "local",
        DriverOpts: {
          type: "overlay",
          device: "overlay",
          o: overlayDriverOpts(spec),
        },
        Labels: { ...labels, [OVERLAY_MANAGED_LABEL]: "true" },
      });
      if (await overlayVolumeState(docker, spec) === "match") {
        return { unchanged: false, releasedHolders };
      }
      if (attempt < OVERLAY_CREATE_ATTEMPTS) {
        console.warn(
          `${tag} ${spec.volumeName} still names a different generation after attempt ${attempt} ` +
          `— a container re-took it mid-recreate; retrying`,
        );
        await new Promise((r) => setTimeout(r, OVERLAY_CREATE_RETRY_MS));
      }
    }
    throw new Error(
      `Overlay volume ${spec.volumeName} could not be recreated with the requested driver opts ` +
      `after ${OVERLAY_CREATE_ATTEMPTS} attempts (wanted "${overlayDriverOpts(spec)}"). Docker ` +
      `returns the pre-existing volume when the name is taken, so the removal kept failing — ` +
      `typically HTTP 409 because a container still mounts it.`,
    );
  });
}

export const OVERLAY_VERIFY_FAILURE = "overlay volume verification failed";

// Check after createContainer, before start: Docker can recreate a deleted volume with no options.
export async function assertOverlayVolumesMatch(
  docker: Docker,
  specs: readonly (OverlaySpec & { depDir?: string })[],
  opts: { sessionId?: string } = {},
): Promise<void> {
  const tag = opts.sessionId ? `[overlay:${opts.sessionId}]` : "[overlay]";
  for (const spec of specs) {
    const { state, observedOpts } = await readOverlayVolume(docker, spec);
    if (state === "match") continue;
    const held = state === "absent"
      ? "it does not exist at all"
      : observedOpts
        ? `it holds "${observedOpts}"`
        : "it holds NO driver options — the shape Docker leaves behind when it implicitly "
          + "creates a named volume that a container referenced but that no longer existed";
    throw new Error(
      `${tag} ${OVERLAY_VERIFY_FAILURE}: ${spec.volumeName}`
      + `${spec.depDir ? ` (dep dir "${spec.depDir}")` : ""} is not the overlay it was created as — `
      + `${held}, but this container was built to mount "${overlayDriverOpts(spec)}". `
      + `Refusing to start it: that mount would be an empty root-owned directory the session uid `
      + `cannot write, so agent.install could never succeed and the session would boot wedged.`,
    );
  }
}

export async function volumeExists(docker: Docker, volumeName: string): Promise<boolean> {
  try {
    await docker.getVolume(volumeName).inspect();
    return true;
  } catch (err) {
    if (errStatus(err) === 404) return false;
    throw err;
  }
}

export async function removeOverlayVolume(
  docker: Docker,
  volumeName: string,
): Promise<void> {
  try {
    await docker.getVolume(volumeName).remove({ force: true });
  } catch (err) {
    // The orphan-volume sweep retries volumes still in use.
    const code = errStatus(err);
    if (code !== 404 && code !== 409) {
      console.warn(
        `[overlay] failed to remove volume ${volumeName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

async function removeVolumeIfExists(docker: Docker, volumeName: string): Promise<void> {
  try {
    await docker.getVolume(volumeName).remove({ force: true });
  } catch (err) {
    // Creation verifies the resulting options and retries failed removal.
    if (errStatus(err) !== 404) {
      console.warn(
        `[overlay] pre-create removal of ${volumeName} did not complete cleanly:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function errStatus(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode;
  }
  return 0;
}
