/**
 * docs/262 req 22 — a plugin's skills reach the agent "whichever agent backend
 * runs the session", and "projects never keep copies that must be kept in
 * sync". Those two clauses are what most of these tests assert: every harness
 * root gets the skill, and nothing lands in the user's git.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  materializePluginSkills,
  namespacedName,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  PLUGIN_SKILL_MARKER,
} from "./plugin-skills.js";
import { HARNESSES } from "../shared/catalogue/harnesses.js";

let tmp: string;
let workspaceDir: string;
let checkoutDir: string;

/** Every distinct skills root a harness scans, as absolute paths. */
function roots(): string[] {
  return [...new Set(HARNESSES.map((h) => h.capabilities.skillsDirName))]
    .map((name) => path.join(workspaceDir, name, "skills"));
}

function writeSkill(dir: string, name: string, frontmatterName?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const front = frontmatterName === undefined ? `name: ${name}\n` : `name: ${frontmatterName}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}description: does ${name}\n---\n\nBody.\n`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-skills-"));
  workspaceDir = path.join(tmp, "workspace");
  checkoutDir = path.join(tmp, "checkout");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(checkoutDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("materializePluginSkills", () => {
  it("writes into EVERY harness's discovery root, not just the running one", () => {
    // req 22: "whichever agent backend runs the session … never tied to one
    // backend". docs/209 observed that Codex also reads `.claude/skills`, but
    // recorded it as observed behavior rather than a guarantee — and ShipIt's
    // own skill picker reads the per-harness root, so one root is not enough.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    const result = materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(result.materialized).toEqual(["plugins--tools--probe"]);
    expect(roots().length).toBeGreaterThan(1);
    for (const root of roots()) {
      expect(fs.existsSync(path.join(root, "plugins--tools--probe", "SKILL.md"))).toBe(true);
    }
  });

  it("namespaces the invocable name, not only the directory", () => {
    // Two plugins both shipping `probe` would otherwise be two entries called
    // `probe`: the scanner takes the name from the frontmatter and only falls
    // back to the directory name.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    const body = fs.readFileSync(
      path.join(roots()[0]!, "plugins--tools--probe", "SKILL.md"), "utf-8",
    );
    expect(body).toContain("name: plugins--tools--probe");
    expect(body).toContain("description: does probe");
    expect(body).toContain("Body.");
  });

  it("adds a name to a skill whose frontmatter has none", () => {
    fs.mkdirSync(path.join(checkoutDir, "skills", "quiet"), { recursive: true });
    fs.writeFileSync(
      path.join(checkoutDir, "skills", "quiet", "SKILL.md"),
      "---\ndescription: no name field\n---\n\nBody.\n",
    );
    materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    const body = fs.readFileSync(path.join(roots()[0]!, "plugins--tools--quiet", "SKILL.md"), "utf-8");
    expect(body).toContain("name: plugins--tools--quiet");
    expect(body).toContain("description: no name field");
  });

  it("copies sibling files a skill ships beside SKILL.md", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    fs.writeFileSync(path.join(src, "helper.sh"), "#!/bin/sh\necho hi\n");
    materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(fs.existsSync(path.join(roots()[0]!, "plugins--tools--probe", "helper.sh"))).toBe(true);
  });

  it("ignores a directory with no SKILL.md, and a missing skills dir", () => {
    fs.mkdirSync(path.join(checkoutDir, "skills", "not-a-skill"), { recursive: true });
    const result = materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
      { alias: "gone", skillsDir: path.join(checkoutDir, "nowhere") },
    ]);
    expect(result.materialized).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("re-materializes on refresh, replacing the previous generation's copy", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: probe\ndescription: v2\n---\n\nNew body.\n");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    const body = fs.readFileSync(path.join(roots()[0]!, "plugins--tools--probe", "SKILL.md"), "utf-8");
    expect(body).toContain("v2");
    expect(body).toContain("New body.");
  });

  it("drops a file the new generation no longer ships", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    fs.writeFileSync(path.join(src, "old.txt"), "x");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    fs.rmSync(path.join(src, "old.txt"));
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(fs.existsSync(path.join(roots()[0]!, "plugins--tools--probe", "old.txt"))).toBe(false);
  });

  it("removes skills the declaration no longer imports", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    // The `use` entry is gone — nothing is imported any more.
    const result = materializePluginSkills(workspaceDir, []);
    expect(result.removed).toEqual(["plugins--tools--probe"]);
    for (const root of roots()) {
      expect(fs.existsSync(path.join(root, "plugins--tools--probe"))).toBe(false);
    }
  });

  it("removes a skill left behind by a renamed alias", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const result = materializePluginSkills(workspaceDir, [
      { alias: "renamed", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(result.materialized).toEqual(["plugins--renamed--probe"]);
    expect(result.removed).toEqual(["plugins--tools--probe"]);
  });

  it("never touches a skill it did not write", () => {
    // Both halves matter: the `plugins--` prefix scopes the sweep, and the
    // marker is what proves a directory is ours. Deleting somebody's own work
    // to make room for a copy is not an acceptable failure mode.
    const mine = path.join(roots()[0]!, "plugins--tools--probe");
    writeSkill(mine, "hand-written");
    const marketplace = path.join(roots()[0]!, "acme__helper");
    writeSkill(marketplace, "helper");

    const result = materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(fs.existsSync(path.join(marketplace, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(mine, "SKILL.md"), "utf-8")).toContain("hand-written");
    expect(result.removed).toEqual([]);
  });

  it("refuses to overwrite an unmarked directory in its own namespace", () => {
    const clash = path.join(roots()[0]!, "plugins--tools--probe");
    writeSkill(clash, "hand-written");
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");

    const result = materializePluginSkills(workspaceDir, [
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(result.failed[0]?.reason).toContain("not created by ShipIt");
    expect(fs.readFileSync(path.join(clash, "SKILL.md"), "utf-8")).toContain("hand-written");
    // The other root has no clash, so the skill still lands there.
    expect(result.materialized).toEqual(["plugins--tools--probe"]);
  });

  it("marks what it wrote", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materializePluginSkills(workspaceDir, [{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const marker = path.join(roots()[0]!, "plugins--tools--probe", PLUGIN_SKILL_MARKER);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8")).name).toBe("plugins--tools--probe");
  });
});

describe("namespacedName", () => {
  it("renders an awkward alias or skill name into a usable directory", () => {
    expect(namespacedName("My Tools", "Do Things!")).toBe("plugins--my-tools--do-things");
    expect(namespacedName("", "")).toBe("plugins--unnamed--unnamed");
  });
});

describe("pluginSkillExcludeEntries", () => {
  it("covers every harness root and only this module's namespace", () => {
    const entries = pluginSkillExcludeEntries();
    expect(entries).toContain(".claude/skills/plugins--*/");
    expect(entries).toContain(".codex/skills/plugins--*/");
    // A pattern broad enough to hide the project's own skills would be a bug.
    for (const entry of entries) expect(entry).toContain("plugins--*");
  });
});

describe("resolvePluginSkillSources", () => {
  it("reads each repository's own manifest for the export's skills dir", () => {
    fs.writeFileSync(
      path.join(checkoutDir, "shipit.yaml"),
      "exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n    other:\n      cli:\n        x: bin/x.mjs\n",
    );
    const sources = resolvePluginSkillSources(
      [
        { plugin: "probe", from: "tools", alias: "reqs" },
        { plugin: "other", from: "tools", alias: "other" },
      ],
      () => checkoutDir,
    );

    expect(sources).toEqual([{ alias: "reqs", skillsDir: path.join(checkoutDir, "pkg", "skills") }]);
  });

  it("yields nothing for a repo with no live checkout or no manifest", () => {
    expect(resolvePluginSkillSources([{ plugin: "p", from: "tools", alias: "p" }], () => null)).toEqual([]);
    expect(resolvePluginSkillSources([{ plugin: "p", from: "tools", alias: "p" }], () => checkoutDir)).toEqual([]);
  });

  it("survives a malformed manifest rather than failing the session", () => {
    fs.writeFileSync(path.join(checkoutDir, "shipit.yaml"), "exports: [unclosed\n  - broken");
    expect(resolvePluginSkillSources([{ plugin: "p", from: "t", alias: "p" }], () => checkoutDir)).toEqual([]);
  });
});
