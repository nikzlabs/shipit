import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";
import {
  INSTALL_MARKER_FILE,
  sessionSharedStateDir,
  sessionStateDirForWorkspace,
} from "./session-state-dir.js";
import { overlayScopeHash, overlayVolumeName, overlayBaseGenDir, type OverlaySpec } from "./overlay-volume.js";
import { readBasePointerByHash, type BasePointer, type OverlayScope } from "./overlay-base.js";
import { makeMarker, serializeMarker } from "../shared/install-marker.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { chownToSessionWorker } from "./session-worker-uid.js";
import { readNodePin, parseVersion, satisfies } from "../shared/node-pin.js";

export function isOverlayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OVERLAY_DEP_STORE;
  return v !== "0" && v !== "false";
}

export function isOverlayEligible(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isOverlayEnabled(env)) return false;
  if (!session.remoteUrl) return false;
  if (session.kind === "ops") return false;
  return true;
}

// The base-image digest isolates ABI changes without invalidating bases on code-only rebuilds.
export function overlayRuntimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.BASE_IMAGE_DIGEST ?? env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  return `${base}|${process.arch}`;
}

// Separate Node pins: npm install may retain native addons built for a different ABI.
export function overlayPinSegment(
  workspaceDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!workspaceDir) return "";
  const pin = readNodePin(workspaceDir);
  if (!pin?.spec) return "";
  const imageNode = parseVersion(env.WORKER_IMAGE_NODE_VERSION ?? "");
  if (imageNode && satisfies(imageNode, pin.spec)) return "";
  return `|pin${pin.raw.replace(/\s+/g, " ").trim()}`;
}

export function resolveOverlayScope(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
  workspaceDir?: string,
): OverlayScope | null {
  if (!isOverlayEligible(session, env)) return null;
  return {
    repoUrl: session.remoteUrl,
    runtimeKey: overlayRuntimeKey(env) + overlayPinSegment(workspaceDir, env),
  };
}

export interface DepDirOverlaySpec extends OverlaySpec {
  depDir: string;
  mountPath: string;
  scope: OverlayScope;
  scopeHash: string;
  // The mounted generation, which can differ from the current published pointer.
  generation: number;
  // Paths on the orchestrator's view of the same volume, for mkdir before mounting.
  orchDirs?: { lowerdir: string; upperdir: string; workdir: string; sessionScopeDir: string };
}

export const OVERLAY_SESSION_SUBDIR = "overlay";

export function sessionOverlayScopeDir(root: string, sessionId: string, scopeHash: string): string {
  return path.join(root, "sessions", sessionId, OVERLAY_SESSION_SUBDIR, scopeHash);
}

// An old upper's copy-ups and whiteouts would shadow a new lower. Rotate both together;
// prepareOverlayDirs must also drop the install marker when it discards an upper.
export function sessionOverlayGenDir(
  root: string,
  sessionId: string,
  scopeHash: string,
  generation: number,
): string {
  return path.join(sessionOverlayScopeDir(root, sessionId, scopeHash), `g${generation}`);
}

// Call only after the previous container's overlay volume has been removed.
export function supersededSessionOverlayLayers(
  sessionScopeDir: string,
  keepGeneration: number,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionScopeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const keep = `g${keepGeneration}`;
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => (/^g\d+$/.test(e.name) && e.name !== keep) || e.name === "upper" || e.name === "work")
    .map((e) => path.join(sessionScopeDir, e.name));
}

export const CONTAINER_WORKSPACE_PATH = "/workspace";

