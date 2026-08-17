/**
 * Marketplace + plugin install service (docs/149 — skill install UX).
 *
 * Pure functions over the catalog cache on disk + the `MarketplaceStore`.
 * Consumed by the marketplace HTTP routes and (in future) any WS handler
 * that wants live install progress.
 *
 * v1 scope:
 *   - Pre-seeded official Claude and Codex catalogs.
 *   - Discover lists plugins whose `marketplace.json` source is an in-repo
 *     relative path AND that contain at least one `skills/<name>/SKILL.md`.
 *     External plugins (git URL sources) are visible in the upstream CLI but
 *     not installable from ShipIt in v1 — deferred to v2.
 *   - Install writes `<agent skills dir>/skills/<plugin>__<skill>/SKILL.md` + an
 *     install marker (`.shipit-installed.json`) and auto-commits with a
 *     path-scoped `git add` so unrelated working-tree edits stay out.
 *   - Per-workspace install mutex serializes install↔install AND
 *     install↔post-turn-commit on the same workspace.
 *
 * v0 spike note (Claude): verified empirically against Claude CLI 2.1.140
 * that the flat `<plugin>__<skill>/` directory layout with frontmatter
 * `name: <plugin>:<skill>` resolves `/<plugin>:<skill>` correctly.
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import { resolveGitTreeUid } from "../../shared/git-tree-uid.js";
import type { GitManager } from "../../shared/git.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { frontmatterField, scanSkillsDir } from "../../shared/skill-scan.js";
import type {
  AgentId,
  InstallMarker,
  InstallResult,
  MarketplaceInfo,
  MarketplaceSource,
  PluginInfo,
  SkillRef,
} from "../../shared/types.js";
import type { MarketplaceStore } from "../marketplace-store.js";
import { ServiceError } from "./types.js";

/** Sentinel file written into every ShipIt-managed skill directory. */
export const INSTALL_MARKER_FILENAME = ".shipit-installed.json";

/** Frontmatter regex used by skill-scan; mirrored here so we can parse plugin SKILL.md. */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Per-workspace install mutex (runtime state only — NOT persisted). Serializes
 * concurrent installs on the same workspace AND coordinates with the post-turn
 * commit path. `postTurnCommit()` takes this same map to avoid a race window
 * where its `git add -A` runs simultaneously with an install's path-scoped
 * `git add`. Same shape as `_mcpInstallMutex` in `session-worker.ts:133`.
 *
 * Surviving a process restart with a lock held would be a bug, so this lives
 * in the service module and not in any SQLite store.
 */
const _workspaceMutex = new Map<string, Promise<unknown>>();

export function withWorkspaceLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = _workspaceMutex.get(workspaceDir);
  const chained = async (): Promise<T> => {
    if (prior) {
      try { await prior; } catch { /* prior failure must not block the next op */ }
    }
    return fn();
  };
  const run = chained().finally(() => {
    if (_workspaceMutex.get(workspaceDir) === run) {
      _workspaceMutex.delete(workspaceDir);
    }
  });
  _workspaceMutex.set(workspaceDir, run);
  return run;
}

// ---- Catalog cache directory layout ----

/** Resolve a catalog id's on-disk cache dir under `<stateDir>/marketplace-cache/`. */
export function getCatalogCacheRoot(stateDir: string): string {
  return path.join(stateDir, "marketplace-cache");
}

export function getCatalogCacheDir(stateDir: string, marketplaceId: string): string {
  return path.join(getCatalogCacheRoot(stateDir), marketplaceId);
}

// ---- Catalog fetch ----

