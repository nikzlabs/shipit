import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listSkills } from "./skills.js";

describe("listSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeClaudeSkill(name: string, frontmatter: string) {
    const dir = path.join(tmpDir, ".claude", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Body\n`);
  }

  it("returns [] when no skills directory exists", async () => {
    expect(await listSkills(tmpDir, ".claude")).toEqual([]);
  });

  it("scans Claude skills with name + description from frontmatter", async () => {
    writeClaudeSkill("my-skill", `name: my-skill\ndescription: "Does a thing"`);
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills).toEqual([
      { name: "my-skill", description: "Does a thing", source: "project" },
    ]);
  });

  it("falls back to the directory name when frontmatter has no name", async () => {
    writeClaudeSkill("fallback", `description: no name here`);
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills[0].name).toBe("fallback");
    expect(skills[0].description).toBe("no name here");
  });

  it("includes skills with no frontmatter at all (directory name only)", async () => {
    const dir = path.join(tmpDir, ".claude", "skills", "bare");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# Just a body, no frontmatter\n");
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills).toEqual([{ name: "bare", description: undefined, source: "project" }]);
  });

  it("excludes skills that opt out with user-invocable: false", async () => {
    writeClaudeSkill("hidden", `name: hidden\nuser-invocable: false`);
    writeClaudeSkill("shown", `name: shown\nuser-invocable: true`);
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills.map((s) => s.name)).toEqual(["shown"]);
  });

  it("sorts skills by name", async () => {
    writeClaudeSkill("zebra", `name: zebra`);
    writeClaudeSkill("alpha", `name: alpha`);
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills.map((s) => s.name)).toEqual(["alpha", "zebra"]);
  });

  it("ignores non-directory entries and missing SKILL.md", async () => {
    const skillsRoot = path.join(tmpDir, ".claude", "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "loose.md"), "not a skill dir");
    fs.mkdirSync(path.join(skillsRoot, "empty-dir"));
    writeClaudeSkill("real", `name: real`);
    const skills = await listSkills(tmpDir, ".claude");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  function writeCodexSkill(name: string, body: string) {
    const dir = path.join(tmpDir, ".codex", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  }

  it("scans Codex skills from .codex/skills/<name>/SKILL.md", async () => {
    writeCodexSkill("deploy", `---\nname: deploy\ndescription: Deploy it\n---\nbody`);
    writeCodexSkill("review", `no frontmatter`);
    const skills = await listSkills(tmpDir, ".codex");
    expect(skills).toEqual([
      { name: "deploy", description: "Deploy it", source: "project" },
      { name: "review", description: undefined, source: "project" },
    ]);
  });

  it("excludes Codex skills that opt out with user-invocable: false", async () => {
    writeCodexSkill("hidden", `---\nname: hidden\nuser-invocable: false\n---\nbody`);
    writeCodexSkill("shown", `---\nname: shown\n---\nbody`);
    const skills = await listSkills(tmpDir, ".codex");
    expect(skills.map((s) => s.name)).toEqual(["shown"]);
  });

  it("does not cross backends — Claude agent ignores .codex/skills", async () => {
    writeCodexSkill("deploy", "body");
    expect(await listSkills(tmpDir, ".claude")).toEqual([]);
  });

  it("does not cross backends — Codex agent ignores .claude/skills", async () => {
    writeClaudeSkill("claude-only", `name: claude-only`);
    expect(await listSkills(tmpDir, ".codex")).toEqual([]);
  });
});