export function buildOverlaySpecs(args: {
  sessionId: string;
  scope: Pick<OverlayScope, "repoUrl" | "runtimeKey">;
  depDirs: string[];
  volumeMountpoint: string;
  stateRoot?: string;
  // Generation 0 is the empty cold-start base.
  generationForScope?: (scopeHash: string) => number;
}): DepDirOverlaySpec[] {
  const { sessionId, scope, depDirs, volumeMountpoint, stateRoot } = args;
  const generationForScope = args.generationForScope ?? (() => 0);
  return depDirs.map((depDir) => {
    const scopeHash = overlayScopeHash(scope.repoUrl, scope.runtimeKey, depDir);
    const generation = generationForScope(scopeHash);
    const sessionOverlayDir = sessionOverlayGenDir(volumeMountpoint, sessionId, scopeHash, generation);
    const orchSessionOverlayDir = stateRoot
      ? sessionOverlayGenDir(stateRoot, sessionId, scopeHash, generation)
      : undefined;
    return {
      volumeName: overlayVolumeName(sessionId, depDir),
      lowerdir: overlayBaseGenDir(volumeMountpoint, scopeHash, generation),
      upperdir: path.join(sessionOverlayDir, "upper"),
      workdir: path.join(sessionOverlayDir, "work"),
      depDir,
      mountPath: path.posix.join(CONTAINER_WORKSPACE_PATH, depDir),
      scope: { repoUrl: scope.repoUrl, runtimeKey: scope.runtimeKey, depDir },
      scopeHash,
      generation,
      ...(stateRoot && orchSessionOverlayDir
        ? {
            orchDirs: {
              lowerdir: overlayBaseGenDir(stateRoot, scopeHash, generation),
              upperdir: path.join(orchSessionOverlayDir, "upper"),
              workdir: path.join(orchSessionOverlayDir, "work"),
              sessionScopeDir: sessionOverlayScopeDir(stateRoot, sessionId, scopeHash),
            },
          }
        : {}),
    };
  });
}

// Stable ordering prevents Docker inspect order changes from recreating Compose services.
export function sortOverlayDepDirs<T extends { depDir: string }>(pairs: T[]): T[] {
  return [...pairs].sort((a, b) => (a.depDir < b.depDir ? -1 : a.depDir > b.depDir ? 1 : 0));
}

// Read actual mounts: workspace config can change after container creation.
export function overlayDepDirsFromMounts(
  sessionId: string,
  mounts: readonly { Type?: string; Name?: string; Destination?: string }[] | undefined,
): { depDir: string; volumeName: string }[] {
  const overlayPrefix = overlayVolumeName(sessionId);
  const workspacePrefix = `${CONTAINER_WORKSPACE_PATH}/`;
  const pairs: { depDir: string; volumeName: string }[] = [];
  for (const mount of mounts ?? []) {
    if (mount.Type !== "volume") continue;
    const volumeName = mount.Name;
    if (!volumeName?.startsWith(overlayPrefix)) continue;
    const destination = mount.Destination;
    if (!destination?.startsWith(workspacePrefix)) continue;
    const depDir = destination.slice(workspacePrefix.length);
    if (!depDir) continue;
    pairs.push({ depDir, volumeName });
  }
  return sortOverlayDepDirs(pairs);
}

// Callers must include warm-pool sessions, whose mounted bases also need GC protection.
export function liveOverlayScopeHashes(
  sessions: SessionInfo[],
  resolveDepDirs: (session: SessionInfo) => string[],
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const live = new Set<string>();
  if (!isOverlayEnabled(env)) return live;
  const runtimeKey = overlayRuntimeKey(env);
  for (const s of sessions) {
    if (!s.remoteUrl) continue;
    if (s.kind === "ops") continue;
    if (s.diskTier === "evicted") continue;
    for (const depDir of resolveDepDirs(s)) {
      live.add(overlayScopeHash(s.remoteUrl, runtimeKey, depDir));
    }
  }
  return live;
}

export function depDirsForSession(session: Pick<SessionInfo, "workspaceDir">): string[] {
  if (!session.workspaceDir) return [];
  try {
    return resolveShipitConfig(session.workspaceDir).agent.depDirs;
  } catch {
    return [...DEFAULT_DEP_DIRS];
  }
}

export async function validDepDirsForOverlay(
  depDirs: string[],
  workspaceDir: string,
): Promise<string[]> {
  if (depDirs.length === 0) return [];
  const parentExists = depDirs.filter((d) => fs.existsSync(path.join(workspaceDir, path.dirname(d))));
  if (parentExists.length === 0) return [];
  try {
    // The slash form matches directory-only ignore rules before the directory exists.
    const queries = parentExists.flatMap((d) => [d, `${d}/`]);
    const ignored = new Set(await safeSimpleGit(workspaceDir).checkIgnore(queries));
    return parentExists.filter((d) => ignored.has(d) || ignored.has(`${d}/`));
  } catch {
    return [];
  }
}

