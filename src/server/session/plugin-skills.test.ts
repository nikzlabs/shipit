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
  sweepStalePluginSkills,
  namespacedName,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  PLUGIN_SKILL_MARKER,
} from "./plugin-skills.js";
import { HARNESSES } from "../shared/catalogue/harnesses.js";
import { pluginSkillLabel } from "../shared/plugin-skill-marker.js";
import { scanSkillsDir } from "../shared/skill-scan.js";

let tmp: string;
let workspaceDir: string;
let checkoutDir: string;

/** The namespaced names under test — each carries a hash of its exact pair. */
const NAMES = {
  probe: namespacedName("tools", "probe"),
  quiet: namespacedName("tools", "quiet"),
  renamedProbe: namespacedName("renamed", "probe"),
};

/**
 * Plan, sweep, then write — the order `preparePlugins` uses, so these tests
 * exercise the real sequence rather than a shortcut through it.
 */
function materialize(sources: { alias: string; skillsDir: string; checkoutDir?: string; repo?: string }[]) {
  const plan = planPluginSkills(sources.map((s) => ({ repo: "tools", checkoutDir, ...s })));
  const removed = sweepStalePluginSkills(workspaceDir, new Set(plan.planned.map((p) => p.name)));
  const result = materializePluginSkills(workspaceDir, plan.planned);
  return { ...result, removed, failed: [...plan.failed, ...result.failed] };
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

  it("ignores a non-skill directory beside a real skill, but REPORTS a missing skills dir", () => {
    // Silence on a declared-but-absent skills directory reported a plugin as
    // fully active while shipping none of the instructions it promised.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    fs.mkdirSync(path.join(checkoutDir, "skills", "not-a-skill"), { recursive: true });
    const result = materialize([
      { alias: "tools", skillsDir: path.join(checkoutDir, "skills") },
      { alias: "gone", skillsDir: path.join(checkoutDir, "nowhere") },
    ]);
    expect(result.materialized).toEqual([NAMES.probe]);
    expect(result.failed.map((f) => f.skill)).toEqual(["gone"]);
    expect(result.failed[0]?.reason).toContain("does not exist");
  });

  // The same silent shortfall one step further in: the directory is there and
  // holds nothing readable, so the plugin promises instructions and ships none.
  // A clean pass here is exactly what req 13 rules out (review finding).
  it("reports a skills directory that exists but holds no readable skill", () => {
    fs.mkdirSync(path.join(checkoutDir, "skills", "not-a-skill"), { recursive: true });
    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    expect(result.materialized).toEqual([]);
    expect(result.failed).toEqual([
      { repo: "tools", skill: "tools", reason: expect.stringContaining("no readable skill") },
    ]);
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
    // All roots or none: the root that DID take the copy is rolled back, so
    // the skill is not silently present for one backend and absent for the
    // other — which is the per-backend outcome req 22 rules out.
    expect(result.materialized).toEqual([]);
    expect(fs.existsSync(path.join(roots()[1]!, NAMES.probe))).toBe(false);
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

    expect(result.failed.some((f) => f.reason.includes("outside the workspace"))).toBe(true);
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

  // The declared path is validated lexically by the manifest parser, which
  // says nothing about what its COMPONENTS are. `skills: pkg/skills` with
  // `pkg` a symlink out of the checkout read somebody else's files, and the
  // per-entry copy filter never saw it — it only lstats what it is handed.
  it("refuses a skills directory reached through a symlinked ancestor", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(outside, "skills", "probe"), { recursive: true });
    fs.writeFileSync(path.join(outside, "skills", "probe", "SKILL.md"), "---\nname: probe\n---\n");
    fs.symlinkSync(outside, path.join(checkoutDir, "pkg"));

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "pkg", "skills") }]);

    expect(result.materialized).toEqual([]);
    expect(result.failed[0]?.reason).toContain("outside the plugin checkout");
    expect(fs.existsSync(path.join(roots()[0]!, namespacedName("tools", "probe")))).toBe(false);
  });

  it("refuses a discovery root reached through a symlinked ancestor", () => {
    // `.claude -> /outside` with no `/outside/skills` yet: the earlier check
    // looked only at the final component, so this created and populated a
    // directory entirely beyond the git exclude meant to contain it.
    const outside = path.join(tmp, "outside-root");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspaceDir, ".claude"));
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");

    const result = materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);

    expect(result.failed.some((f) => f.reason.includes("outside the workspace"))).toBe(true);
    expect(fs.existsSync(path.join(outside, "skills"))).toBe(false);
  });

  it("rejects a second skill whose namespaced name collides", () => {
    // The hash narrows the odds; it does not make the name unique. A second
    // reviewer found a real collision at 6 hex digits in under ten thousand
    // crafted candidates, so the guarantee has to come from rejecting the
    // duplicate rather than from the hash width.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    const plan = planPluginSkills([
      { alias: "same", repo: "tools", checkoutDir, skillsDir: path.join(checkoutDir, "skills") },
      { alias: "same", repo: "tools", checkoutDir, skillsDir: path.join(checkoutDir, "skills") },
    ]);

    expect(plan.planned).toHaveLength(1);
    expect(plan.failed[0]?.reason).toContain("collides");
  });

  it("sweeps a staging directory a killed run left behind", () => {
    // The `finally` cannot cover a killed process, and nothing else ever names
    // these — so without this they accumulate, holding third-party content in
    // the workspace. The marker is written BEFORE the copy starts, so even a
    // run killed mid-copy leaves one that proves whose it is.
    const orphan = path.join(roots()[0]!, `.${namespacedName("tools", "probe")}.staging-deadbeef`);
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "SKILL.md"), "half copied");
    fs.writeFileSync(
      path.join(orphan, PLUGIN_SKILL_MARKER),
      JSON.stringify({ marker: "shipit-plugin-skill-v1", name: "x" }),
    );

    sweepStalePluginSkills(workspaceDir, new Set());
    expect(fs.existsSync(orphan)).toBe(false);
  });

  // req 27 made this reachable: a self-declared plugin may point `skills:` at a
  // harness root, so a directory in this root can be checked-in source. Deleting
  // it because its NAME matches is the working-tree data loss the marker exists
  // to prevent — the same rule the published names follow.
  it("leaves a staging-shaped directory that is not provably ours", () => {
    const theirs = path.join(roots()[0]!, `.${namespacedName("tools", "probe")}.staging-backup`);
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, "SKILL.md"), "the user's own notes");

    sweepStalePluginSkills(workspaceDir, new Set());
    expect(fs.existsSync(path.join(theirs, "SKILL.md"))).toBe(true);
  });

  // req 27 — under `repo: self` the checkout IS the workspace, so this module's
  // output and its input can sit in one tree for the first time. A plugin that
  // declares a harness skill root as its `skills:` directory would otherwise
  // re-materialize last round's copies under a twice-namespaced name, and again
  // next round: growth with no bound and no error.
  it("never re-materializes its own output as a source (req 27)", () => {
    const selfRoot = roots()[0]!;
    writeSkill(path.join(selfRoot, "probe"), "probe");

    // Round one: the author's own skill is picked up and copied beside it.
    const first = materialize([{ alias: "tools", skillsDir: selfRoot, checkoutDir: workspaceDir }]);
    expect(first.materialized).toEqual([NAMES.probe]);

    // Round two sees the copy sitting in the source directory and leaves it
    // alone — the same set, not a deeper one.
    const second = materialize([{ alias: "tools", skillsDir: selfRoot, checkoutDir: workspaceDir }]);
    expect(second.materialized).toEqual([NAMES.probe]);
    expect(second.removed).toEqual([]);
    expect(fs.readdirSync(selfRoot).sort()).toEqual(["probe", NAMES.probe].sort());
  });

  it("marks what it wrote", () => {
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    const marker = path.join(roots()[0]!, NAMES.probe, PLUGIN_SKILL_MARKER);
    expect(JSON.parse(fs.readFileSync(marker, "utf-8")).name).toBe(NAMES.probe);
  });

  it("stays out of the user's `/` menu (req 22)", async () => {
    // End-to-end against the REAL writer: the scan's exclusion reads the marker
    // this module writes, and the two live in different modules, so a test that
    // hand-rolled the marker could not fail on a change to either.
    writeSkill(path.join(checkoutDir, "skills", "probe"), "probe");
    materialize([{ alias: "tools", skillsDir: path.join(checkoutDir, "skills") }]);
    writeSkill(path.join(roots()[0]!, "mine"), "mine");

    const listed = await scanSkillsDir(roots()[0]!, "project");
    expect(listed.map((s) => s.name)).toEqual(["mine"]);
  });
});