/**
 * Ensure the catalog cache for `id` is present on disk, cloning it on first
 * use. Updates the store's status row. Returns the path to the catalog repo.
 *
 * v1 only handles `kind: "github"` and `kind: "git"` sources (the official
 * Claude catalog is a `github` source). Other source kinds throw a clear
 * error so adding them later (v2's add-marketplace verb) surfaces here, not
 * silently in the UI.
 *
 * ## Two failures this must not turn into a dead end (planning#418)
 *
 * The Discover tab's only recovery affordance is a Retry button that re-enters
 * here, so anything this function cannot recover from is permanent for the user
 * — the skill browser stays a red row with no catalog behind it, and §1 says
 * they do not have a shell on the orchestrator volume to go fix it by hand.
 * Both halves below exist for that reason.
 *
 *   - **The existing clone is unusable.** Observed in the wild as `error:
 *     insufficient permission for adding an object to repository database
 *     .git/objects` — a `.git` the git process cannot write, which every
 *     subsequent `git fetch` in that same directory reproduces exactly. A
 *     catalog cache is disposable, so a failed update REBUILDS it (a fresh
 *     clone into a sibling, renamed into place) rather than retrying the
 *     operation that cannot succeed. The swap needs write permission on
 *     `cacheRoot` only, never on the tree being replaced, which is what lets it
 *     recover from a clone dir this process cannot touch at all.
 *
 *     Note "the git process", not "the orchestrator": under docs/266 the two
 *     are not the same uid. `safeSimpleGit(cacheDir)` resolves a drop from the
 *     TOP-LEVEL tree, so a cache root owned by a non-root uid makes even a root
 *     orchestrator run git as that uid, against a `.git/objects` a root-era
 *     fetch left root-owned. The rebuild cures that for good: a fresh clone is
 *     uniformly owned, so the resolver and the objects dir stop disagreeing.
 *     {@link describeCacheOwnership} logs the pair so a recurrence says so.
 *   - **The remote is unreachable.** A network blip must not blank a catalog
 *     that is sitting readable on disk. When both the update and the rebuild
 *     fail but the cached manifest still parses, the row is marked
 *     `fetch-failed` (so the Retry chip and the reason stay visible) and the
 *     STALE cache is returned, so the plugin list still renders. Only a cache
 *     with nothing usable in it throws.
 */
export async function ensureCatalogCloned(
  store: MarketplaceStore,
  marketplaceId: string,
  cacheRoot: string,
): Promise<string> {
  const info = store.get(marketplaceId);
  if (!info) throw new ServiceError(404, `Unknown marketplace: ${marketplaceId}`);
  return withCatalogLock(path.join(cacheRoot, marketplaceId), () =>
    ensureCatalogClonedLocked(store, marketplaceId, cacheRoot, info));
}

async function ensureCatalogClonedLocked(
  store: MarketplaceStore,
  marketplaceId: string,
  cacheRoot: string,
  info: MarketplaceInfo,
): Promise<string> {
  const url = sourceToGitUrl(info.source);
  const ref = sourceToRef(info.source);
  const cacheDir = path.join(cacheRoot, marketplaceId);

  const markOk = (): void => {
    store.setFetchStatus(marketplaceId, "ok", {
      lastFetchedAt: new Date().toISOString(),
      fetchError: null,
    });
  };

  // A pre-populated cache directory that isn't a git repo (test fixtures,
  // or an admin-placed catalog) is treated as authoritative — we don't
  // re-fetch over it. The presence of a marketplace manifest is the signal.
  const hasGit = await pathExists(path.join(cacheDir, ".git"));
  if (!hasGit && await findMarketplaceManifestPath(cacheDir) !== null) {
    markOk();
    return cacheDir;
  }

  if (hasGit) {
    try {
      await updateCatalogClone(cacheDir, ref);
      markOk();
      return cacheDir;
    } catch (err) {
      const updateError = (err as Error).message;
      console.warn(
        `[marketplace] update failed for ${marketplaceId} (${describeCacheOwnership(cacheDir)}); `
          + "rebuilding the cache:",
        updateError,
      );
      try {
        await rebuildCatalogClone({ cacheRoot, marketplaceId, cacheDir, url, ref });
        markOk();
        return cacheDir;
      } catch (rebuildErr) {
        const msg = `${updateError} (rebuilding the cache also failed: ${(rebuildErr as Error).message})`;
        store.setFetchStatus(marketplaceId, "fetch-failed", { fetchError: msg });
        // Serve what is on disk rather than nothing — the row already carries
        // the reason, so the failure is reported without costing the user the
        // catalog they could otherwise still browse. The manifest has to PARSE,
        // not merely exist: returning a cache `listPlugins` will throw 500 on
        // would rebuild the same dead end one layer up, and the client hides
        // that 500 behind the fetch-failed row (`SkillsTab.tsx`).
        if (await catalogIsReadable(cacheDir)) return cacheDir;
        throw new ServiceError(502, `Failed to fetch marketplace ${marketplaceId}: ${msg}`);
      }
    }
  }

  try {
    await fs.mkdir(cacheRoot, { recursive: true });
    await cloneCatalog(url, cacheDir, ref);
    markOk();
    return cacheDir;
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(
      `[marketplace] first clone failed for ${marketplaceId} (${describeCacheOwnership(cacheDir)}):`,
      msg,
    );
    store.setFetchStatus(marketplaceId, "fetch-failed", { fetchError: msg });
    throw new ServiceError(502, `Failed to fetch marketplace ${marketplaceId}: ${msg}`);
  }
}

