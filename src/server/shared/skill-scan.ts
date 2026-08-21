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
import { markerClaimsOwnership, PLUGIN_SKILL_MARKER } from "./plugin-skill-marker.js";
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
 * Whether this directory is a skill ShipIt materialized from a plugin
 * repository (docs/262 req 22) — decided by the marker's CONTENT, never by the
 * `plugins--` prefix, because a directory may carry that name and belong to the
 * user (see `shared/plugin-skill-marker.ts`).
 */
async function isMaterializedPluginSkill(skillDir: string): Promise<boolean> {
  const marker = path.join(skillDir, PLUGIN_SKILL_MARKER);
  try {
    // `lstat` first: a symlink pointing at somebody else's valid marker is not
    // proof of anything, and would hide a real skill from the menu.
    if (!(await fs.lstat(marker)).isFile()) return false;
    return markerClaimsOwnership(await fs.readFile(marker, "utf-8"));
  } catch {
    return false;
  }
}

/**
 * Scan a skills root laid out as `<skillsDir>/<name>/SKILL.md`, returning one
 * {@link SkillInfo} per skill (unsorted). Returns `[]` when the directory
 * doesn't exist.
 *
 * Two kinds of skill are excluded, for the same reason: the menu lists what the
 * USER can invoke. A skill opts out for itself with `user-invocable: false` in
 * its frontmatter; a skill materialized from a plugin repository is excluded on
 * ShipIt's behalf (docs/262 req 22). Plugin skills reach the agent exactly as
 * project skills do — that is req 22 and it is unchanged — but they are the
 * plugin's instructions to the agent, not commands the user chose to have, and
 * they carry a namespaced directory name with a collision hash that reads as
 * noise in a `/` menu.
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
    const skillDir = path.join(skillsDir, entry.name);
    const content = await sniff(path.join(skillDir, "SKILL.md"));
    if (content === undefined) continue;
    if (await isMaterializedPluginSkill(skillDir)) continue;

    const fm = FRONTMATTER_RE.exec(content)?.[1];
    // A skill is invocable unless it explicitly opts out with
    // `user-invocable: false`. Absent frontmatter still counts (the directory
    // exists, so the CLI will resolve `/<dir-name>`).
    if (fm && frontmatterField(fm, "user-invocable") === "false") continue;

    const invocable = fm ? frontmatterField(fm, "name") ?? entry.name : entry.name;
    skills.push({
      name: invocable,
      // Preserve the source directory name so callers that read SKILL.md from
      // disk can find it even when the frontmatter `name:` (which we use as
      // the invocable token) diverges from the folder. Omit when redundant to
      // keep serialized output compact.
      ...(invocable === entry.name ? {} : { dirName: entry.name }),
      description: fm ? frontmatterField(fm, "description") : undefined,
      source,
    });
  }
  return skills;
}