describe("namespacedName", () => {
  it("renders an awkward alias or skill name into a usable directory", () => {
    expect(namespacedName("My Tools", "Do Things!")).toMatch(/^plugins--my-tools--do-things-[0-9a-f]{12}$/);
    expect(namespacedName("", "")).toMatch(/^plugins--unnamed--unnamed-[0-9a-f]{12}$/);
  });

  // The writer and the display parser are in different modules; this is what
  // binds them, so a change to either shape fails here rather than in a
  // transcript row nobody is looking at.
  it("round-trips through the label the transcript shows", () => {
    expect(pluginSkillLabel(namespacedName("assetgen", "assetgen"))).toBe("assetgen/assetgen");
    expect(pluginSkillLabel(namespacedName("My Tools", "Do Things!"))).toBe("my-tools/do-things");
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
    expect(entries).toContain("/.opencode/skills/plugins--tools--probe-abc123/");
    expect(entries).toContain("/.grok/skills/plugins--tools--probe-abc123/");
    // No wildcard among the PUBLISHED names.
    for (const entry of entries.filter((e) => e.includes("probe"))) {
      expect(entry).not.toContain("*");
    }
    // The staging pattern is the one wildcard, and it is dot-prefixed inside
    // our own namespace — a half-copied third-party tree must not be stageable
    // by a `git add -A` that overlaps the copy.
    expect(entries).toContain("/.claude/skills/.plugins--*.staging-*/");
    // Even with nothing planned, the staging pattern stays.
    expect(pluginSkillExcludeEntries([])).toEqual([
      "/.claude/skills/.plugins--*.staging-*/",
      "/.codex/skills/.plugins--*.staging-*/",
      "/.opencode/skills/.plugins--*.staging-*/",
      "/.grok/skills/.plugins--*.staging-*/",
    ]);
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
      () => ({ dir: checkoutDir, repo: "Tools" }),
    );

    // The repo name comes from the resolver, in the DECLARATION's spelling —
    // not from the `use` entry's `from:`, which matches case-insensitively.
    expect(sources).toEqual([
      { alias: "reqs", repo: "Tools", checkoutDir, skillsDir: path.join(checkoutDir, "pkg", "skills") },
    ]);
  });

  it("yields nothing for a repo with no live checkout or no manifest", () => {
    expect(resolvePluginSkillSources([{ plugin: "p", from: "tools", alias: "p" }], () => null)).toEqual([]);
    expect(resolvePluginSkillSources([{ plugin: "p", from: "tools", alias: "p" }], () => ({ dir: checkoutDir, repo: "tools" }))).toEqual([]);
  });

  it("survives a malformed manifest rather than failing the session", () => {
    fs.writeFileSync(path.join(checkoutDir, "shipit.yaml"), "exports: [unclosed\n  - broken");
    expect(resolvePluginSkillSources([{ plugin: "p", from: "t", alias: "p" }], () => ({ dir: checkoutDir, repo: "tools" }))).toEqual([]);
  });
});