/**
 * Per-catalog serialization for {@link ensureCatalogCloned}.
 *
 * Not optional once a rebuild exists. Two callers reach the same catalog id
 * concurrently in normal operation: the boot pre-clone in `route-registry.ts`
 * fires one `void ensureCatalogCloned(...)` per marketplace in a single tick,
 * and the Discover / Retry routes call in on demand. Unserialized, a rebuild is
 * actively destructive rather than merely wasteful — `sweepRebuildLeftovers`
 * deletes `<id>.rebuild-*`, so one caller's sweep removes another's staging
 * clone mid-flight, and the window between the two renames leaves `cacheDir`
 * absent, which sends a concurrent caller down the first-clone path (a full
 * clone racing the rename) or makes it throw a spurious 502 over a cache that is
 * healthy a moment later. Last-writer-wins on `setFetchStatus` then leaves the
 * row disagreeing with the disk.
 *
 * Keyed by cache DIRECTORY, not by marketplace id, so two cache roots (the
 * tests, and a future second state dir) never serialize against each other.
 * Runtime state only — a lock surviving a process restart would be a bug — and
 * the same shape as {@link withWorkspaceLock} above.
 */
const _catalogMutex = new Map<string, Promise<unknown>>();

function withCatalogLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = _catalogMutex.get(cacheDir);
  const chained = async (): Promise<T> => {
    if (prior) {
      try { await prior; } catch { /* prior failure must not block the next op */ }
    }
    return fn();
  };
  const run = chained().finally(() => {
    if (_catalogMutex.get(cacheDir) === run) _catalogMutex.delete(cacheDir);
  });
  _catalogMutex.set(cacheDir, run);
  return run;
}

/** Does the cached catalog still parse? The predicate for serving a stale copy. */
async function catalogIsReadable(cacheDir: string): Promise<boolean> {
  try {
    await readMarketplaceManifest(cacheDir);
    return true;
  } catch {
    return false;
  }
}

/** Bring an existing catalog clone up to date, in place. */
async function updateCatalogClone(cacheDir: string, ref: string | undefined): Promise<void> {
  const git = safeSimpleGit(cacheDir);
  await git.fetch("origin");
  if (ref) {
    await git.checkout(ref);
    await git.pull("origin", ref).catch(() => undefined);
  } else {
    // Default branch — try main, then master.
    await git.pull("origin").catch(() => undefined);
  }
}

/**
 * Shallow-clone a catalog into `destDir`.
 *
 * The ONE bare `safeSimpleGit()` in this file (censused by
 * `git-hooks-guard-coverage.test.ts`): there is no local source tree whose uid
 * could be resolved, and the destination is ShipIt's own root-owned
 * `<stateDir>/marketplace-cache`, a sibling of `sessions/` and not under it —
 * so no ownership handoff is owed. Kept as one call site so both the first
 * clone and a rebuild share it and the census stays at one.
 */
async function cloneCatalog(url: string, destDir: string, ref: string | undefined): Promise<void> {
  const git = safeSimpleGit();
  const cloneArgs = ["--depth", "1"];
  if (ref) cloneArgs.push("--branch", ref);
  await git.clone(url, destDir, cloneArgs);
}

/**
 * Replace a catalog cache that can no longer be updated with a fresh clone.
 *
 * Ordered so the working cache is never destroyed on speculation: clone FIRST
 * into a staging sibling, and only once that succeeds rename the old tree aside
 * and the new one into place. A rebuild that fails for any reason (offline,
 * bad ref, unwritable `cacheRoot`) leaves the existing cache exactly as it was.
 */
