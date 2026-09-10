import type Docker from "dockerode";
import {
  buildOverlaySpecs,
  depDirsForSession,
  isPnpmRepo,
  pnpmStoreDirForRuntime,
  resolveOverlayScope,
  validDepDirsForOverlay,
  type DepDirOverlaySpec,
} from "./overlay-session.js";
import { resolveVolumeMountpoint, volumeExists } from "./overlay-volume.js";
import { readBasePointerByHash } from "./overlay-base.js";
import { claimOverlayBaseGeneration } from "./overlay-base-claims.js";
import type { SessionInfo } from "../shared/types.js";

export interface OverlayProvisionerDeps {
  docker: Docker;
  workspaceVolume?: string;
  stateDir?: string;
}

export async function resolveWorkerImageId(docker: Docker, imageName: string): Promise<string> {
  try {
    const info = await docker.getImage(imageName).inspect();
    return info.Id ?? "";
  } catch (err) {
    console.warn(
      `[overlay] could not inspect worker image ${imageName} for the runtime scope:`,
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

export async function resolveWorkerBaseDigest(docker: Docker, imageName: string): Promise<string> {
  try {
    const info = await docker.getImage(imageName).inspect();
    const env = info.Config?.Env ?? [];
    const entry = env.find((e) => e.startsWith("BASE_IMAGE_DIGEST="));
    return entry ? entry.slice("BASE_IMAGE_DIGEST=".length) : "";
  } catch (err) {
    console.warn(
      `[overlay] could not inspect worker image ${imageName} for the base digest:`,
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

export async function resolveWorkerNodeVersion(docker: Docker, imageName: string): Promise<string> {
  try {
    const info = await docker.getImage(imageName).inspect();
    const env = info.Config?.Env ?? [];
    const entry = env.find((e) => e.startsWith("NODE_VERSION="));
    return entry ? entry.slice("NODE_VERSION=".length) : "";
  } catch (err) {
    console.warn(
      `[overlay] could not inspect worker image ${imageName} for its Node version:`,
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

export async function prepareOverlaySpecs(
  deps: OverlayProvisionerDeps,
  opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
    /** Compose external-volume references must already exist; creation paths omit this. */
    requireProvisioned?: boolean;
  },
): Promise<DepDirOverlaySpec[]> {
  const scope = resolveOverlayScope(opts.session, process.env, opts.workspaceDir);
  if (!scope) return [];
  if (!deps.workspaceVolume) return [];
  // pnpm hardlinks cannot cross overlayfs; use a shared store on the workspace filesystem.
  if (isPnpmRepo(opts.workspaceDir)) return [];
  const declared = depDirsForSession({ workspaceDir: opts.workspaceDir });
  const valid = await validDepDirsForOverlay(declared, opts.workspaceDir);
  if (valid.length === 0) return [];
  const volumeMountpoint = await resolveVolumeMountpoint(deps.docker, deps.workspaceVolume);
  const stateDir = deps.stateDir;
  const specs = buildOverlaySpecs({
    sessionId: opts.sessionId,
    scope,
    depDirs: valid,
    volumeMountpoint,
    stateRoot: stateDir,
    generationForScope: stateDir
      ? (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0
      : undefined,
  });
  if (!opts.requireProvisioned) {
    // Pin at selection: until the container exists, Docker cannot show the janitor that this base is needed.
    for (const spec of specs) claimOverlayBaseGeneration(spec.scopeHash, spec.generation);
    return specs;
  }
  const provisioned: DepDirOverlaySpec[] = [];
  for (const spec of specs) {
    if (await volumeExists(deps.docker, spec.volumeName)) {
      provisioned.push(spec);
    } else {
      console.warn(
        `[overlay:${opts.sessionId}] skipping compose mount for ${spec.depDir}: ` +
        `volume ${spec.volumeName} is not provisioned (agent container predates the overlay enable?)`,
      );
    }
  }
  return provisioned;
}

// Prefer recorded mounts: workspace config may change while the agent still uses its original overlays.
export async function resolveSiblingOverlayDepDirs(
  deps: OverlayProvisionerDeps,
  opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
    /** Null means no record; an empty array means no overlays. */
    provisioned: { depDir: string; volumeName: string }[] | null,
  },
): Promise<{ depDir: string; volumeName: string }[]> {
  if (opts.provisioned === null) {
    const specs = await prepareOverlaySpecs(deps, {
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      session: opts.session,
      requireProvisioned: true,
    });
    return specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName }));
  }
  const usable: { depDir: string; volumeName: string }[] = [];
  for (const pair of opts.provisioned) {
    if (await volumeExists(deps.docker, pair.volumeName)) usable.push(pair);
    else {
      console.warn(
        `[overlay:${opts.sessionId}] ${pair.depDir} is overlay-mounted in the agent container ` +
        `but its volume (${pair.volumeName}) is gone — a plugin command that loads a dependency ` +
        `from there will not see the agent's installed tree.`,
      );
    }
  }
  return usable;
}

export function preparePnpmStore(
  deps: Pick<OverlayProvisionerDeps, "workspaceVolume" | "stateDir">,
  opts: {
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  },
): string | undefined {
  if (!resolveOverlayScope(opts.session)) return undefined;
  if (!deps.workspaceVolume) return undefined;
  if (!deps.stateDir) return undefined;
  if (!isPnpmRepo(opts.workspaceDir)) return undefined;
  return pnpmStoreDirForRuntime(deps.stateDir);
}
