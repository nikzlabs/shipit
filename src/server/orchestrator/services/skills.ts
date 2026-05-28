/**
 * Skill discovery service — scans a workspace for user-invocable skills so the
 * composer's `/` autocomplete can list them. See docs/138-skill-invocation.
 *
 * Project skills are per-backend, but laid out identically:
 *   - Claude: `.claude/skills/<name>/SKILL.md`
 *   - Codex:  `.codex/skills/<name>/SKILL.md`
 * Both carry `name` / `description` frontmatter and may opt out of invocation
 * with `user-invocable: false`, so a single directory scanner handles both.
 * (Codex's deprecated `.codex/prompts/*.md` custom prompts are intentionally
 * NOT scanned — they don't expand headless; Codex uses Agent Skills now.)
 *
 * This service only scans skills that live under the bind-mounted workspace,
 * which is host-visible to the orchestrator. Codex's built-in system skills
 * live at `~/.codex/skills/**` *inside the container* and are surfaced via a
 * session-worker endpoint, then merged in by the route (`source: "bundled"`).
 */

import path from "node:path";
import type { SkillInfo } from "../../shared/types.js";
import { scanSkillsDir } from "../../shared/skill-scan.js";

/**
 * List user-invocable project skills for the active agent, sorted by name.
 * Returns `[]` when the workspace has no skills directory for that backend.
 *
 * The dotfolder name (`.claude` vs `.codex`) is the agent's
 * `AgentCapabilities.skillsDirName` — keeping it as a string parameter (not a
 * registry lookup) so tests can call this directly without standing up a fake
 * registry. Adding a backend with its own convention (e.g. `.cursor`) means
 * one new entry in `AGENT_DEFS`, no change here. (docs/155)
 */
export async function listSkills(
  dir: string,
  skillsDirName: string,
): Promise<SkillInfo[]> {
  const skillsDir = path.join(dir, skillsDirName, "skills");
  const skills = await scanSkillsDir(skillsDir, "project");
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
