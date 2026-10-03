// Gets an orchestrator git step past ShipIt's own plugin-skill copies, and puts them back
// (docs/262-plugins/plan.md, "Git steps across a skills root that changes shape").

import fs from "node:fs";
import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import { ownedPluginSkillDirs, pluginSkillOwnership } from "../../shared/plugin-skill-copies.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { getErrorMessage } from "../validation.js";
import { isUntrackedFilesRefusal } from "./git.js";

// A concurrent /plugins/prepare pass can re-create a copy between the sweep and the retry.
const PLUGIN_SKILL_CLEAR_ROUNDS = 2;

/**
 * Git 2.39 (the orchestrator image's) will not replace a skills root that holds ShipIt's
 * plugin-skill copies, which are ignored but still untracked. They are cleared only once git
 * has refused, and `gitStep` then runs again, so it must leave nothing behind when it is
 * refused. The caller prepares the copies again afterwards.
 */
export async function retryClearingPluginSkills<T>(
  git: GitManager,
  workspaceDir: string,
  gitStep: () => Promise<T>,
): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await gitStep();
    } catch (err) {
      if (round >= PLUGIN_SKILL_CLEAR_ROUNDS || !isUntrackedFilesRefusal(getErrorMessage(err))) throw err;
      if ((await removePluginSkillCopies(git, workspaceDir)) === 0) throw err;
    }
  }
}

// Only what the marker claims, git does not track, and resolves inside the workspace.
async function removePluginSkillCopies(git: GitManager, workspaceDir: string): Promise<number> {
  let workspace: string;
  let copies: string[];
  let tracked: string[];
  try {
    workspace = fs.realpathSync(workspaceDir);
    const rels = ownedPluginSkillDirs(workspaceDir, new Set()).map(({ dir }) => containedRealRel(workspace, dir));
    copies = [...new Set(rels.filter((rel): rel is string => rel !== null))];
    tracked = await git.trackedFilesUnder(copies);
  } catch (err) {
    console.warn("[plugin-skills] could not list plugin skill copies:", getErrorMessage(err));
    return 0;
  }
  let removed = 0;
  for (const rel of copies) {
    if (tracked.some((file) => file.startsWith(`${rel}/`))) continue;
    const dir = path.join(workspace, ...rel.split("/"));
    // Re-checked after the await: a symlink retargeted meanwhile must not redirect the delete.
    if (containedRealRel(workspace, dir) !== rel || pluginSkillOwnership(dir) !== "ours") continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn(`[plugin-skills] could not remove plugin skill copy ${rel}:`, getErrorMessage(err));
    }
  }
  return removed;
}

function containedRealRel(workspace: string, dir: string): string | null {
  try {
    const rel = path.relative(workspace, fs.realpathSync(dir));
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  } catch {
    return null;
  }
}

/** Taken before the git step: our sweep removes them where git 2.39 refuses, and newer git deletes them itself. */
export function presentPluginSkillCopies(workspaceDir: string): string[] {
  return ownedPluginSkillDirs(workspaceDir, new Set())
    .filter((copy) => !copy.staging)
    .map((copy) => copy.dir);
}

export function pluginSkillCopiesGone(before: readonly string[]): boolean {
  return before.some((dir) => !fs.existsSync(dir));
}

// Bounded: a worker that never became ready would otherwise hold the session for ever.
export const PLUGIN_SKILL_RESTORE_WAIT_MS = 45_000;

export async function restorePluginSkills(
  runner: Pick<SessionRunnerInterface, "preparePlugins"> | null | undefined,
): Promise<void> {
  const prepare = runner?.preparePlugins?.().catch((err: unknown) => {
    console.error("[plugin-skills] re-preparing plugin skills failed:", getErrorMessage(err));
  });
  if (!prepare) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    prepare,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, PLUGIN_SKILL_RESTORE_WAIT_MS); }),
  ]);
  clearTimeout(timer);
}
