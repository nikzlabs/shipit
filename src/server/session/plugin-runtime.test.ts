
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

const opts = () => ({ workspaceDir, storeDir: store, pluginsDir, binDir: path.join(tmp, "plugin-bin") });

function publishGeneration(
  repoName: string,
  commit: string,
  manifest: string,
  files: Record<string, string> = {},
  source: string | null = "acme/tools",
): string {
  const dir = path.join(store, repoName, "generations", commit);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName, commit, ref: "branch main", activatedAt: "", exports: [],
      ...(source === null ? {} : { source }),
    }),
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

let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runtime-"));
  workspaceDir = path.join(tmp, "workspace");
  store = path.join(tmp, "plugin-store");
  pluginsDir = path.join(tmp, "plugins");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
});

afterEach(() => {
  process.env.PATH = originalPath;
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
    expect(fs.readlinkSync(path.join(pluginsDir, "tools"))).toBe(path.join(store, "tools", "active"));
    expect(fs.existsSync(path.join(pluginsDir, "tools", "shipit.yaml"))).toBe(true);
  });

  it("follows a generation swap without re-linking", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "mark.txt": "first" });
    preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), PROBE_MANIFEST, { "mark.txt": "second" });

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
      linked: [], missing: [], unlinked: [], linkFailed: [],
      skills: [], skillsRemoved: [], skillsFailed: [],
      commands: [], commandsRemoved: [], commandsRefused: [], commandsFailed: [],
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
    expect(result.linkFailed).toEqual([
      { repo: "tools", reason: expect.stringContaining("not a link ShipIt made") },
    ]);
  });

  it("does not report a repo with no live generation as a link failure", () => {
    declare();
    const result = preparePlugins(opts());
    expect(result.missing).toEqual(["tools"]);
    expect(result.linkFailed).toEqual([]);
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

  const SELF_DECLARATION = "exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n"
    + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
    + "  use:\n    - plugin: probe\n      from: dev\n";

  function writeSelfSkill(body = "---\nname: probe\ndescription: p\n---\n\nBody.\n"): void {
    fs.mkdirSync(path.join(workspaceDir, "pkg", "skills", "probe"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "pkg", "skills", "probe", "SKILL.md"), body);
  }

  it("materializes a `repo: self` import's skills from the working tree (req 27)", () => {
    declare(SELF_DECLARATION);
    writeSelfSkill();

    const result = preparePlugins(opts());

    const name = namespacedName("probe", "probe");
    expect(result.skills).toEqual([name]);
    expect(result.skillsFailed).toEqual([]);
    for (const dir of [".claude", ".codex"]) {
      expect(fs.existsSync(path.join(workspaceDir, dir, "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("re-materializes a `repo: self` skill after an edit, with nothing to refresh", () => {
    declare(SELF_DECLARATION);
    writeSelfSkill();
    preparePlugins(opts());

    writeSelfSkill("---\nname: probe\ndescription: p\n---\n\nEdited.\n");
    preparePlugins(opts());

    const materialized = path.join(
      workspaceDir, ".claude", "skills", namespacedName("probe", "probe"), "SKILL.md",
    );
    expect(fs.readFileSync(materialized, "utf8")).toContain("Edited.");
  });

  it("ignores a generation left under a `repo: self` name, skills included", () => {
    declare(SELF_DECLARATION);
    writeSelfSkill("---\nname: probe\ndescription: p\n---\n\nFrom the working tree.\n");
    publishGeneration("dev", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nFrom the old repository.\n",
    });

    const result = preparePlugins(opts());

    const name = namespacedName("probe", "probe");
    expect(result.skills).toEqual([name]);
    expect(fs.readFileSync(path.join(workspaceDir, ".claude", "skills", name, "SKILL.md"), "utf8"))
      .toContain("From the working tree.");
    expect(result.linked).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, "dev"))).toBe(false);
  });

  it("uses the consumer's alias as the namespace, not the export name", () => {
    declare(DECLARATION.replace("      from: tools\n", "      from: tools\n      alias: reqs\n"));
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    expect(preparePlugins(opts()).skills).toEqual([namespacedName("reqs", "probe")]);
  });

  it("does not materialize a plugin the consumer declared but never imported", () => {
    declare("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    expect(preparePlugins(opts()).skills).toEqual([]);
  });

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
    fs.mkdirSync(path.join(workspaceDir, ".claude", "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, ".claude", "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n");
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: workspaceDir }).toString())
      .toContain(".claude/skills/mine/SKILL.md");
  });

  it("materializes nothing when it cannot keep the copies out of git", () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDir });
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    fs.rmSync(path.join(workspaceDir, ".git", "info"), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspaceDir, ".git", "info"), "not a directory");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = preparePlugins(opts());

    expect(result.skills).toEqual([]);
    expect(result.skillsFailed[0]?.reason).toContain("out of this clone's git");
    expect(result.skillsFailed).toEqual([
      { repo: "tools", skill: "(all)", reason: expect.stringContaining("out of this clone's git") },
    ]);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"))))
      .toBe(false);
    expect(result.linked).toEqual(["tools"]);
  });

  it("attributes a failure to the declared repository, in the declaration's spelling", () => {
    declare(
      "plugins:\n  repos:\n    - repo: acme/tools\n      name: Tools\n      branch: main\n"
      + "  use:\n    - plugin: probe\n      from: tools\n      alias: reqs\n",
    );
    publishGeneration("Tools", "a".repeat(40), SKILLS_MANIFEST);

    expect(preparePlugins(opts()).skillsFailed).toEqual([
      { repo: "Tools", skill: "reqs", reason: expect.stringContaining("does not exist in this generation") },
    ]);
  });

  it("names a write failure by `<alias>/<skill>`, not by its namespaced directory", () => {
    declare(DECLARATION.replace("      from: tools\n", "      from: tools\n      alias: reqs\n"));
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n",
    });
    const foreign = path.join(workspaceDir, ".claude", "skills", namespacedName("reqs", "probe"));
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: mine\n---\n");

    const failed = preparePlugins(opts()).skillsFailed;
    expect(failed[0]?.repo).toBe("tools");
    expect(failed[0]?.skill).toBe("reqs/probe");
    expect(failed[0]?.reason).toContain("not created by ShipIt");
  });

  it("describes ONE generation even when a refresh swaps `active` mid-pass", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nGeneration A.\n",
    });

    const realRead = fs.readFileSync;
    let swapped = false;
    vi.spyOn(fs, "readFileSync").mockImplementation((p, options) => {
      const out = realRead(p as string, options as BufferEncoding);
      if (!swapped && typeof p === "string" && p.startsWith(store) && p.endsWith("shipit.yaml")) {
        swapped = true;
        publishGeneration("tools", "b".repeat(40), SKILLS_MANIFEST, {
          "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nGeneration B.\n",
        });
      }
      return out;
    });

    const result = preparePlugins(opts());

    expect(swapped).toBe(true);
    const body = realRead(
      path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"), "SKILL.md"),
      "utf-8",
    );
    expect(body).toContain("Generation A.");
    expect(result.skillsFailed).toEqual([]);
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

