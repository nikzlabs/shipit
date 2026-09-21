import fs from "node:fs";
import type Docker from "dockerode";
import {
  buildOverlaySpecs,
  depDirsForSession,
  discardOverlayScopeDirs,
  removeInstallMarkerForOverlayReset,
  sessionOverlayScopeDirs,
  sessionPnpmStoreDir,
  PNPM_VERIFIED_NAMESPACE,
  resolveOverlayScope,
  classifyDepDirsForOverlay,
  type DepDirOverlaySpec,
} from "./overlay-session.js";
import {
  hasPnpmLockfile,
  isPnpmRepo,
  usesVerifiedBaseCompatiblePnpm,
} from "../shared/pnpm-repo.js";
import {
  overlayBaseGenDir,
  overlayScopeHash,
  overlayVolumeName,
  resolveVolumeMountpoint,
  volumeExists,
} from "./overlay-volume.js";
import { readBasePointerByHash, withScopeLock } from "./overlay-base.js";
import { claimOverlayBaseGeneration, releaseOverlayBaseClaims } from "./overlay-base-claims.js";
import type { SessionInfo } from "../shared/types.js";

export interface OverlayProvisionerDeps {
  docker: Docker;
  workspaceVolume?: string;
  stateDir?: string;
}

/**
 * Whether a pnpm session may mount a verified base at all. **False while planning#606 is open:**
 * `pnpm add` relinks `.bin` and `chmod`s every bin target unconditionally, those targets are base
 * files owned by the publishing uid, and a session cannot chmod a file it does not own — so the add
 * fails `EPERM` and breaks docs/276 req 9 (measured, `build-cost-spike.sh` /
 * `ineligible-sharing-spike.sh`). Flipping this constant back is the whole consumer-side change
 * once the repair (pre-seeding the tree's bin targets into the session's upper) lands; publishing
 * continues meanwhile, so the bases are already there.
 */
export const MOUNT_VERIFIED_PNPM_BASE = false;

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
    /**
     * A select→mount operation's claim token (`newOverlayClaimToken`). Passing one pins the
     * generations this selection chose until the caller releases it; a read-back path passes none,
     * because a running container already pins its own mount.
     */
    claimToken?: string;
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
  // planning#606: no pnpm session mounts a verified base while `pnpm add` fails EPERM over one.
  if (pnpm && !MOUNT_VERIFIED_PNPM_BASE) {
    // Only on a select→mount operation (the claim token): a read-back path runs while a container
    // created before the gate still has these layers mounted.
    if (deps.stateDir && opts.claimToken !== undefined) {
      await resetOverlayStateForGatedSession(deps.docker, {
        stateRoot: deps.stateDir,
        sessionId: opts.sessionId,
        workspaceDir: opts.workspaceDir,
      });
    }
    return [];
  }
  // A pnpm session whose checkout has no lockfile gets NO base lowerdir (docs/276 section 5,
  // "Per-session install"): pnpm would synthesize the wanted graph from the base's carried
  // `.pnpm/lock.yaml`, so mounting one would introduce a graph choice absent from the session's own
  // inputs. One-shot at mount, deliberately not watched — a session that deletes its lockfile
  // afterwards inherits the default-branch commit's graph, the repo's own trust boundary.
  if (pnpm && !hasPnpmLockfile(opts.workspaceDir)) return [];
  // A checkout whose pnpm resolves a different store version would not fail on the base — it would
  // RECREATE the whole tree over it (measured, `MIN_VERIFIED_BASE_PNPM_MAJOR`), whiteouting every
  // base file into this session's upper and reinstalling privately on top. An ordinary private
  // install is strictly cheaper, so such a session gets no lowerdir.
  if (pnpm && !usesVerifiedBaseCompatiblePnpm(opts.workspaceDir)) return [];
  const volumeMountpoint = await resolveVolumeMountpoint(deps.docker, deps.workspaceVolume);
  const stateDir = deps.stateDir;
  const namespace = pnpm ? PNPM_VERIFIED_NAMESPACE : undefined;

  // Pointer read and claim happen together under the scope's own lock, and the claim lives until
  // the caller releases it after the mount — so a sweep can never run between choosing a
  // generation and protecting it (docs/276 section 5, "Ordering and cleanup").
  const claimToken = opts.claimToken;
  const selected = new Map<string, number>();
  const published = new Set<string>();
  for (const depDir of valid) {
    const scopeHash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, depDir, namespace);
    await withScopeLock(scopeHash, async () => {
      const generation = stateDir ? selectGeneration(stateDir, scopeHash) : 0;
      selected.set(scopeHash, generation);
      if (stateDir && readBasePointerByHash(stateDir, scopeHash)) published.add(scopeHash);
      if (claimToken !== undefined) claimOverlayBaseGeneration(scopeHash, generation, claimToken);
    });
  }

  const specs = buildOverlaySpecs({
    sessionId: opts.sessionId,
    scope,
    depDirs: valid,
    volumeMountpoint,
    stateRoot: stateDir,
    ...(namespace !== undefined ? { namespace } : {}),
    generationForScope: (scopeHash) => selected.get(scopeHash) ?? 0,
  });
  // A pnpm session mounts ONLY a base the orchestrator's verifying builder published, and never
  // falls back to an unverified one (docs/276 section 5) — so the gate reads the pointer of the
  // scope each spec actually names, rather than recomputing the hash and risking drift from it.
  // All-or-nothing: a partly-mounted set would leave one declared dep dir on the verified base
  // and the next on a private install, with no single answer to what the session is running.
  // Until every one has a published generation the session installs privately, as it does today.
  if (pnpm && !specs.every((s) => published.has(s.scopeHash))) {
    if (claimToken !== undefined) releaseOverlayBaseClaims(claimToken);
    return [];
  }
  if (!opts.requireProvisioned) return specs;
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