async function rebuildCatalogClone(opts: {
  cacheRoot: string;
  marketplaceId: string;
  cacheDir: string;
  url: string;
  ref: string | undefined;
}): Promise<void> {
  const { cacheRoot, marketplaceId, cacheDir, url, ref } = opts;
  await fs.mkdir(cacheRoot, { recursive: true });
  await sweepRebuildLeftovers(cacheRoot, marketplaceId);

  const suffix = crypto.randomBytes(4).toString("hex");
  const stagingDir = path.join(cacheRoot, `${marketplaceId}.rebuild-${suffix}`);
  const staleDir = path.join(cacheRoot, `${marketplaceId}.stale-${suffix}`);

  try {
    await cloneCatalog(url, stagingDir, ref);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // Both renames touch directory entries in `cacheRoot` and nothing inside the
  // trees, so this works even when the tree being replaced is one we cannot
  // open for writing — which is the whole point of the rebuild.
  try {
    await fs.rename(cacheDir, staleDir);
  } catch (err) {
    // A denial at the `cacheRoot` level lands here, with a complete fresh clone
    // already on disk. Drop it now rather than leaving it for the next
    // rebuild's sweep — a permanent denial means every Retry arrives here.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  try {
    await fs.rename(stagingDir, cacheDir);
  } catch (err) {
    await fs.rename(staleDir, cacheDir).catch(() => undefined);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // Best effort by necessity: the tree we just replaced may be precisely the one
  // whose files cannot be unlinked. Anything left behind is swept by the next
  // rebuild — and the rebuild it followed leaves a cache that updates in place
  // again, so this costs one directory per incident rather than one per fetch.
  await fs.rm(staleDir, { recursive: true, force: true }).catch(() => {
    console.warn(
      `[marketplace] could not remove the replaced cache at ${staleDir} — it will be swept on the next rebuild`,
    );
  });
}

/** Drop staging/stale directories a previous rebuild could not clean up. */
async function sweepRebuildLeftovers(cacheRoot: string, marketplaceId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(cacheRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${marketplaceId}.rebuild-`) && !name.startsWith(`${marketplaceId}.stale-`)) continue;
    await fs.rm(path.join(cacheRoot, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Everything that decides whether a write into `.git/objects` is permitted —
 * the fact a permission failure does NOT carry, and one that otherwise takes
 * shell access to the orchestrator volume to reconstruct.
 *
 * It reports THREE directories, not one, because the interesting failure is a
 * disagreement between them. `resolveGitTreeUid` (docs/266) stats only the
 * top-level tree, so a cache whose checkout root is owned by a non-root uid
 * makes even a ROOT orchestrator's git drop to that uid — and it then meets a
 * `.git/objects` a later root-era fetch left root-owned. That produces exactly
 * `insufficient permission for adding an object to repository database
 * .git/objects` from a root process, which is otherwise impossible and was the
 * mechanism this bug's write-up first ruled out. Logging only the process uid
 * and the top-level dir cannot show it; logging the uid the resolver actually
 * chose, beside all three trees, names it outright.
 */
function describeCacheOwnership(cacheDir: string): string {
  const resolved = resolveGitTreeUid(cacheDir);
  return [
    `pid uid=${process.getuid?.() ?? "?"} gid=${process.getgid?.() ?? "?"}`,
    `git runs as ${resolved === null ? "this process" : `uid=${resolved.uid} gid=${resolved.gid}`}`,
    `. ${statLabel(cacheDir)}`,
    `.git ${statLabel(path.join(cacheDir, ".git"))}`,
    `.git/objects ${statLabel(path.join(cacheDir, ".git", "objects"))}`,
  ].join(", ");
}

function statLabel(p: string): string {
  try {
    const st = fsSync.statSync(p);
    return `uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o7777).toString(8)}`;
  } catch {
    return "absent";
  }
}

function sourceToGitUrl(source: MarketplaceSource): string {
  switch (source.kind) {
    case "github": return `https://github.com/${source.ownerRepo}.git`;
    case "git": return source.url;
    case "url": return source.url;
    case "local":
      throw new ServiceError(400, "Local marketplaces are deferred to v2");
  }
}