// Keep the pnpm store on the workspace filesystem: overlayfs forces hardlinks into copies.
export const PNPM_STORE_SUBDIR = "pnpm-store";

export function pnpmStoreHash(runtimeKey: string): string {
  return crypto.createHash("sha256").update(runtimeKey).digest("hex").slice(0, 16);
}

export function pnpmStoreDirForRuntime(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir, PNPM_STORE_SUBDIR, pnpmStoreHash(overlayRuntimeKey(env)));
}

function readPackageManagerField(workspaceDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, "package.json"), "utf-8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.trim()) {
      return pkg.packageManager.trim();
    }
  } catch {
    /* No package-manager signal. */
  }
  return null;
}

function pnpmSignalFromInstall(install: string[]): boolean | null {
  let sawNonPnpm = false;
  for (const cmd of install) {
    if (/(?:^|[\s;&|(])pnpm(?:[\s;&|)]|$)/.test(cmd)) return true;
    if (/(?:^|[\s;&|(])(?:npm|yarn|bun)(?:[\s;&|)]|$)/.test(cmd)) sawNonPnpm = true;
  }
  return sawNonPnpm ? false : null;
}

export function isPnpmRepo(workspaceDir: string): boolean {
  const pm = readPackageManagerField(workspaceDir);
  if (pm !== null) return pm.startsWith("pnpm");
  let install: string[];
  try {
    install = resolveShipitConfig(workspaceDir).agent.install;
  } catch {
    install = [];
  }
  const installSignal = pnpmSignalFromInstall(install);
  if (installSignal !== null) return installSignal;
  return fs.existsSync(path.join(workspaceDir, "pnpm-lock.yaml"));
}

// Run after container start pins the lower layer, before exposing the worker URL for install.
export async function preStampInstallMarker(args: {
  stateDir: string;
  workspaceDir: string;
  specs: DepDirOverlaySpec[];
  readPointer?: (stateDir: string, scopeHash: string) => BasePointer | null;
  chown?: (targetPath: string) => void;
}): Promise<boolean> {
  const { stateDir, workspaceDir, specs } = args;
  if (specs.length === 0) return false;
  const readPointer = args.readPointer ?? readBasePointerByHash;
  const chown = args.chown ?? chownToSessionWorker;

  // Use the same state slice mounted at the worker's /session-state.
  const markerFile = path.join(
    sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)),
    INSTALL_MARKER_FILE,
  );
  if (fs.existsSync(markerFile)) return false;

  let head: string;
  try {
    head = (await safeSimpleGit(workspaceDir).revparse(["HEAD"])).trim();
  } catch {
    return false;
  }
  if (!head) return false;

  let installCommands: string[];
  let installInputs: string[] | null;
  try {
    const agent = resolveShipitConfig(workspaceDir).agent;
    installCommands = agent.install;
    installInputs = agent.installInputs;
  } catch {
    return false;
  }
  if (installCommands.length === 0) return false;

  const depsHash = computeInstallDepsHash(workspaceDir, installCommands, installInputs);

  let runtimeKey: string | null = null;
  for (const spec of specs) {
    const ptr = readPointer(stateDir, spec.scopeHash);
    if (!ptr?.marker) return false;
    const commitMatches = ptr.commit === head;
    const contentMatches =
      depsHash !== null && typeof ptr.marker.depsHash === "string" && ptr.marker.depsHash === depsHash;
    if (!commitMatches && !contentMatches) return false;
    // A concurrent publish can advance the pointer past the generation actually mounted.
    if (ptr.generation !== spec.generation) return false;
    const cmds = ptr.marker.installCommands;
    if (cmds.length !== installCommands.length || !cmds.every((c, i) => c === installCommands[i])) {
      return false;
    }
    if (runtimeKey === null) runtimeKey = ptr.marker.runtimeKey;
    else if (runtimeKey !== ptr.marker.runtimeKey) return false;
  }
  if (!runtimeKey) return false;

  const marker = makeMarker(
    { sourceCommit: head, runtimeKey, installCommands, depsHash },
    new Date().toISOString(),
  );
  const markerDir = path.dirname(markerFile);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(markerFile, serializeMarker(marker));
  // The worker must be able to replace this marker after a later install.
  chown(markerDir);
  chown(markerFile);
  return true;
}
