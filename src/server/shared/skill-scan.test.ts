import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanSkillsDir, frontmatterField } from "./skill-scan.js";
import { PLUGIN_SKILL_MARKER, PLUGIN_SKILL_MARKER_ID } from "./plugin-skill-marker.js";

describe("scanSkillsDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, content: string) {
    const dir = path.join(tmpDir, root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  }

  it("returns [] when the directory does not exist", async () => {
    expect(await scanSkillsDir(path.join(tmpDir, "nope"), "project")).toEqual([]);
  });

  it("tags results with the given source", async () => {
    writeSkill("skills", "foo", `---\nname: foo\ndescription: A built-in\n---\nbody`);
    expect(await scanSkillsDir(path.join(tmpDir, "skills"), "bundled")).toEqual([
      { name: "foo", description: "A built-in", source: "bundled" },
    ]);
  });

  it("falls back to the directory name and excludes user-invocable: false", async () => {
    writeSkill("skills", "bare", "# no frontmatter");
    writeSkill("skills", "hidden", `---\nname: hidden\nuser-invocable: false\n---\nbody`);
    const skills = await scanSkillsDir(path.join(tmpDir, "skills"), "project");
    expect(skills).toEqual([{ name: "bare", description: undefined, source: "project" }]);
  });

  it("exposes the source directory name when it diverges from the frontmatter name", async () => {
    // Some upstream Claude plugins (e.g. hookify) ship `skills/writing-rules/`
    // with frontmatter `name: writing-hookify-rules`. The scanner should
    // surface the on-disk dir so callers that read SKILL.md from disk can find
    // it, while still exposing the invocable frontmatter name to clients.
    writeSkill("skills", "writing-rules", `---\nname: writing-hookify-rules\n---\nbody`);
    writeSkill("skills", "matched", `---\nname: matched\n---\nbody`);
    const skills = await scanSkillsDir(path.join(tmpDir, "skills"), "project");
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(byName["writing-hookify-rules"]).toMatchObject({ dirName: "writing-rules" });
    // Omit dirName when it would equal the invocable name (avoid serialized noise).
    expect(byName.matched).not.toHaveProperty("dirName");
  });

  it("excludes a skill materialized from a plugin repository (docs/262 req 22)", async () => {
    writeSkill("skills", "plugins--assetgen--assetgen-aab26884689f", `---\nname: plugins--assetgen--assetgen-aab26884689f\n---\nbody`);
    fs.writeFileSync(
      path.join(tmpDir, "skills", "plugins--assetgen--assetgen-aab26884689f", PLUGIN_SKILL_MARKER),
      JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID, name: "x", source: "/plugins/x" }),
    );
    writeSkill("skills", "mine", `---\nname: mine\n---\nbody`);
    const skills = await scanSkillsDir(path.join(tmpDir, "skills"), "project");
    expect(skills.map((s) => s.name)).toEqual(["mine"]);
  });

  it("keeps a user's own skill that merely looks like a materialized one", async () => {
    // The name is not proof of ownership, and neither is a marker file whose
    // contents say something else — hiding on either would remove a skill the
    // user wrote and can invoke.
    writeSkill("skills", "plugins--mine--thing-aab26884689f", `---\nname: plugins--mine--thing-aab26884689f\n---\nbody`);
    writeSkill("skills", "impostor", `---\nname: impostor\n---\nbody`);
    fs.writeFileSync(
      path.join(tmpDir, "skills", "impostor", PLUGIN_SKILL_MARKER),
      JSON.stringify({ marker: "something-else" }),
    );
    const skills = await scanSkillsDir(path.join(tmpDir, "skills"), "project");
    expect(skills.map((s) => s.name).sort()).toEqual(["impostor", "plugins--mine--thing-aab26884689f"]);
  });

  it("ignores non-directory entries and dirs without SKILL.md", async () => {
    const root = path.join(tmpDir, "skills");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "loose.md"), "not a skill");
    fs.mkdirSync(path.join(root, "empty"));
    writeSkill("skills", "real", `---\nname: real\n---\nbody`);
    const skills = await scanSkillsDir(root, "project");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("frontmatterField", () => {
  it("strips surrounding quotes and trims", () => {
    expect(frontmatterField(`name: "Quoted Value"`, "name")).toBe("Quoted Value");
    expect(frontmatterField(`name: plain`, "name")).toBe("plain");
  });

  it("returns undefined for a missing key", () => {
    expect(frontmatterField(`name: foo`, "description")).toBeUndefined();
  });
});
