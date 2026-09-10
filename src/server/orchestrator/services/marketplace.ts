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

export const INSTALL_MARKER_FILENAME = ".shipit-installed.json";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

// Shared with post-turn commits so their staging cannot race an install commit.
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

export function getCatalogCacheRoot(stateDir: string): string {
  return path.join(stateDir, "marketplace-cache");
}

/** Rebuild failed updates; if both attempts fail, keep serving a readable stale cache. */
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

  // A supplied manifest without a git repository is authoritative.
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
        // Require a parseable manifest; existence alone can defer the failure to listing.
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

// Serialize rebuilds so one caller cannot sweep another's staging directory.
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

async function catalogIsReadable(cacheDir: string): Promise<boolean> {
  try {
    await readMarketplaceManifest(cacheDir);
    return true;
  } catch {
    return false;
  }
}

async function updateCatalogClone(cacheDir: string, ref: string | undefined): Promise<void> {
  const git = safeSimpleGit(cacheDir);
  await git.fetch("origin");
  if (ref) {
    await git.checkout(ref);
    await git.pull("origin", ref).catch(() => undefined);
  } else {
    await git.pull("origin").catch(() => undefined);
  }
}

// No source-tree UID exists yet; the catalog destination belongs to the orchestrator.
async function cloneCatalog(url: string, destDir: string, ref: string | undefined): Promise<void> {
  const git = safeSimpleGit();
  const cloneArgs = ["--depth", "1"];
  if (ref) cloneArgs.push("--branch", ref);
  await git.clone(url, destDir, cloneArgs);
}

/** Clone before moving the old cache; attempt rollback if the replacement rename fails. */
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

  // Renames need cacheRoot access, without write access inside the old tree.
  try {
    await fs.rename(cacheDir, staleDir);
  } catch (err) {
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

  await fs.rm(staleDir, { recursive: true, force: true }).catch(() => {
    console.warn(
      `[marketplace] could not remove the replaced cache at ${staleDir} — it will be swept on the next rebuild`,
    );
  });
}

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

/** Compare the effective git UID with nested owners to expose mixed-ownership failures. */
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

export function listMarketplaces(
  store: MarketplaceStore,
  agentId?: AgentId,
): MarketplaceInfo[] {
  return store.list(agentId);
}

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

/** Requires a fetched catalog. Only local sources with skills are installable here. */
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
  // The invocable name can differ from the source directory name.
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
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
    path.join(cacheDir, ".agents", "plugins", "marketplace.json"),
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
      // Omit unreadable sizes from the estimate.
    }
  }
  return total;
}

// The flat layout is discoverable by scanSkillsDir.
export function targetSkillDirName(pluginName: string, skillName: string): string {
  return `${pluginName}__${skillName}`;
}

export function skillsRootFor(
  workspaceDir: string,
  agentId: AgentId,
  agentRegistry: AgentRegistry,
): string {
  const skillsDirName = agentRegistry.get(agentId)?.capabilities.skillsDirName ?? ".claude";
  return path.join(workspaceDir, skillsDirName, "skills");
}

function invocationToken(
  agentId: AgentId,
  pluginName: string,
  skillName: string,
  agentRegistry: AgentRegistry,
): string {
  const prefix = agentRegistry.get(agentId)?.capabilities.skillInvocationPrefix ?? "/";
  return `${prefix}${pluginName}:${skillName}`;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Caller must hold withWorkspaceLock; commit only installed paths to exclude unrelated edits. */
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

  // Check every collision before writing the first skill.
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

export function rewriteFrontmatterName(body: string, newName: string): string {
  const match = FRONTMATTER_RE.exec(body);
  if (!match) {
    return `---\nname: ${newName}\n---\n\n${body}`;
  }
  const original = match[1];
  const hasName = /^name:\s*.+$/m.test(original);
  const replaced = hasName
    ? original.replace(/^name:\s*.+$/m, `name: ${newName}`)
    : `name: ${newName}\n${original}`;
  return body.replace(match[0], `---\n${replaced}\n---`);
}

export const _internals = {
  FRONTMATTER_RE,
  inRepoSourcePath,
  rewriteFrontmatterName,
  sha256,
  frontmatterField,
};
