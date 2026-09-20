import type Docker from "dockerode";
import {
  buildOverlaySpecs,
  depDirsForSession,
  isPnpmRepo,
  sessionPnpmStoreDir,
  PNPM_VERIFIED_NAMESPACE,
  resolveOverlayScope,
  classifyDepDirsForOverlay,
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
  const pnpm = isPnpmRepo(opts.workspaceDir);
  const declared = depDirsForSession({ workspaceDir: opts.workspaceDir });
  const { valid, dropped } = await classifyDepDirsForOverlay(declared, opts.workspaceDir);
  // A dropped dir gets no overlay and no install (the marker pre-stamp refuses on a partial
  // quorum), so say which one and why rather than leaving it out of the measurement line.
  if (dropped.length > 0) {
    const listed = dropped.map((d) => `${d.depDir} (${d.reason})`).join(", ");
    console.warn(
      `[overlay:${opts.sessionId}] ${dropped.length} declared agent.dep-dirs ` +
      `entr${dropped.length === 1 ? "y is" : "ies are"} not overlay-eligible: ${listed}`,
    );
  }
  if (valid.length === 0) return [];
  const volumeMountpoint = await resolveVolumeMountpoint(deps.docker, deps.workspaceVolume);
  const stateDir = deps.stateDir;
  const specs = buildOverlaySpecs({
    sessionId: opts.sessionId,
    scope,
    depDirs: valid,
    volumeMountpoint,
    stateRoot: stateDir,
    ...(pnpm ? { namespace: PNPM_VERIFIED_NAMESPACE } : {}),
    generationForScope: stateDir
      ? (scopeHash) => readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0
      : undefined,
  });
  // A pnpm session mounts ONLY a base the orchestrator's verifying builder published, and never
  // falls back to an unverified one (docs/276 section 5) — so the gate reads the pointer of the
  // scope each spec actually names, rather than recomputing the hash and risking drift from it.
  // All-or-nothing: a partly-mounted set would leave one declared dep dir on the verified base
  // and the next on a private install, with no single answer to what the session is running.
  // Until every one has a published generation the session installs privately, as it does today.
  if (pnpm && !specs.every((s) => stateDir && readBasePointerByHash(stateDir, s.scopeHash))) {
    return [];
  }
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
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  },
): string | undefined {
  if (!resolveOverlayScope(opts.session)) return undefined;
  if (!deps.workspaceVolume) return undefined;
  if (!deps.stateDir) return undefined;
  if (!isPnpmRepo(opts.workspaceDir)) return undefined;
  return sessionPnpmStoreDir(deps.stateDir, opts.sessionId);
}
