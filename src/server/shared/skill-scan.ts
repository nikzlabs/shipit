import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { markerClaimsOwnership, PLUGIN_SKILL_MARKER } from "./plugin-skill-marker.js";
import type { SkillInfo } from "./types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

export function frontmatterField(fm: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  if (!m) return undefined;
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  return raw.length > 0 ? raw : undefined;
}

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

async function isMaterializedPluginSkill(skillDir: string): Promise<boolean> {
  const marker = path.join(skillDir, PLUGIN_SKILL_MARKER);
  try {
    // A symlink to another skill's marker does not prove ownership.
    if (!(await fs.lstat(marker)).isFile()) return false;
    return markerClaimsOwnership(await fs.readFile(marker, "utf-8"));
  } catch {
    return false;
  }
}

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
    if (fm && frontmatterField(fm, "user-invocable") === "false") continue;

    const invocable = fm ? frontmatterField(fm, "name") ?? entry.name : entry.name;
    skills.push({
      name: invocable,
      // The invocable name can differ from its directory on disk.
      ...(invocable === entry.name ? {} : { dirName: entry.name }),
      description: fm ? frontmatterField(fm, "description") : undefined,
      source,
    });
  }
  return skills;
}
