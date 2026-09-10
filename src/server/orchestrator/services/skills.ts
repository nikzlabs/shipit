import path from "node:path";
import type { SkillInfo } from "../../shared/types.js";
import { scanSkillsDir } from "../../shared/skill-scan.js";

export async function listSkills(
  dir: string,
  skillsDirName: string,
): Promise<SkillInfo[]> {
  const skillsDir = path.join(dir, skillsDirName, "skills");
  const skills = await scanSkillsDir(skillsDir, "project");
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
