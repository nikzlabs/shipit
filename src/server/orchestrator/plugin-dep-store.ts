import crypto from "node:crypto";
import fs, { type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { SessionInfo } from "../shared/types.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { destinationKey, pluginCloneUrl } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { computeDepsHash, hasInstallLifecycleScript, resolveDepsHashInputs } from "../shared/deps-hash.js";
import { overlayBaseGenDir, overlayScopeHash } from "./overlay-volume.js";
import { repoUrlToHash } from "./git-utils.js";
import {
  OVERLAY_POINTER_SUBDIR,
  publishBase,
  readBasePointerByHash,
  type OverlayScope,
} from "./overlay-base.js";
import { isOverlayEnabled, overlayRuntimeKey } from "./overlay-session.js";
import { shareTreeWithAllSessions, shareWithAllSessions } from "./session-worker-uid.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { pluginsRoot, readGenerationRecordAt } from "./plugin-generations.js";
import { PLUGIN_TOOLCHAIN_DIR_NAME } from "./plugin-container-env.js";

export type PluginDepStoreReasonKind =
  | "store-disabled"
  | "no-store"
  | "no-install"
  | "install-lifecycle-script"
  | "unrecognized-install"
  | "no-input-files"
  | "no-dep-dirs"
  | "tracked-dep-dir"
  | "nothing-installed"
  | "not-a-directory"
  | "publish-failed";

export interface PluginDepStoreReason {
  kind: PluginDepStoreReasonKind;
  subject?: string;
  detail?: string;
}

export function describePluginDepStoreReason(reason: PluginDepStoreReason): string {
  const subject = reason.subject ? `\`${short(reason.subject)}\`` : "it";
  const detail = reason.detail ? short(reason.detail) : "";
  const inputs = "Declaring `install-inputs:` on the plugin tells ShipIt exactly what the install "
    + "consumes, which qualifies it again.";
  const cold = "Dependencies are installed from scratch in every session and never shared";
  const dir = `${subject} is installed from scratch in every session and never shared`;
  switch (reason.kind) {
    case "store-disabled":
      return `${cold}: ShipIt's shared dependency store is switched off on this instance `
        + "(`OVERLAY_DEP_STORE=0`).";
    case "no-store":
      return `${cold}: this ShipIt deployment has no shared dependency store.`;
    case "no-install":
      return `${cold}: no selected plugin declares an \`install:\`.`;
    case "install-lifecycle-script":
      return `${cold}: ${subject}'s \`package.json\` declares an install lifecycle script `
        + "(`preinstall`, `install`, `postinstall`, `prepare` or `prepublish`), so the install is a "
        + `build and its output is not decided by the files ShipIt hashes. ${inputs}`;
    case "unrecognized-install":
      return `${cold}: ${subject}'s install command is not one ShipIt can identify the inputs of`
        + `${detail ? ` (\`${detail}\`)` : ""}. ${inputs}`;
    case "no-input-files":
      return `${cold}: none of the files ${subject}'s install is keyed on are in this repository.`;
    case "no-dep-dirs":
      return `${cold}: no selected plugin declares \`dep-dirs:\`.`;
    case "tracked-dep-dir":
      return `${cold}: ${subject} is committed to this repository, so ShipIt reads it as source `
        + "rather than as install output.";
    case "nothing-installed":
      return `${dir}: the install left nothing there.`;
    case "not-a-directory":
      return `${dir}: what the install left there is not a directory.`;
    case "publish-failed":
      return `${subject} stayed private to this install: it could not be published to the shared `
        + `dependency store${detail ? ` (${detail})` : ""}. The next install of these dependencies `
        + "will try again.";
  }
}

const MAX_INTERPOLATED_CHARS = 120;

function short(text: string): string {
  return text.length > MAX_INTERPOLATED_CHARS ? `${text.slice(0, MAX_INTERPOLATED_CHARS)}…` : text;
}

export type PluginDepStoreDecision =
  | { plan: PluginDepPlan; reason?: undefined }
  | { plan: null; reason: PluginDepStoreReason };

export interface PluginDepDirPlan {
  depDir: string;
  scope: OverlayScope;
  scopeHash: string;
}

export interface PluginDepPromotion {
  depDir: string;
  pin: string | null;
  // The tree left the upper but did not reach the store: callers must fail the install.
  lost: boolean;
  reason?: PluginDepStoreReason;
}

export interface PluginDepPlan {
  depsKey: string;
  installCommands: string[];
  dirs: PluginDepDirPlan[];
}

export function pluginBasePin(scopeHash: string, generation: number): string {
  return `${scopeHash}/g${generation}`;
}

const PIN_RE = /^([a-f0-9]{16})\/g([1-9][0-9]*)$/;

export function parsePluginBasePin(pin: unknown): { scopeHash: string; generation: number } | null {
  if (typeof pin !== "string") return null;
  const m = PIN_RE.exec(pin);
  return m ? { scopeHash: m[1], generation: Number(m[2]) } : null;
}

export function pluginBasePinDir(depStoreDir: string, pin: unknown): string | null {
  const parsed = parsePluginBasePin(pin);
  return parsed ? overlayBaseGenDir(depStoreDir, parsed.scopeHash, parsed.generation) : null;
}

// Key by source repository, runtime, and install inputs; declaration names can be repointed.
export function pluginDepScope(source: string, depsKey: string, depDir: string, env = process.env): OverlayScope {
  return {
    repoUrl: `plugin:${source}`,
    runtimeKey: `${overlayRuntimeKey(env)}|deps:${depsKey}`,
    depDir,
  };
}

export function planPluginDepStore(args: {
  source: string;
  exports: readonly PluginExport[];
  checkoutDir: string;
  env?: NodeJS.ProcessEnv;
}): PluginDepStoreDecision {
  const env = args.env ?? process.env;
  if (!isOverlayEnabled(env)) return declined("store-disabled");

  // Preserve execution order: reversing install commands can change the resulting tree.
  const installers = args.exports
    .filter((e): e is PluginExport & { install: string } => Boolean(e.install?.trim()));
  if (installers.length === 0) return declined("no-install");

  const parts: string[][] = [];
  for (const e of installers) {
    const command = e.install.trim();
    // Lifecycle scripts may read unhashed source; explicit install-inputs supplies that contract.
    if (e.installInputs.length === 0 && hasInstallLifecycleScript(args.checkoutDir)) {
      return declined("install-lifecycle-script", { subject: e.name });
    }
    const inputs = resolveDepsHashInputs(
      [command],
      e.installInputs.length > 0 ? e.installInputs : null,
    );
    if (inputs === null) return declined("unrecognized-install", { subject: e.name, detail: command });
    const hash = computeDepsHash(args.checkoutDir, inputs);
    if (hash === null) return declined("no-input-files", { subject: e.name });
    parts.push([e.name, command, hash]);
  }

  const depDirs: string[] = [];
  for (const e of installers) {
    for (const dir of e.depDirs) {
      if (!depDirs.includes(dir)) depDirs.push(dir);
    }
  }
  if (depDirs.length === 0) return declined("no-dep-dirs");
  // A store hit skips install and clears the upper, so preserve ShipIt's downloaded tools too.
  depDirs.push(PLUGIN_TOOLCHAIN_DIR_NAME);
  const tracked = depDirs.find((dir) => fs.existsSync(path.join(args.checkoutDir, dir)));
  if (tracked !== undefined) return declined("tracked-dep-dir", { subject: tracked });

  const depsKey = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return {
    plan: {
      depsKey,
      installCommands: installers.map((e) => e.install.trim()),
      dirs: depDirs.map((depDir) => {
        const scope = pluginDepScope(args.source, depsKey, depDir, env);
        return { depDir, scope, scopeHash: overlayScopeHash(scope.repoUrl, scope.runtimeKey, scope.depDir) };
      }),
    },
  };
}

function declined(
  kind: PluginDepStoreReasonKind,
  rest: Omit<PluginDepStoreReason, "kind"> = {},
): PluginDepStoreDecision {
  return { plan: null, reason: { kind, ...rest } };
}

// A hit skips the entire install, so every declared directory must be available.
export function adoptPluginDepBases(depStoreDir: string, plan: PluginDepPlan): string[] | null {
  const pins: string[] = [];
  for (const dir of plan.dirs) {
    const pointer = readBasePointerByHash(depStoreDir, dir.scopeHash);
    if (!pointer) return null;
    if (!fs.existsSync(overlayBaseGenDir(depStoreDir, dir.scopeHash, pointer.generation))) return null;
    pins.push(pluginBasePin(dir.scopeHash, pointer.generation));
  }
  return pins;
}

// Cold installs have no lower dep tree; the upper therefore contains the complete promotable tree.
export async function promotePluginDepDirs(args: {
  depStoreDir: string;
  plan: PluginDepPlan;
  commit: string;
  upperDir: string;
  repoName: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginDepPromotion[]> {
  const env = args.env ?? process.env;
  const results: PluginDepPromotion[] = [];
  for (const dir of args.plan.dirs) {
    const source = path.join(args.upperDir, dir.depDir);
    const kept = (reason: PluginDepStoreReason): PluginDepPromotion => {
      const lost = !fs.existsSync(source);
      return { depDir: dir.depDir, pin: null, lost, ...(lost ? {} : { reason }) };
    };

    let stat: Stats;
    try {
      stat = await fsp.lstat(source);
    } catch {
      results.push({
        depDir: dir.depDir,
        pin: null,
        lost: false,
        reason: { kind: "nothing-installed", subject: dir.depDir },
      });
      continue;
    }
    if (!stat.isDirectory()) {
      results.push({
        depDir: dir.depDir,
        pin: null,
        lost: false,
        reason: { kind: "not-a-directory", subject: dir.depDir },
      });
      continue;
    }

    try {
      // Protect against GC until activation writes the generation record that pins this base.
      claimPluginBaseScope(dir.scopeHash);
      dropStalePointer(args.depStoreDir, dir.scopeHash);
      const result = await publishBase({
        stateDir: args.depStoreDir,
        scope: dir.scope,
        candidate: {
          commit: args.commit,
          exitCode: 0,
          preUserInstall: true,
          sourceIsDefaultBranch: true,
          snapshotDir: source,
          markerStamp: {
            runtimeKey: overlayRuntimeKey(env),
            installCommands: args.plan.installCommands,
            depsHash: args.plan.depsKey,
          },
        },
        // An existing content-addressed scope already holds the exact dependency state.
        isAncestor: async () => false,
        materialize: (snapshotDir, scopeHash, generation) =>
          moveIntoBase(args.depStoreDir, snapshotDir, scopeHash, generation, dir.depDir),
        // Copy-up preserves ownership and mode; all session identities need write access.
        chownBaseDir: shareTreeWithAllSessions,
      });

      const pointer = result.pointer;
      const genDir = pointer
        ? overlayBaseGenDir(args.depStoreDir, dir.scopeHash, pointer.generation)
        : null;
      if (!pointer || !genDir || !fs.existsSync(genDir)) {
        results.push(kept({
          kind: "publish-failed",
          subject: dir.depDir,
          detail: `the store did not take it (${result.outcome})`,
        }));
        continue;
      }
      if (result.outcome !== "created") {
        await fsp.rm(source, { recursive: true, force: true });
      }
      results.push({
        depDir: dir.depDir,
        pin: pluginBasePin(dir.scopeHash, pointer.generation),
        lost: false,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[plugins] ${args.repoName}: could not share \`${dir.depDir}\` with other sessions:`,
        detail,
      );
      results.push(kept({ kind: "publish-failed", subject: dir.depDir, detail }));
    }
  }
  return results;
}

// Activation writes pins after promotion returns; claims cover that gap without a cross-module lease.
const IN_FLIGHT_CLAIM_MS = 10 * 60_000;
const inFlightScopes = new Map<string, number>();

function claimPluginBaseScope(scopeHash: string): void {
  inFlightScopes.set(scopeHash, Date.now() + IN_FLIGHT_CLAIM_MS);
}

export function clearPluginBaseClaims(): void {
  inFlightScopes.clear();
}

function liveInFlightScopes(): string[] {
  const now = Date.now();
  for (const [scopeHash, expiry] of inFlightScopes) {
    if (expiry <= now) inFlightScopes.delete(scopeHash);
  }
  return [...inFlightScopes.keys()];
}

// Otherwise publishBase skips the equal commit forever while adoption rejects its missing tree.
function dropStalePointer(depStoreDir: string, scopeHash: string): void {
  const pointer = readBasePointerByHash(depStoreDir, scopeHash);
  if (!pointer) return;
  if (fs.existsSync(overlayBaseGenDir(depStoreDir, scopeHash, pointer.generation))) return;
  fs.rmSync(path.join(depStoreDir, OVERLAY_POINTER_SUBDIR, `${scopeHash}.json`), { force: true });
}

// Nest depDir under the base because this lowerdir is mounted at the plugin root.
// Stage under .tmp-* so GC and readers cannot observe a half-built generation.
async function moveIntoBase(
  depStoreDir: string,
  snapshotDir: string,
  scopeHash: string,
  generation: number,
  depDir: string,
): Promise<string> {
  const genDir = overlayBaseGenDir(depStoreDir, scopeHash, generation);
  const scopeDir = path.dirname(genDir);
  await fsp.mkdir(scopeDir, { recursive: true });
  const tmp = path.join(scopeDir, `.tmp-g${generation}-${crypto.randomBytes(4).toString("hex")}`);
  const target = path.join(tmp, depDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  let moved = false;
  try {
    try {
      await fsp.rename(snapshotDir, target);
      moved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fsp.cp(snapshotDir, target, { recursive: true, verbatimSymlinks: true });
      await fsp.rm(snapshotDir, { recursive: true, force: true });
      moved = true;
    }
    await fsp.rm(genDir, { recursive: true, force: true });
    await fsp.rename(tmp, genDir);
  } catch (err) {
    if (moved) await fsp.rename(target, snapshotDir).catch(() => undefined);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  shareWithAllSessions(scopeDir);
  shareWithAllSessions(genDir);
  return genDir;
}

export function pluginDepCacheDir(depStoreDir: string, source: string): string {
  return path.join(depStoreDir, "dep-cache", repoUrlToHash(`plugin:${source}`));
}

// Existing pins need protection even with the store disabled, including leased older generations.
export async function livePluginStoreArtifacts(
  sessions: readonly SessionInfo[],
): Promise<{ scopeHashes: Set<string>; cacheHashes: Set<string> }> {
  const scopeHashes = new Set<string>(liveInFlightScopes());
  const cacheHashes = new Set<string>();
  for (const session of sessions) {
    if (!session.workspaceDir) continue;
    if (session.diskTier === "evicted") continue;

    // Declarations preserve clone-URL case and protect caches before the first generation exists.
    try {
      for (const repo of resolveShipitConfig(session.workspaceDir).plugins.repos) {
        if (repo.source.kind === "self") continue;
        cacheHashes.add(repoUrlToHash(pluginCloneUrl(repo.source)));
        cacheHashes.add(path.basename(pluginDepCacheDir("", destinationKey(repo.source))));
      }
    } catch {
      // Generation records below can still protect bases.
    }

    let root: string;
    try {
      root = pluginsRoot(sessionStateDirForWorkspace(session.workspaceDir));
    } catch {
      continue;
    }
    for (const repoName of await listDirs(root)) {
      const generations = path.join(root, repoName, "generations");
      for (const generationId of await listDirs(generations)) {
        const record = readGenerationRecordAt(path.join(generations, generationId));
        if (!record) continue;
        for (const pin of record.basePins ?? []) {
          const parsed = parsePluginBasePin(pin);
          if (parsed) scopeHashes.add(parsed.scopeHash);
        }
        if (typeof record.source === "string" && record.source) {
          cacheHashes.add(path.basename(pluginDepCacheDir("", record.source)));
        }
      }
    }
  }
  return { scopeHashes, cacheHashes };
}

// Propagate read errors so GC skips the pass instead of treating unreadable pins as absent.
async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}
