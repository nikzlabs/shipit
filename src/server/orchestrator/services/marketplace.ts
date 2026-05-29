/**
 * Marketplace + plugin install service (docs/149 — skill install UX).
 *
 * Pure functions over the catalog cache on disk + the `MarketplaceStore`.
 * Consumed by the marketplace HTTP routes and (in future) any WS handler
 * that wants live install progress.
 *
 * v1 scope:
 *   - One pre-seeded official Claude catalog (`claude-plugins-official`).
 *   - Discover lists plugins whose `marketplace.json` source is an in-repo
 *     relative path AND that contain at least one `skills/<name>/SKILL.md`.
 *     External plugins (git URL sources) are visible in the upstream CLI but
 *     not installable from ShipIt in v1 — deferred to v2.
 *   - Install writes `.claude/skills/<plugin>__<skill>/SKILL.md` + an
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
import fs from "node:fs/promises";
import path from "node:path";
import simpleGit from "simple-git";
import type { GitManager } from "../../shared/git.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { frontmatterField, scanSkillsDir } from "../../shared/skill-scan.js";
import type {
  AgentId,
  InstallMarker,
  InstallResult,
  InstalledPluginInfo,
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
 */
export async function ensureCatalogCloned(
  store: MarketplaceStore,
  marketplaceId: string,
  cacheRoot: string,
): Promise<string> {
  const info = store.get(marketplaceId);
  if (!info) throw new ServiceError(404, `Unknown marketplace: ${marketplaceId}`);

  const url = sourceToGitUrl(info.source);
  const ref = sourceToRef(info.source);
  const cacheDir = path.join(cacheRoot, marketplaceId);

  // A pre-populated cache directory that isn't a git repo (test fixtures,
  // or an admin-placed catalog) is treated as authoritative — we don't
  // re-fetch over it. The presence of `marketplace.json` is the signal.
  const hasGit = await pathExists(path.join(cacheDir, ".git"));
  const hasManifest = await pathExists(
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
  );
  if (!hasGit && hasManifest) {
    store.setFetchStatus(marketplaceId, "ok", {
      lastFetchedAt: new Date().toISOString(),
      fetchError: null,
    });
    return cacheDir;
  }

  const alreadyCloned = hasGit;
  try {
    if (alreadyCloned) {
      const git = simpleGit(cacheDir);
      await git.fetch("origin");
      if (ref) {
        await git.checkout(ref);
        await git.pull("origin", ref).catch(() => undefined);
      } else {
        // Default branch — try main, then master.
        await git.pull("origin").catch(() => undefined);
      }
    } else {
      await fs.mkdir(cacheRoot, { recursive: true });
      const git = simpleGit();
      const cloneArgs = ["--depth", "1"];
      if (ref) cloneArgs.push("--branch", ref);
      await git.clone(url, cacheDir, cloneArgs);
    }
    store.setFetchStatus(marketplaceId, "ok", {
      lastFetchedAt: new Date().toISOString(),
      fetchError: null,
    });
    return cacheDir;
  } catch (err) {
    const msg = (err as Error).message;
    store.setFetchStatus(marketplaceId, "fetch-failed", { fetchError: msg });
    throw new ServiceError(502, `Failed to fetch marketplace ${marketplaceId}: ${msg}`);
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
  source?:
    | string
    | { source?: string; url?: string; path?: string; ref?: string; sha?: string };
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
    const author = raw.author?.name;
    const pinnedSha = typeof raw.source === "object" && raw.source?.sha ? raw.source.sha : undefined;
    out.push({
      marketplaceId,
      name: raw.name,
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(raw.category !== undefined ? { category: raw.category } : {}),
      ...(raw.homepage !== undefined ? { homepage: raw.homepage } : {}),
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
  const manifestPath = path.join(cacheDir, ".claude-plugin", "marketplace.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as RawMarketplaceManifest;
  } catch (err) {
    throw new ServiceError(500, `Failed to read marketplace manifest: ${(err as Error).message}`);
  }
}

/** Return the in-repo relative path if the plugin source is a string like "./plugins/foo". */
function inRepoSourcePath(source: RawMarketplacePlugin["source"]): string | null {
  if (typeof source !== "string") return null;
  const trimmed = source.replace(/^\.\//, "");
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
 * Workspace skills root for an agent — `.claude/skills/` on Claude,
 * `.codex/skills/` on Codex. The dotfolder name comes from
 * `AgentCapabilities.skillsDirName`; adding a backend means one entry in
 * `AGENT_DEFS`, not a new branch here. Falls back to `.claude` if the
 * registry doesn't know the agent (defensive; should not happen in normal
 * runtime). (Codex install is v1b — see plan.) (docs/155)
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
  // eslint-disable-next-line no-restricted-syntax -- docs/155 hair 7: v1 marketplace install gates Claude only. Becomes a capability flag (`supportsMarketplaceInstall`) once Codex install (v1b) lands; deliberately not pre-generalized.
  if (agentId !== "claude") {
    throw new ServiceError(400, "v1 only supports Claude installs (Codex is v1b)");
  }
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

/**
 * Uninstall a plugin: remove every `<plugin>__<skill>/` directory whose marker
 * matches the given `marketplaceId` + `pluginName`. Refuses to touch
 * directories without a marker (hand-written) or with a different plugin's
 * marker. Auto-commits the removal with a path-scoped `git add`.
 *
 * Caller MUST already hold `withWorkspaceLock(workspaceDir, ...)`.
 */
export async function uninstallPlugin(opts: {
  workspaceDir: string;
  agentId: AgentId;
  marketplaceId: string;
  pluginName: string;
  git: GitManager;
  agentRegistry: AgentRegistry;
}): Promise<{ removed: string[]; commitHash: string | null }> {
  const { workspaceDir, agentId, marketplaceId, pluginName, git, agentRegistry } = opts;
  const installed = await scanInstalledPlugins(workspaceDir, agentId, agentRegistry);
  const matching = installed.filter(
    (p) => p.marketplaceId === marketplaceId && p.pluginName === pluginName,
  );
  if (matching.length === 0) {
    throw new ServiceError(404, `No installed plugin ${pluginName} from ${marketplaceId}`);
  }

  const removedPaths: string[] = [];
  for (const entry of matching) {
    await fs.rm(entry.directory, { recursive: true, force: true });
    removedPaths.push(path.relative(workspaceDir, entry.directory));
  }

  const commitHash = await git.commitPaths(
    removedPaths,
    `Uninstall ${pluginName} from ${marketplaceId}`,
  );
  return { removed: removedPaths, commitHash };
}

// ---- Installed listing ----

/**
 * Scan `<workspaceDir>/<agentSkillsDir>/` for ShipIt-managed installs (those
 * carrying a `.shipit-installed.json` marker). Hand-written skills without a
 * marker are intentionally excluded — they're already surfaced in the
 * composer's `/`-autocomplete (doc 138).
 */
export async function scanInstalledPlugins(
  workspaceDir: string,
  agentId: AgentId,
  agentRegistry: AgentRegistry,
): Promise<InstalledPluginInfo[]> {
  const skillsRoot = skillsRootFor(workspaceDir, agentId, agentRegistry);
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledPluginInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsRoot, entry.name);
    const markerPath = path.join(dir, INSTALL_MARKER_FILENAME);
    let marker: InstallMarker | null = null;
    try {
      marker = JSON.parse(await fs.readFile(markerPath, "utf-8")) as InstallMarker;
    } catch {
      continue;
    }
    // Skill name is the part after `__` in the directory name. If we ever
    // change the delimiter, also update `targetSkillDirName()` above.
    const sep = entry.name.indexOf("__");
    const skillName = sep >= 0 ? entry.name.slice(sep + 2) : entry.name;
    out.push({
      marketplaceId: marker.marketplaceId,
      pluginName: marker.pluginName,
      skillName,
      version: marker.version,
      installedAt: marker.installedAt,
      directory: dir,
    });
  }
  out.sort((a, b) => {
    const byPlugin = a.pluginName.localeCompare(b.pluginName);
    return byPlugin !== 0 ? byPlugin : a.skillName.localeCompare(b.skillName);
  });
  return out;
}

// ---- Helpers exported for tests ----

export const _internals = {
  FRONTMATTER_RE,
  inRepoSourcePath,
  rewriteFrontmatterName,
  sha256,
  frontmatterField,
};
