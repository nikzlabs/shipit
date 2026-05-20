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
import type { AgentId, SkillInfo } from "../../shared/types.js";
import { scanSkillsDir } from "../../shared/skill-scan.js";

/**
 * List user-invocable project skills for the active agent, sorted by name.
 * Returns `[]` when the workspace has no skills directory for that backend.
 */
export async function listSkills(dir: string, agentId: AgentId): Promise<SkillInfo[]> {
  const skillsDir = agentId === "codex"
    ? path.join(dir, ".codex", "skills")
    : path.join(dir, ".claude", "skills");
  const skills = await scanSkillsDir(skillsDir, "project");
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
