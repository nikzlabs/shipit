// Expose links, skills and broker wrappers. Plugin install code must run in its own container.

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGINS_DIR, CONTAINER_PLUGIN_STORE_DIR } from "../shared/fs-constants.js";
import { readPluginGenerationSource } from "../shared/plugin-generation-record.js";
import { destinationKey, type DeclaredPluginRepo } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "../shared/utils.js";
import { ensureGitExcludedBlock } from "../shared/git.js";
import { preparePluginCommands, type PluginCommandIssue } from "./plugin-cli.js";
import {
  materializePluginSkills,
  planPluginSkills,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  sweepStalePluginSkills,
  PLUGIN_SKILL_EXCLUDE_BLOCK,
  type PluginSkillFailure,
} from "./plugin-skills.js";

export interface PluginPrepareResult {
  linked: string[];
  missing: string[];
  unlinked: string[];
  linkFailed: { repo: string; reason: string }[];
  skills: string[];
  skillsRemoved: string[];
  skillsFailed: PluginSkillFailure[];
  commands: string[];
  commandsRemoved: string[];
  commandsRefused: PluginCommandIssue[];
  commandsFailed: PluginCommandIssue[];
}

export interface PreparePluginsOptions {
  workspaceDir: string;
  pluginsDir?: string;
  storeDir?: string;
  binDir?: string;
  shimPath?: string;
}

export function preparePlugins(opts: PreparePluginsOptions): PluginPrepareResult {
  const pluginsDir = opts.pluginsDir ?? CONTAINER_PLUGINS_DIR;
  const storeDir = opts.storeDir ?? CONTAINER_PLUGIN_STORE_DIR;
  const result: PluginPrepareResult = {
    linked: [], missing: [], unlinked: [], linkFailed: [],
    skills: [], skillsRemoved: [], skillsFailed: [],
    commands: [], commandsRemoved: [], commandsRefused: [], commandsFailed: [],
  };

  const config = resolveShipitConfig(opts.workspaceDir);
  const wanted = new Set<string>();

  // Resolve and verify once per pass so skills and commands read the same generation.
  const live = new Map<string, LiveGeneration>();
  const resolve = (repo: DeclaredPluginRepo): LiveGeneration => {
    if (!live.has(repo.name)) live.set(repo.name, resolveLiveCheckout(opts.workspaceDir, storeDir, repo));
    return live.get(repo.name)!;
  };
  const liveDir = (repo: DeclaredPluginRepo): string | null => resolve(repo).dir;

  for (const repo of config.plugins.repos) {
    // Self uses the workspace; omit it from wanted to withdraw any former tracked link.
    if (repo.source.kind === "self") continue;
    wanted.add(repo.name);

    const target = path.join(storeDir, repo.name, "active");
    const generation = resolve(repo);
    if (generation.dir === null) {
      result.missing.push(repo.name);
      if (generation.refusal) {
        result.linkFailed.push({ repo: repo.name, reason: generation.refusal });
      }
      // The name is still declared, so the stale-link sweep cannot withdraw this refused tree.
      const withdrawal = removeDeadLink(pluginsDir, repo.name, target);
      if (withdrawal) result.linkFailed.push({ repo: repo.name, reason: withdrawal });
      continue;
    }
    const failure = linkPlugin(pluginsDir, repo.name, target);
    if (failure) result.linkFailed.push({ repo: repo.name, reason: failure });
    else result.linked.push(repo.name);
  }

  result.unlinked.push(...removeStaleLinks(pluginsDir, wanted));

  const declaredRepos = new Map(config.plugins.repos.map((r) => [r.name.toLowerCase(), r]));
  const sources = resolvePluginSkillSources(
    config.plugins.uses,
    (repoName) => {
      const declared = declaredRepos.get(repoName.toLowerCase());
      if (!declared) return null;
      const dir = liveDir(declared);
      return dir ? { dir, repo: declared.name } : null;
    },
  );

  const plan = planPluginSkills(sources);
  result.skillsFailed.push(...plan.failed);
  const names = plan.planned.map((p) => p.name);

  // Sweep, update exclusions, then copy: auto-commit must never see unexcluded copies.
  result.skillsRemoved.push(...sweepStalePluginSkills(opts.workspaceDir, new Set(names)));

  const excluded = !isGitRepo(opts.workspaceDir)
    || ensureGitExcludedBlock(
      opts.workspaceDir,
      PLUGIN_SKILL_EXCLUDE_BLOCK,
      pluginSkillExcludeEntries(names),
    );

  if (!excluded) {
    for (const repo of new Set(plan.planned.map((p) => p.repo))) {
      result.skillsFailed.push({
        repo,
        skill: "(all)",
        reason: "could not keep plugin skills out of this clone's git, so none were materialized",
      });
    }
  } else {
    const skills = materializePluginSkills(opts.workspaceDir, plan.planned);
    result.skills.push(...skills.materialized);
    result.skillsFailed.push(...skills.failed);
  }

  // Wrappers live outside the workspace and do not depend on git exclusions.
  const commands = preparePluginCommands({
    workspaceDir: opts.workspaceDir,
    plugins: config.plugins,
    selfExports: config.pluginExports,
    checkoutFor: liveDir,
    ...(opts.binDir ? { binDir: opts.binDir } : {}),
    ...(opts.shimPath ? { shimPath: opts.shimPath } : {}),
  });
  result.commands.push(...commands.commands);
  result.commandsRemoved.push(...commands.removed);
  result.commandsRefused.push(...commands.refused);
  result.commandsFailed.push(...commands.failed);

  return result;
}

