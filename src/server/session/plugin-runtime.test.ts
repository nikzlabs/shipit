/**
 * docs/262 — the container half: what the agent ends up seeing under
 * `/plugins`. Install is deliberately NOT here (it runs in its own container —
 * plan §1b), so neither are its tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { preparePlugins } from "./plugin-runtime.js";
import { namespacedName } from "./plugin-skills.js";

let tmp: string;
let workspaceDir: string;
let store: string;
let pluginsDir: string;

const opts = () => ({ workspaceDir, storeDir: store, pluginsDir });

/** Publish a generation the way `plugin-generations.ts` does: dir + `active` symlink. */
function publishGeneration(repoName: string, commit: string, manifest: string, files: Record<string, string> = {}): string {
  const dir = path.join(store, repoName, "generations", commit);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({ repoName, commit, ref: "branch main", activatedAt: "", exports: [] }),
  );
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const link = path.join(store, repoName, "active");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join("generations", commit), link);
  return dir;
}

const PROBE_MANIFEST = "exports:\n  plugins:\n    probe:\n      install: echo installing\n      install-inputs: [inputs.txt]\n";

const DECLARATION = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n"
  + "  use:\n    - plugin: probe\n      from: tools\n";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runtime-"));
  workspaceDir = path.join(tmp, "workspace");
  store = path.join(tmp, "plugin-store");
  pluginsDir = path.join(tmp, "plugins");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function declare(yaml = DECLARATION): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

describe("preparePlugins — the agent-facing surface", () => {
  it("links a live checkout at /plugins/<name>", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);

    const result = preparePlugins(opts());

    expect(result.linked).toEqual(["tools"]);
    // The link target must be the STORE path, not the generation: both hops
    // resolve in-container, so a later generation swap is visible with no
    // remount (plan §2 "as built").
    expect(fs.readlinkSync(path.join(pluginsDir, "tools"))).toBe(path.join(store, "tools", "active"));
    expect(fs.existsSync(path.join(pluginsDir, "tools", "shipit.yaml"))).toBe(true);
  });

  it("follows a generation swap without re-linking", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "mark.txt": "first" });
    preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), PROBE_MANIFEST, { "mark.txt": "second" });

    // No second prepare — the symlink chain alone must resolve to the new one.
    expect(fs.readFileSync(path.join(pluginsDir, "tools", "mark.txt"), "utf8")).toBe("second");
  });

  it("reports a declared repo with no generation instead of failing", () => {
    declare();
    const result = preparePlugins(opts());
    expect(result.missing).toEqual(["tools"]);
    expect(result.linked).toEqual([]);
  });

  it("skips `repo: self` — it has no generation (req 27)", () => {
    declare("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    const result = preparePlugins(opts());
    expect(result.linked).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("does nothing when the project declares no plugins", () => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    expect(preparePlugins(opts())).toEqual({
      linked: [], missing: [], unlinked: [], skills: [], skillsRemoved: [], skillsFailed: [],
    });
  });

  it("refuses to clobber a real file at the link path", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "tools"), "not ours");

    const result = preparePlugins(opts());
    expect(result.linked).toEqual([]);
    expect(fs.readFileSync(path.join(pluginsDir, "tools"), "utf8")).toBe("not ours");
  });
});

describe("preparePlugins — skills (req 22)", () => {
  const SKILLS_MANIFEST = "exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n";

  it("materializes an imported plugin's skills into every harness root", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\ndescription: p\n---\n\nBody.\n",
    });

    const result = preparePlugins(opts());

    const name = namespacedName("probe", "probe");
    expect(result.skills).toEqual([name]);
    for (const dir of [".claude", ".codex"]) {
      expect(fs.existsSync(path.join(workspaceDir, dir, "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("uses the consumer's alias as the namespace, not the export name", () => {
    declare(DECLARATION.replace("      from: tools\n", "      from: tools\n      alias: reqs\n"));
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    expect(preparePlugins(opts()).skills).toEqual([namespacedName("reqs", "probe")]);
  });

  it("does not materialize a plugin the consumer declared but never imported", () => {
    // A repo with no `use` entry is browsable at /plugins/<name>, but nothing
    // of it is activated — skills included.
    declare("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    expect(preparePlugins(opts()).skills).toEqual([]);
  });

  // The whole point of the copy is that req 22's "projects never keep copies"
  // stays true. A materialized skill that the post-turn `git add -A` stages is
  // exactly the copy the requirement forbids.
  it("keeps the materialized skills out of the project's git", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspaceDir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: workspaceDir });
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });

    preparePlugins(opts());
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: workspaceDir }).toString();

    expect(staged).toContain("shipit.yaml");
    expect(staged).not.toContain(namespacedName("probe", "probe"));
    // And the project's own skills are still perfectly visible to git.
    fs.mkdirSync(path.join(workspaceDir, ".claude", "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n");
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: workspaceDir }).toString())
      .toContain(".claude/skills/mine/SKILL.md");
  });

  // If the promise "this never enters your repository" cannot be kept, the
  // copy must not be made. Materializing anyway would put somebody else's
  // repository into the user's next commit.
  it("materializes nothing when it cannot keep the copies out of git", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDir });
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    // `.git/info` cannot be created because `info` is already a file.
    fs.rmSync(path.join(workspaceDir, ".git", "info"), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspaceDir, ".git", "info"), "not a directory");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = preparePlugins(opts());

    expect(result.skills).toEqual([]);
    expect(result.skillsFailed[0]?.reason).toContain("out of this clone's git");
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"))))
      .toBe(false);
    // The link surface is unaffected — only the skills are withheld.
    expect(result.linked).toEqual(["tools"]);
  });

  it("removes materialized skills when the import is dropped", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    preparePlugins(opts());

    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    const result = preparePlugins(opts());

    expect(result.skillsRemoved).toEqual([namespacedName("probe", "probe")]);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"))))
      .toBe(false);
  });
});

describe("preparePlugins — stale links (review finding)", () => {
  it("removes a link for a repo the declaration no longer names", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);

    // The declaration drops every plugin repo. A long-lived container would
    // otherwise keep exposing the old one until it was recreated.
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    const result = preparePlugins(opts());

    expect(result.unlinked).toEqual(["tools"]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(false);
  });

  it("leaves anything that is not our symlink alone", () => {
    declare();
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "not-ours"), "hands off");
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "not-ours"))).toBe(true);
  });
});