function sourceToRef(source: MarketplaceSource): string | undefined {
  if (source.kind === "github" || source.kind === "git") return source.ref;
  return undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- Marketplace listing (passthrough to the store) ----

export function listMarketplaces(
  store: MarketplaceStore,
  agentId?: AgentId,
): MarketplaceInfo[] {
  return store.list(agentId);
}

// ---- Plugin listing ----

interface RawMarketplaceManifest {
  name?: string;
  plugins?: RawMarketplacePlugin[];
}

interface RawMarketplacePlugin {
  name?: string;
  description?: string;
  category?: string;
  homepage?: string;
  author?: { name?: string };
  interface?: {
    displayName?: string;
    shortDescription?: string;
    developerName?: string;
    category?: string;
    websiteURL?: string;
  };
  source?:
    | string
    | { source?: string; url?: string; path?: string; ref?: string; sha?: string };
}

interface RawPluginManifest {
  name?: string;
  description?: string;
  homepage?: string;
  author?: { name?: string };
  interface?: {
    shortDescription?: string;
    developerName?: string;
    category?: string;
    websiteURL?: string;
  };
}

/**
 * List installable plugins from a (pre-fetched) catalog cache. v1 only
 * surfaces in-repo plugins (`source` is a relative path string) that have at
 * least one `skills/<name>/SKILL.md` — those are installable as a simple file
 * copy. External plugins ("url" / "git-subdir") are filtered out for v1.
 *
 * The catalog must already be on disk; call `ensureCatalogCloned()` first.
 */
export async function listPlugins(
  store: MarketplaceStore,
  marketplaceId: string,
  cacheRoot: string,
): Promise<PluginInfo[]> {
  const info = store.get(marketplaceId);
  if (!info) throw new ServiceError(404, `Unknown marketplace: ${marketplaceId}`);
  const cacheDir = path.join(cacheRoot, marketplaceId);
  const manifest = await readMarketplaceManifest(cacheDir);

  const out: PluginInfo[] = [];
  for (const raw of manifest.plugins ?? []) {
    if (!raw.name) continue;
    const inRepoPath = inRepoSourcePath(raw.source);
    if (!inRepoPath) continue;
    const pluginRoot = path.join(cacheDir, inRepoPath);
    const skills = await readPluginSkills(pluginRoot);
    if (skills.length === 0) continue;
    const estimatedContextBytes = await estimatePluginContextBytes(pluginRoot, skills);
    const pluginManifest = await readPluginManifest(pluginRoot);
    const author = raw.author?.name ?? pluginManifest?.author?.name ?? pluginManifest?.interface?.developerName;
    const pinnedSha = typeof raw.source === "object" && raw.source?.sha ? raw.source.sha : undefined;
    out.push({
      marketplaceId,
      name: raw.name,
      ...(raw.description ?? raw.interface?.shortDescription ?? pluginManifest?.description ?? pluginManifest?.interface?.shortDescription
        ? { description: raw.description ?? raw.interface?.shortDescription ?? pluginManifest?.description ?? pluginManifest?.interface?.shortDescription }
        : {}),
      ...(author !== undefined ? { author } : {}),
      ...(raw.category ?? raw.interface?.category ?? pluginManifest?.interface?.category
        ? { category: raw.category ?? raw.interface?.category ?? pluginManifest?.interface?.category }
        : {}),
      ...(raw.homepage ?? raw.interface?.websiteURL ?? pluginManifest?.homepage ?? pluginManifest?.interface?.websiteURL
        ? { homepage: raw.homepage ?? raw.interface?.websiteURL ?? pluginManifest?.homepage ?? pluginManifest?.interface?.websiteURL }
        : {}),
      skills,
      estimatedContextBytes,
      ...(pinnedSha !== undefined ? { pinnedSha } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Read a plugin's `SKILL.md` body — used by the install sheet's Monaco preview. */
export async function readPluginSkillBody(
  store: MarketplaceStore,
  marketplaceId: string,
  cacheRoot: string,
  pluginName: string,
  skillName: string,
): Promise<string> {
  const info = store.get(marketplaceId);
  if (!info) throw new ServiceError(404, `Unknown marketplace: ${marketplaceId}`);
  const cacheDir = path.join(cacheRoot, marketplaceId);
  const manifest = await readMarketplaceManifest(cacheDir);
  const raw = (manifest.plugins ?? []).find((p) => p.name === pluginName);
  if (!raw) throw new ServiceError(404, `Plugin not found: ${pluginName}`);
  const inRepoPath = inRepoSourcePath(raw.source);
  if (!inRepoPath) throw new ServiceError(400, `Plugin ${pluginName} is external — not previewable in v1`);
  const pluginRoot = path.join(cacheDir, inRepoPath);
  // The URL parameter is the *invocable* name (frontmatter `name:`), which may
  // differ from the source directory — look it up via the scan so we read the
  // right SKILL.md file off disk.
  const skills = await readPluginSkills(pluginRoot);
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) throw new ServiceError(404, `Skill not found: ${pluginName}/${skillName}`);
  const skillFile = path.join(pluginRoot, "skills", skillSrcDirName(skill), "SKILL.md");
  try {
    return await fs.readFile(skillFile, "utf-8");
  } catch {
    throw new ServiceError(404, `Skill not found: ${pluginName}/${skillName}`);
  }
}

async function readMarketplaceManifest(cacheDir: string): Promise<RawMarketplaceManifest> {
  const manifestPath = await findMarketplaceManifestPath(cacheDir);
  if (!manifestPath) {
    throw new ServiceError(500, "Failed to read marketplace manifest: marketplace.json not found");
  }
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as RawMarketplaceManifest;
  } catch (err) {
    throw new ServiceError(500, `Failed to read marketplace manifest: ${(err as Error).message}`);
  }
}

async function findMarketplaceManifestPath(cacheDir: string): Promise<string | null> {
  const candidates = [
    // Claude Code marketplace repos.
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
    // Codex repo/personal marketplace layout.
    path.join(cacheDir, ".agents", "plugins", "marketplace.json"),
    // Local marketplace roots may put the file at the root.
    path.join(cacheDir, "marketplace.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function readPluginManifest(pluginRoot: string): Promise<RawPluginManifest | null> {
  const candidates = [
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf-8");
      return JSON.parse(raw) as RawPluginManifest;
    } catch {
      // Optional metadata only; listing can proceed from marketplace fields.
    }
  }
  return null;
}

/** Return the in-repo relative path if the plugin source is a string like "./plugins/foo". */
function inRepoSourcePath(source: RawMarketplacePlugin["source"]): string | null {
  const rawPath = typeof source === "string"
    ? source
    : source?.source === "local" && typeof source.path === "string"
      ? source.path
      : null;
  if (!rawPath) return null;
  const trimmed = rawPath.replace(/^\.\//, "");
  if (trimmed.startsWith("/") || trimmed.startsWith("..")) return null;
  return trimmed;
}

async function readPluginSkills(pluginRoot: string): Promise<SkillRef[]> {
  const skillsDir = path.join(pluginRoot, "skills");
  const entries = await scanSkillsDir(skillsDir, "project");
  return entries.map((s) => {
    const ref: SkillRef = { name: s.name };
    if (s.dirName !== undefined) ref.dirName = s.dirName;
    if (s.description !== undefined) ref.description = s.description;
    return ref;
  });
}

/** Source directory name for a SkillRef inside its plugin's `skills/` folder. */
function skillSrcDirName(skill: SkillRef): string {
  return skill.dirName ?? skill.name;
}

async function estimatePluginContextBytes(
  pluginRoot: string,
  skills: SkillRef[],
): Promise<number> {
  let total = 0;
  for (const s of skills) {
    try {
      const stat = await fs.stat(path.join(pluginRoot, "skills", skillSrcDirName(s), "SKILL.md"));
      total += stat.size;
    } catch {
      // Skip skills we can't stat — the listing already gates on the file existing.
    }
  }
  return total;
}

// ---- Install / uninstall ----

/**
 * Compose the destination directory name for a plugin/skill on disk. v1 uses
 * a flat layout (`<plugin>__<skill>/`) so the existing `scanSkillsDir()`
 * picks it up unchanged.
 */
export function targetSkillDirName(pluginName: string, skillName: string): string {
  return `${pluginName}__${skillName}`;
}

/**
 * Workspace skills root for an agent — `.claude/skills/` on Claude and the
 * configured project skill directory for Codex. The dotfolder name comes from
 * `AgentCapabilities.skillsDirName`; adding a backend means one entry in
 * `AGENT_DEFS`, not a new branch here. Falls back to `.claude` if the
 * registry doesn't know the agent (defensive; should not happen in normal
 * runtime). (docs/155)
 */
export function skillsRootFor(
  workspaceDir: string,
  agentId: AgentId,
  agentRegistry: AgentRegistry,
): string {
  const skillsDirName = agentRegistry.get(agentId)?.capabilities.skillsDirName ?? ".claude";
  return path.join(workspaceDir, skillsDirName, "skills");
}

/**
 * Token the user types in chat to invoke an installed skill — `/foo:bar` on
 * Claude, `$foo:bar` on Codex. Prefix comes from
 * `AgentCapabilities.skillInvocationPrefix`. (docs/155)
 */
function invocationToken(
  agentId: AgentId,
  pluginName: string,
  skillName: string,
  agentRegistry: AgentRegistry,
): string {
  const prefix = agentRegistry.get(agentId)?.capabilities.skillInvocationPrefix ?? "/";
  return `${prefix}${pluginName}:${skillName}`;
}

/** sha256 hex of a file's contents, used for the install marker's `skillMdHash`. */
function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Install a plugin's skills into `<workspaceDir>/<agentSkillsDir>/`. Each skill
 * lands as `<plugin>__<skill>/SKILL.md` plus a `.shipit-installed.json` marker.
 * Rewrites the SKILL.md frontmatter `name` to `<plugin>:<skill>` so the agent
 * invokes the skill under the catalog's namespace (verified for Claude per the
 * v0 spike; the colon is honored by the CLI on a raw filesystem scan).
 *
 * Refuses if any target directory already exists WITHOUT a marker (hand-written
 * collision) or with a marker whose recorded `skillMdHash` no longer matches the
 * on-disk SKILL.md (user edited it after install — upgrade would silently lose
 * their work).
 *
 * Auto-commits via a path-scoped `git add` (NOT `git add -A`) so unrelated
 * working-tree edits stay out of the install commit.
 *
 * Caller MUST already hold `withWorkspaceLock(workspaceDir, ...)`.
 */
export async function installPlugin(opts: {
  workspaceDir: string;
  agentId: AgentId;
  marketplaceId: string;
  pluginName: string;
  cacheRoot: string;
  store: MarketplaceStore;
  git: GitManager;
  agentRegistry: AgentRegistry;
}): Promise<InstallResult> {
  const { workspaceDir, agentId, marketplaceId, pluginName, cacheRoot, store, git, agentRegistry } = opts;
  const info = store.get(marketplaceId);
  if (!info) throw new ServiceError(404, `Unknown marketplace: ${marketplaceId}`);
  const cacheDir = path.join(cacheRoot, marketplaceId);
  const manifest = await readMarketplaceManifest(cacheDir);
  const raw = (manifest.plugins ?? []).find((p) => p.name === pluginName);
  if (!raw) throw new ServiceError(404, `Plugin not found: ${pluginName}`);
  const inRepoPath = inRepoSourcePath(raw.source);
  if (!inRepoPath) throw new ServiceError(400, `Plugin ${pluginName} is external — install deferred to v2`);
  const pluginRoot = path.join(cacheDir, inRepoPath);
  const skills = await readPluginSkills(pluginRoot);
  if (skills.length === 0) throw new ServiceError(400, `Plugin ${pluginName} has no skills`);

  const skillsRoot = skillsRootFor(workspaceDir, agentId, agentRegistry);
  await fs.mkdir(skillsRoot, { recursive: true });

  const pinnedSha = typeof raw.source === "object" && raw.source?.sha ? raw.source.sha : "head";
  const installedAt = new Date().toISOString();
  const installedDirs: string[] = [];
  const writtenPaths: string[] = [];
  const invocationTokens: string[] = [];

  // Pre-flight: refuse on any collision so we don't half-install.
  for (const skill of skills) {
    const targetName = targetSkillDirName(pluginName, skill.name);
    const targetDir = path.join(skillsRoot, targetName);
    await assertSafeToWrite(targetDir);
  }

  for (const skill of skills) {
    const targetName = targetSkillDirName(pluginName, skill.name);
    const targetDir = path.join(skillsRoot, targetName);
    await fs.mkdir(targetDir, { recursive: true });

    const srcSkillMd = path.join(pluginRoot, "skills", skillSrcDirName(skill), "SKILL.md");
    const body = await fs.readFile(srcSkillMd, "utf-8");
    const rewritten = rewriteFrontmatterName(body, `${pluginName}:${skill.name}`);
    const targetSkillMd = path.join(targetDir, "SKILL.md");
    await fs.writeFile(targetSkillMd, rewritten, "utf-8");

    const marker: InstallMarker = {
      marketplaceId,
      pluginName,
      version: pinnedSha,
      installedAt,
      skillMdHash: sha256(rewritten),
    };
    await fs.writeFile(
      path.join(targetDir, INSTALL_MARKER_FILENAME),
      `${JSON.stringify(marker, null, 2)}\n`,
      "utf-8",
    );
    installedDirs.push(targetDir);
    writtenPaths.push(
      path.relative(workspaceDir, targetSkillMd),
      path.relative(workspaceDir, path.join(targetDir, INSTALL_MARKER_FILENAME)),
    );
    invocationTokens.push(invocationToken(agentId, pluginName, skill.name, agentRegistry));
  }

  const message = installedDirs.length === 1
    ? `Install ${pluginName}/${skills[0].name} skill from ${marketplaceId}`
    : `Install ${pluginName} (${skills.length} skills) from ${marketplaceId}`;
  const commitHash = await git.commitPaths(writtenPaths, message);

  return { installedDirs, commitHash, invocationTokens };
}

/**
 * Refuse to write into a target directory unless it doesn't exist at all.
 *
 * v1 takes the strict line: refuse on ANY existing directory (managed or not).
 * Upgrades are deferred until the install sheet supports the diff view (v3/v4).
 * Hand-written skills surface a clear collision error rather than being
 * silently overwritten.
 */
async function assertSafeToWrite(targetDir: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(targetDir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    throw new ServiceError(409, `Cannot install over file: ${targetDir}`);
  }
  // Distinguish managed vs hand-written for a clearer error message.
  const markerPath = path.join(targetDir, INSTALL_MARKER_FILENAME);
  try {
    await fs.access(markerPath);
    throw new ServiceError(
      409,
      `Already installed: ${path.basename(targetDir)}. Uninstall first to reinstall.`,
    );
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(
      409,
      `Skill directory already exists and is not ShipIt-managed: ${path.basename(targetDir)}. ` +
        "Rename or remove it before installing.",
    );
  }
}

/** Rewrite the `name:` field inside a SKILL.md frontmatter block. */
export function rewriteFrontmatterName(body: string, newName: string): string {
  const match = FRONTMATTER_RE.exec(body);
  if (!match) {
    // No frontmatter — prepend one so the agent sees a valid `name`.
    return `---\nname: ${newName}\n---\n\n${body}`;
  }
  const original = match[1];
  const hasName = /^name:\s*.+$/m.test(original);
  const replaced = hasName
    ? original.replace(/^name:\s*.+$/m, `name: ${newName}`)
    : `name: ${newName}\n${original}`;
  return body.replace(match[0], `---\n${replaced}\n---`);
}

// Uninstall is intentionally NOT a ShipIt feature (docs/149, 2026-06-09):
// removing a marketplace skill is just "delete the `<plugin>__<skill>/`
// directory and commit it" — a plain agent task under CLAUDE.md §5 ("chat is
// the input surface, the agent is the actor"). The user asks the agent to
// remove a skill rather than pressing a dedicated button, so there's no
// uninstall service, route, or installed-scan here. Install keeps its UI
// because it adds real value the agent can't replicate cheaply: catalog
// discovery, preview-before-consent, and the namespaced flat-dir write.

// ---- Helpers exported for tests ----

export const _internals = {
  FRONTMATTER_RE,
  inRepoSourcePath,
  rewriteFrontmatterName,
  sha256,
  frontmatterField,
};
