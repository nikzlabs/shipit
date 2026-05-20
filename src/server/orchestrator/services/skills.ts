/**
 * Skill discovery service — scans a workspace for user-invocable skills/prompts
 * so the composer's `/` autocomplete can list them. See docs/138-skill-invocation.
 *
 * Project skills are per-backend:
 *   - Claude: `.claude/skills/<name>/SKILL.md` (frontmatter: name, description,
 *     user-invocable).
 *   - Codex:  `.codex/prompts/<name>.md` (the filename is the invocation token;
 *     optional frontmatter `description`).
 *
 * Bundled skills (the backend's built-ins like `/loop`, `/simplify`) are NOT
 * scanned here — they come from the per-backend capabilities map (doc 132) and
 * are layered in by the route once that set exists.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { AgentId, SkillInfo } from "../../shared/types.js";

/** Frontmatter regex — matches `---\n...\n---` at the start of a file. */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/** Pull a single-line `key: value` out of a frontmatter block. */
function frontmatterField(fm: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  if (!m) return undefined;
  // Strip surrounding quotes the way YAML would.
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  return raw.length > 0 ? raw : undefined;
}

/** Read the first 1 KB of a file (enough for frontmatter), tolerating ENOENT. */
async function sniff(fullPath: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(fullPath, "r");
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(buf, 0, 1024, 0);
      return buf.toString("utf-8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Scan Claude project skills: `.claude/skills/<name>/SKILL.md`. */
async function scanClaudeSkills(dir: string): Promise<SkillInfo[]> {
  const skillsDir = path.join(dir, ".claude", "skills");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const content = await sniff(path.join(skillsDir, entry.name, "SKILL.md"));
    if (content === undefined) continue;

    const fm = FRONTMATTER_RE.exec(content)?.[1];
    // A skill is invocable unless it explicitly opts out with
    // `user-invocable: false`. Absent frontmatter still counts (the directory
    // exists, so the CLI will resolve `/<dir-name>`).
    if (fm && frontmatterField(fm, "user-invocable") === "false") continue;

    skills.push({
      name: fm ? frontmatterField(fm, "name") ?? entry.name : entry.name,
      description: fm ? frontmatterField(fm, "description") : undefined,
      source: "project",
    });
  }
  return skills;
}

/** Scan Codex project prompts: `.codex/prompts/<name>.md`. */
async function scanCodexPrompts(dir: string): Promise<SkillInfo[]> {
  const promptsDir = path.join(dir, ".codex", "prompts");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(promptsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = await sniff(path.join(promptsDir, entry.name));
    const fm = content ? FRONTMATTER_RE.exec(content)?.[1] : undefined;
    skills.push({
      name: entry.name.slice(0, -".md".length),
      description: fm ? frontmatterField(fm, "description") : undefined,
      source: "project",
    });
  }
  return skills;
}

/**
 * List user-invocable project skills for the active agent, sorted by name.
 * Returns `[]` when the workspace has no skills directory for that backend.
 */
export async function listSkills(dir: string, agentId: AgentId): Promise<SkillInfo[]> {
  const skills = agentId === "codex"
    ? await scanCodexPrompts(dir)
    : await scanClaudeSkills(dir);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