interface LiveGeneration {
  dir: string | null;
  /** Present for a refused generation, absent when nothing is published. */
  refusal?: string;
}

function resolveLiveCheckout(
  workspaceDir: string,
  storeDir: string,
  repo: DeclaredPluginRepo,
): LiveGeneration {
  if (repo.source.kind === "self") return { dir: workspaceDir };
  return resolveLiveGeneration(storeDir, repo);
}

function resolveLiveGeneration(storeDir: string, repo: DeclaredPluginRepo): LiveGeneration {
  let dir: string;
  try {
    dir = fs.realpathSync(path.join(storeDir, repo.name, "active"));
  } catch {
    return { dir: null };
  }
  // Read the resolved generation's record. Pruning may still remove that directory mid-pass.
  const source = readPluginGenerationSource(dir);
  if (source === destinationKey(repo.source)) return { dir };
  return {
    dir: null,
    refusal: source === null
      ? "the version on disk predates ShipIt recording which repository a version came from, so it cannot be"
        + " confirmed as this repository's. The next successful activation replaces it."
      : `the version on disk was published from \`${source}\`, which this declaration no longer names.`
        + " The next successful activation replaces it.",
  };
}

function isGitRepo(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, ".git"));
}

function removeStaleLinks(pluginsDir: string, wanted: Set<string>): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || wanted.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(pluginsDir, entry.name));
      removed.push(entry.name);
    } catch (err) {
      console.warn(`[plugins] could not unlink ${entry.name}: ${getErrorMessage(err)}`);
    }
  }
  return removed;
}

function removeDeadLink(pluginsDir: string, name: string, target: string): string | null {
  const link = path.join(pluginsDir, name);
  let current: string;
  try {
    current = fs.readlinkSync(link);
  } catch {
    return null;
  }
  if (current !== target) return null;
  try {
    fs.unlinkSync(link);
    return null;
  } catch (err) {
    const reason = getErrorMessage(err);
    console.warn(`[plugins] could not withdraw ${link}: ${reason}`);
    return `\`${link}\` could not be removed and still points at a version this session may not use: ${reason}`;
  }
}

// Link through active so generation changes become visible without remounting.
function linkPlugin(pluginsDir: string, name: string, target: string): string | null {
  const link = path.join(pluginsDir, name);
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
    let current: string | null = null;
    try {
      current = fs.readlinkSync(link);
    } catch {
      current = null;
    }
    if (current === target) return null;
    if (current !== null) fs.unlinkSync(link);
    else if (fs.existsSync(link)) return `\`${link}\` already exists and is not a link ShipIt made`;
    fs.symlinkSync(target, link);
    return null;
  } catch (err) {
    const reason = getErrorMessage(err);
    console.warn(`[plugins] could not link ${link}: ${reason}`);
    return reason;
  }
}