/**
 * A session that mounted a verified base before the gate existed must not keep the state that base
 * left behind. Two things, and only the first is a correctness matter: the install marker was
 * stamped over the MERGED view, so leaving it makes this start skip `agent.install` into a
 * `node_modules` that no longer has a base under it; and the session's upper layers would be
 * re-adopted the day mounting returns, hiding everything installed privately meanwhile.
 *
 * The layers go only when nothing still mounts them. A Compose service preserved across an
 * agent-container restart (`preserveComposeOnDispose`) keeps its overlay volume, and deleting the
 * upper under a live mount would empty a running preview's `node_modules`; an AUTOMATIC service is
 * recreated onto the plain directories by the reconcile that follows the new agent recording no
 * overlay (`applyOverlayDepDirsForSession`), so the next container start discards the layers. A
 * MANUAL service is not — `start()` ups only automatic ones — so it holds the old mount, and its
 * layers, until someone restarts it. The marker is dropped either way, which is the half that
 * decides whether the agent's own install runs.
 */
async function resetOverlayStateForGatedSession(
  docker: Docker,
  opts: { stateRoot: string; sessionId: string; workspaceDir: string },
): Promise<void> {
  const stale = sessionOverlayScopeDirs(opts.stateRoot, opts.sessionId);
  if (stale.length === 0) return;
  removeInstallMarkerForOverlayReset(opts.workspaceDir);
  const holders = await overlayVolumeHolders(docker, opts.sessionId);
  if (holders.length > 0) {
    console.log(
      `[overlay:${opts.sessionId}] verified pnpm base mounting is gated off (planning#606) — ` +
      `dropped the install marker so agent.install refills node_modules privately, and kept ` +
      `${stale.length} superseded overlay layer(s) that ${holders.join(", ")} still mounts; ` +
      "they are discarded on the first start after that service is recreated",
    );
    return;
  }
  const discarded = discardOverlayScopeDirs(stale);
  console.log(
    `[overlay:${opts.sessionId}] verified pnpm base mounting is gated off (planning#606) — ` +
    `discarded ${discarded.length} superseded overlay layer(s) and dropped the install marker ` +
    "so agent.install refills node_modules privately",
  );
}

/** Containers still mounting any of this session's overlay volumes. Unreadable counts as held. */
async function overlayVolumeHolders(docker: Docker, sessionId: string): Promise<string[]> {
  try {
    // Docker's volume-name filter matches on substring, so the session's overlay prefix selects
    // exactly its own volumes whatever dep dirs the previous container had.
    const listed = await docker.listVolumes({ filters: { name: [overlayVolumeName(sessionId)] } });
    const names = (listed?.Volumes ?? []).map((v) => v.Name).filter((n): n is string => !!n);
    if (names.length === 0) return [];
    const holders = await docker.listContainers({ all: true, filters: { volume: names } });
    return holders.map((h) => h.Names?.[0] ?? h.Id);
  } catch (err) {
    console.warn(
      `[overlay:${sessionId}] could not tell whether anything still mounts the session's overlay ` +
      "volumes, so its superseded layers are being kept:",
      err instanceof Error ? err.message : String(err),
    );
    return ["(unknown)"];
  }
}

/**
 * Generation 0 is the empty cold base every session may create. A generation the pointer names is
 * NOT: if its directory is gone, the session installs over generation 0 rather than having the
 * missing lowerdir recreated empty — an empty directory at a published generation's path reads as
 * a base hit and would let the session skip the install that fills it (docs/276 section 5).
 */
function selectGeneration(stateDir: string, scopeHash: string): number {
  const generation = readBasePointerByHash(stateDir, scopeHash)?.generation ?? 0;
  if (generation === 0) return 0;
  if (fs.existsSync(overlayBaseGenDir(stateDir, scopeHash, generation))) return generation;
  console.warn(
    `[overlay] published generation g${generation} of scope ${scopeHash} is missing on disk — ` +
    "selecting the empty generation 0 and installing instead of recreating it",
  );
  return 0;
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
