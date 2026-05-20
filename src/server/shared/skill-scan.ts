/**
 * Shared skill-directory scanner. Both Claude (`.claude/skills/<name>/SKILL.md`)
 * and Codex (`.codex/skills/<name>/SKILL.md`, plus Codex's built-in
 * `~/.codex/skills/<name>/SKILL.md`) lay skills out the same way: one directory
 * per skill containing a `SKILL.md` with `name` / `description` frontmatter.
 *
 * This scanner is layer-neutral so it can run host-side in the orchestrator
 * (project skills, workspace is bind-mounted) and inside the container in the
 * session worker (Codex built-ins under `~/.codex`, which the orchestrator
 * cannot read over the HTTP link). See docs/138-skill-invocation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { SkillInfo } from "./types.js";

/** Frontmatter regex — matches `---\n...\n---` at the start of a file. */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/** Pull a single-line `key: value` out of a frontmatter block. */
export function frontmatterField(fm: string, key: string): string | undefined {
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

/**
 * Scan a skills root laid out as `<skillsDir>/<name>/SKILL.md`, returning one
 * {@link SkillInfo} per skill (unsorted). Skills that opt out with
 * `user-invocable: false` in their frontmatter are excluded. Returns `[]` when
 * the directory doesn't exist.
 */
export async function scanSkillsDir(
  skillsDir: string,
  source: "project" | "bundled",
): Promise<SkillInfo[]> {
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
      source,
    });
  }
  return skills;
}
