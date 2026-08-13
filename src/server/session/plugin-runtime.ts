/**
 * docs/262 — the container half of plugin activation (plan §2): make each live
 * plugin checkout reachable at `/plugins/<name>`.
 *
 * That is ALL this module does, and the boundary is deliberate. An earlier
 * revision also ran each plugin's `install` here, reasoning that it would then
 * hold no more authority than `agent.install`. That was wrong twice over:
 * `agent.install` is the project's OWN command while a plugin's install string
 * comes from a third-party repository, and this container can reach the
 * worker's LOOPBACK credential broker (`/agent-ops/*`, no token required) to
 * obtain a real GitHub token — so req 19 cannot hold for anything running here.
 * Install now runs in its own container against an overlay volume (plan §1b).
 *
 * It also materializes each imported plugin's skills into the workspace skill
 * roots (req 22) — see `plugin-skills.ts`. That is still no plugin-authored
 * code: it copies markdown the agent reads, and runs nothing from the checkout.
 *
 * The declaration is readable at `/workspace/shipit.yaml`, so the orchestrator
 * only has to say *when*, never *what*.
 */

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGINS_DIR, CONTAINER_PLUGIN_STORE_DIR } from "../shared/fs-constants.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "../shared/utils.js";
import { ensureGitExcludedBlock } from "../shared/git.js";
import {
  materializePluginSkills,
  planPluginSkills,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  sweepStalePluginSkills,
  PLUGIN_SKILL_EXCLUDE_BLOCK,
} from "./plugin-skills.js";

export interface PluginPrepareResult {
  /** Repos that got a `/plugins/<name>` entry. */
  linked: string[];
  /** Declared but with no live generation yet — activation may still be running. */
  missing: string[];
  /** Links removed because the declaration no longer names that repo. */
  unlinked: string[];
  /** Namespaced skill directories written into each harness's discovery root (req 22). */
  skills: string[];
  /** Materialized skills removed because the declaration no longer imports them. */
  skillsRemoved: string[];
  /** Skills that could not be written — reported, never fatal. */
  skillsFailed: { skill: string; reason: string }[];
}

export interface PreparePluginsOptions {
  workspaceDir: string;
  pluginsDir?: string;
  storeDir?: string;
}

/**
 * Make every live plugin checkout reachable at `/plugins/<name>`, and remove
 * links the declaration no longer names. Idempotent, so it is safe on every
 * activation round and on every container start.
 *
 * Never throws — a repo that cannot be linked is reported, not fatal (req 13:
 * the session opens either way).
 */