describe("preparePlugins — a generation belongs to the repository the declaration names", () => {
  const SKILLS_MANIFEST = "exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n      cli:\n        probe: cli/probe.mjs\n";
  const FILES = { "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n" };

  it("exposes nothing of a generation left by the PREVIOUS repository", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES, "acme/old");

    const result = preparePlugins(opts());

    expect(result.linked).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe")))).toBe(false);
    expect(result.missing).toEqual(["tools"]);
    expect(result.skillsFailed).toEqual([]);
    expect(result.linkFailed).toEqual([
      { repo: "tools", reason: expect.stringContaining("published from `acme/old`") },
    ]);
  });

  it("refuses a legacy record with no source at all", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES, null);

    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    expect(result.linked).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.linkFailed).toEqual([
      { repo: "tools", reason: expect.stringContaining("predates ShipIt recording") },
    ]);
  });

  it("takes the plugin back as soon as a publish records the right source", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES, null);
    preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), SKILLS_MANIFEST, FILES);
    const result = preparePlugins(opts());

    expect(result.linked).toEqual(["tools"]);
    expect(result.skills).toEqual([namespacedName("probe", "probe")]);
  });

  it("withdraws a link it already made once the live generation turns foreign", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES);
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);

    publishGeneration("tools", "b".repeat(40), SKILLS_MANIFEST, FILES, "acme/old");
    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    expect(fs.lstatSync(path.join(pluginsDir, "tools"), { throwIfNoEntry: false })).toBeUndefined();
    expect(result.skillsRemoved).toEqual([namespacedName("probe", "probe")]);
  });

  it("reports a withdrawal it could not carry out", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES);
    preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), SKILLS_MANIFEST, FILES, "acme/old");
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (String(p) === path.join(pluginsDir, "tools")) throw new Error("device or resource busy");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = preparePlugins(opts());
    unlink.mockRestore();

    expect(result.linkFailed.map((f) => f.reason)).toEqual([
      expect.stringContaining("published from `acme/old`"),
      expect.stringContaining("could not be removed"),
    ]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);
  });

  it("matches the declaration's repository case-insensitively", () => {
    declare("plugins:\n  repos:\n    - repo: AcMe/Tools\n      name: tools\n      branch: main\n"
      + "  use:\n    - plugin: probe\n      from: tools\n");
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES);

    expect(preparePlugins(opts()).linked).toEqual(["tools"]);
  });

  it("has nothing to refuse for `repo: self`, which has no generation (req 27)", () => {
    declare("exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n"
      + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
      + "  use:\n    - plugin: probe\n      from: dev\n");
    fs.mkdirSync(path.join(workspaceDir, "pkg", "skills", "probe"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "pkg", "skills", "probe", "SKILL.md"), "---\nname: probe\n---\n");

    const result = preparePlugins(opts());

    expect(result.missing).toEqual([]);
    expect(result.linkFailed).toEqual([]);
  });
});

describe("preparePlugins — stale links (review finding)", () => {
  it("removes a link for a repo the declaration no longer names", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);

    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    const result = preparePlugins(opts());

    expect(result.unlinked).toEqual(["tools"]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(false);
  });

  it("drops its own link when the generation is retired under a still-declared repo", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);

    fs.rmSync(path.join(store, "tools", "active"));
    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    expect(fs.lstatSync(path.join(pluginsDir, "tools"), { throwIfNoEntry: false })).toBeUndefined();
    expect(result.unlinked).toEqual([]);
  });

  it("re-links once a generation is published again", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    preparePlugins(opts());
    fs.rmSync(path.join(store, "tools", "active"));
    preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), PROBE_MANIFEST);
    expect(preparePlugins(opts()).linked).toEqual(["tools"]);
    expect(fs.readlinkSync(path.join(pluginsDir, "tools"))).toBe(path.join(store, "tools", "active"));
  });

  it("leaves a broken link somebody else made alone", () => {
    declare();
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.symlinkSync(path.join(tmp, "nowhere"), path.join(pluginsDir, "tools"));

    preparePlugins(opts());

    expect(fs.readlinkSync(path.join(pluginsDir, "tools"))).toBe(path.join(tmp, "nowhere"));
  });

  it("leaves anything that is not our symlink alone", () => {
    declare();
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "not-ours"), "hands off");
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "not-ours"))).toBe(true);
  });
});
