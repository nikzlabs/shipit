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
  planPluginSkills,
  namespacedName,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  PLUGIN_SKILL_MARKER,
} from "./plugin-skills.js";
import { HARNESSES } from "../shared/catalogue/harnesses.js";

let tmp: string;
let workspaceDir: string;
let checkoutDir: string;

/** The namespaced names under test — each carries a hash of its exact pair. */
const NAMES = {
  probe: namespacedName("tools", "probe"),
  quiet: namespacedName("tools", "quiet"),
  renamedProbe: namespacedName("renamed", "probe"),
};

/** Plan, then write — the two-step the git exclude needs. */
function materialize(sources: { alias: string; skillsDir: string }[]) {
  return materializePluginSkills(workspaceDir, planPluginSkills(sources));
}

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
    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(result.materialized).toEqual([NAMES.probe]);
    expect(roots().length).toBeGreaterThan(1);
    for (const root of roots()) {
      expect(fs.existsSync(path.join(root, NAMES.probe, "SKILL.md"))).toBe(true);
    }
  });

  it("namespaces the invocable name, not only the directory", () => {
    // Two plugins both shipping `probe` would otherwise be two entries called
    // `probe`: the scanner takes the name from the frontmatter and only falls
    // back to the directory name.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    const body = fs.readFileSync(
      path.join(roots()[0]!, NAMES.probe, "SKILL.md"), "utf-8",
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
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    const body = fs.readFileSync(path.join(roots()[0]!, NAMES.quiet, "SKILL.md"), "utf-8");
    expect(body).toContain("name: plugins--tools--quiet");
    expect(body).toContain("description: no name field");
  });

  it("copies sibling files a skill ships beside SKILL.md", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    fs.writeFileSync(path.join(src, "helper.sh"), "#!/bin/sh\necho hi\n");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(fs.existsSync(path.join(roots()[0]!, NAMES.probe, "helper.sh"))).toBe(true);
  });

  it("ignores a directory with no SKILL.md, and a missing skills dir", () => {
    fs.mkdirSync(path.join(checkoutDir, "skills", "not-a-skill"), { recursive: true });
    const result = materialize([
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
      { alias: "gone", skillsDir: path.join(checkoutDir, "nowhere") },
    ]);
    expect(result.materialized).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("re-materializes on refresh, replacing the previous generation's copy", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: probe\ndescription: v2\n---\n\nNew body.\n");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    const body = fs.readFileSync(path.join(roots()[0]!, NAMES.probe, "SKILL.md"), "utf-8");
    expect(body).toContain("v2");
    expect(body).toContain("New body.");
  });

  it("drops a file the new generation no longer ships", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    fs.writeFileSync(path.join(src, "old.txt"), "x");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    fs.rmSync(path.join(src, "old.txt"));
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(fs.existsSync(path.join(roots()[0]!, NAMES.probe, "old.txt"))).toBe(false);
  });

  it("removes skills the declaration no longer imports", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    // The `use` entry is gone — nothing is imported any more.
    const result = materialize([]);
    expect(result.removed).toEqual([NAMES.probe]);
    for (const root of roots()) {
      expect(fs.existsSync(path.join(root, NAMES.probe))).toBe(false);
    }
  });

  it("removes a skill left behind by a renamed alias", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const result = materialize([{ alias: "renamed", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(result.materialized).toEqual([NAMES.renamedProbe]);
    expect(result.removed).toEqual([NAMES.probe]);
  });

  it("never touches a skill it did not write", () => {
    // Both halves matter: the `plugins--` prefix scopes the sweep, and the
    // marker is what proves a directory is ours. Deleting somebody's own work
    // to make room for a copy is not an acceptable failure mode.
    const mine = path.join(roots()[0]!, NAMES.probe);
    writeSkill(mine, "hand-written");
    const marketplace = path.join(roots()[0]!, "acme__helper");
    writeSkill(marketplace, "helper");

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(fs.existsSync(path.join(marketplace, "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(mine, "SKILL.md"), "utf-8")).toContain("hand-written");
    expect(result.removed).toEqual([]);
  });

  it("refuses to overwrite an unmarked directory in its own namespace", () => {
    const clash = path.join(roots()[0]!, NAMES.probe);
    writeSkill(clash, "hand-written");
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(result.failed[0]?.reason).toContain("not created by ShipIt");
    expect(fs.readFileSync(path.join(clash, "SKILL.md"), "utf-8")).toContain("hand-written");
    // NOT reported as materialized, even though the other root took it: a
    // partial write is a skill the running backend may not see at all, so
    // calling it done would hide the one case worth knowing about.
    expect(result.materialized).toEqual([]);
    expect(fs.existsSync(path.join(roots()[1]!, NAMES.probe, "SKILL.md"))).toBe(true);
  });

  // A third-party repository controls this tree. `dereference: true` copied a
  // link's TARGET, so `skills/x/assets -> /credentials` would have pulled that
  // content into the workspace; the manifest's path check is lexical and says
  // nothing about links inside the checkout.
  it("drops symlinks instead of following them out of the checkout", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    const secret = path.join(tmp, "outside-secret.txt");
    fs.writeFileSync(secret, "SECRET");
    fs.symlinkSync(secret, path.join(src, "escape.txt"));
    fs.symlinkSync(tmp, path.join(src, "escape-dir"));

    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    const written = path.join(roots()[0]!, NAMES.probe);
    expect(fs.existsSync(path.join(written, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(written, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(written, "escape-dir"))).toBe(false);
  });

  it("refuses to write through a symlinked discovery root", () => {
    // A project-owned `.claude/skills -> /elsewhere` would put every copy
    // outside the tree the git exclude covers.
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(workspaceDir, ".claude", "skills"));
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(result.failed.some((f) => f.reason.includes("symlink"))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, NAMES.probe))).toBe(false);
  });

  it("treats a directory whose marker is not ShipIt's as somebody else's", () => {
    // Presence of a file with that NAME is not proof of ownership — a
    // handwritten skill could contain one, and this module deletes what it
    // owns recursively.
    const clash = path.join(roots()[0]!, NAMES.probe);
    writeSkill(clash, "hand-written");
    fs.writeFileSync(path.join(clash, PLUGIN_SKILL_MARKER), JSON.stringify({ marker: "something-else" }));
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    expect(result.failed[0]?.reason).toContain("not created by ShipIt");
    expect(fs.readFileSync(path.join(clash, "SKILL.md"), "utf-8")).toContain("hand-written");

    // And the stale sweep leaves it alone too. (The name IS reported removed —
    // the OTHER root took a real copy, and that one is ours to sweep.)
    materialize([]);
    expect(fs.readFileSync(path.join(clash, "SKILL.md"), "utf-8")).toContain("hand-written");
  });

  it("leaves the live copy intact when a refresh fails part-way", () => {
    const src = path.join(checkoutDir, "skills", "probe");
    writeSkill(src, "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const live = path.join(roots()[0]!, NAMES.probe);
    expect(fs.readFileSync(path.join(live, "SKILL.md"), "utf-8")).toContain("does probe");

    // The new generation has no SKILL.md — the copy is rejected after staging.
    fs.rmSync(path.join(src, "SKILL.md"));
    fs.writeFileSync(path.join(src, "other.txt"), "x");
    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    // Nothing was planned (no SKILL.md), so the old copy is swept as stale
    // rather than left half-replaced — and no staging directory survives.
    expect(result.materialized).toEqual([]);
    const leftovers = fs.readdirSync(roots()[0]!).filter((n) => n.includes(".staging-"));
    expect(leftovers).toEqual([]);
  });

  it("distinguishes aliases that render to the same readable segment", () => {
    // `foo_bar` and `foo-bar` are both valid and both distinct to the parser's
    // uniqueness check, but the readable rendering collapses them — without the
    // hash the second copy would silently delete the first.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    const result = materialize([
      { alias: "foo_bar", skillsDir: path.join(checkoutDir, "skills") },
      { alias: "foo-bar", skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(new Set(result.materialized).size).toBe(2);
    for (const name of result.materialized) {
      expect(fs.existsSync(path.join(roots()[0]!, name, "SKILL.md"))).toBe(true);
    }
  });

  it("marks what it wrote", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const marker = path.join(roots()[0]!, NAMES.probe, PLUGIN_SKILL_MARKER);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8")).name).toBe(NAMES.probe);
  });
});

describe("namespacedName", () => {
  it("renders an awkward alias or skill name into a usable directory", () => {
    expect(namespacedName("My Tools", "Do Things!")).toMatch(/^plugins--my-tools--do-things-[0-9a-f]{6}$/);
    expect(namespacedName("", "")).toMatch(/^plugins--unnamed--unnamed-[0-9a-f]{6}$/);
  });
});

describe("pluginSkillExcludeEntries", () => {
  it("covers every harness root and only this module's namespace", () => {
    // Exact directories, never a wildcard: a wildcard also hides whatever the
    // user happens to name that way, and it would swallow a marketplace plugin
    // called `plugins--acme` (installed as `plugins--acme__<skill>`), whose own
    // path-scoped `git add` would then fail as an ignored path.
    const entries = pluginSkillExcludeEntries(["plugins--tools--probe-abc123"]);
    expect(entries).toContain("/.claude/skills/plugins--tools--probe-abc123/");
    expect(entries).toContain("/.codex/skills/plugins--tools--probe-abc123/");
    for (const entry of entries) expect(entry).not.toContain("*");
    expect(pluginSkillExcludeEntries([])).toEqual([]);
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