export function preparePlugins(opts: PreparePluginsOptions): PluginPrepareResult {
  const pluginsDir = opts.pluginsDir ?? CONTAINER_PLUGINS_DIR;
  const storeDir = opts.storeDir ?? CONTAINER_PLUGIN_STORE_DIR;
  const result: PluginPrepareResult = {
    linked: [], missing: [], unlinked: [], skills: [], skillsRemoved: [], skillsFailed: [],
  };

  const config = resolveShipitConfig(opts.workspaceDir);
  const wanted = new Set<string>();

  for (const repo of config.plugins.repos) {
    // `repo: self` runs the live working tree and has no generation (req 27);
    // its consumer-path parity is its own piece of work.
    if (repo.source.kind === "self") continue;
    wanted.add(repo.name);

    const target = path.join(storeDir, repo.name, "active");
    if (!fs.existsSync(target)) {
      result.missing.push(repo.name);
      continue;
    }
    if (linkPlugin(pluginsDir, repo.name, target)) result.linked.push(repo.name);
  }

  // A repo dropped from the declaration must stop being addressable — including
  // when the block is emptied entirely, which is why this runs even when
  // nothing is declared.
  result.unlinked.push(...removeStaleLinks(pluginsDir, wanted));

  // req 22 — a checkout discloses nothing on its own, so each imported plugin's
  // skills are copied into every harness's discovery root. Same lifecycle as
  // the links: idempotent, and re-run on every activation round, which is what
  // makes a refresh take effect. Kept out of the user's repository by a
  // per-clone git exclude rather than by editing their `.gitignore`.
  // `from:` matches a declared repo case-insensitively (`plugin-repos.ts`), but
  // the checkout directory is named with the declaration's own spelling — so
  // resolve through the declaration rather than trusting the `use` entry's
  // case, which silently found nothing on a case-sensitive filesystem (review
  // finding).
  const declaredNames = new Map(config.plugins.repos.map((r) => [r.name.toLowerCase(), r.name]));
  const sources = resolvePluginSkillSources(
    config.plugins.uses,
    (repoName) => {
      const declared = declaredNames.get(repoName.toLowerCase());
      if (!declared) return null;
      const active = path.join(storeDir, declared, "active");
      return fs.existsSync(active) ? active : null;
    },
  );

  const plan = planPluginSkills(sources);
  result.skillsFailed.push(...plan.failed);
  const names = plan.planned.map((p) => p.name);

  // Order is load-bearing, in three steps.
  //
  // 1. SWEEP FIRST. The exclude lists exact directories, so narrowing it while
  //    a dropped skill still exists on disk opens a window where a concurrent
  //    `git add -A` stages it (review finding). Remove, then stop excluding.
  result.skillsRemoved.push(...sweepStalePluginSkills(opts.workspaceDir, new Set(names)));

  // 2. Rewrite the exclude block — ALWAYS, including to nothing. Skipping the
  //    rewrite when there is nothing planned left every old exclusion installed
  //    forever, where it could later hide a directory the user created with the
  //    same name (review finding).
  const excluded = !isGitRepo(opts.workspaceDir)
    || ensureGitExcludedBlock(
      opts.workspaceDir,
      PLUGIN_SKILL_EXCLUDE_BLOCK,
      pluginSkillExcludeEntries(names),
    );

  // 3. Only then write. Fail closed: if the exclude is not in force,
  //    materializing would put a copy of somebody else's repository into the
  //    user's next commit, which is the one thing req 22 rules out.
  if (!excluded) {
    result.skillsFailed.push({
      skill: "(all)",
      reason: "could not keep plugin skills out of this clone's git, so none were materialized",
    });
  } else {
    const skills = materializePluginSkills(opts.workspaceDir, plan.planned);
    result.skills.push(...skills.materialized);
    result.skillsFailed.push(...skills.failed);
  }

  return result;
}

/**
 * Whether this workspace is a git clone at all. A standalone session with no
 * repository has no commit to pollute, so the exclude is moot there — and
 * refusing to materialize would deny it skills for a reason that does not
 * apply.
 */
function isGitRepo(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, ".git"));
}

/**
 * Drop `/plugins/<name>` entries this session no longer declares. Only symlinks
 * are removed: anything else under that path was not created here.
 */
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

/**
 * Point `/plugins/<name>` at the read-only store. The link target is a path
 * that only exists inside this container, and BOTH hops resolve per access —
 * this symlink, then the store's own `active` symlink — so activating a new
 * generation on the host is visible here immediately, with no remount and no
 * container recreation (plan §2).
 */
function linkPlugin(pluginsDir: string, name: string, target: string): boolean {
  const link = path.join(pluginsDir, name);
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
    // Replace only what we own. An existing correct link is left alone so a
    // re-prepare mid-turn never briefly breaks a path the agent is using.
    let current: string | null = null;
    try {
      current = fs.readlinkSync(link);
    } catch {
      current = null;
    }
    if (current === target) return true;
    if (current !== null) fs.unlinkSync(link);
    else if (fs.existsSync(link)) return false; // a real file/dir — refuse to clobber
    fs.symlinkSync(target, link);
    return true;
  } catch (err) {
    console.warn(`[plugins] could not link ${link}: ${getErrorMessage(err)}`);
    return false;
  }
}
