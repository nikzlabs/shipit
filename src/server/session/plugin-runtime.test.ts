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

// `binDir` is pointed at the temp tree so the companion-CLI generator
// (reqs 17, 20 — covered in its own `plugin-cli.test.ts`) never touches the
// real `/plugin-bin` or this process's PATH from here.
const opts = () => ({ workspaceDir, storeDir: store, pluginsDir, binDir: path.join(tmp, "plugin-bin") });

/**
 * Publish a generation the way `plugin-generations.ts` does: dir + record +
 * `active` symlink.
 *
 * `source` defaults to the repository every declaration here points at. Pass
 * another value to publish what a RE-POINTED declaration leaves behind, or
 * `null` to publish a legacy record from before the field existed.
 */
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
  // The companion-CLI generator appends its wrapper directory to PATH (req 17),
  // so restore it rather than letting each case leave a temp dir behind.
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
    // …and SAYS so. A refusal that returns a bare `false` nobody reads renders
    // as a healthy card with none of the repository behind it (review finding).
    expect(result.linkFailed).toEqual([
      { repo: "tools", reason: expect.stringContaining("not a link ShipIt made") },
    ]);
  });

  it("does not report a repo with no live generation as a link failure", () => {
    // Declared, not yet fetched. The card already shows that as `unavailable`
    // from the generation state — reporting it here too would say one ordinary
    // fact twice, as an error.
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
    // Attributed, so the orchestrator can put it on a card (req 13). One
    // exclude file, but the consequence belongs to each repository that was
    // going to get skills — and to no other.
    expect(result.skillsFailed).toEqual([
      { repo: "tools", skill: "(all)", reason: expect.stringContaining("out of this clone's git") },
    ]);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"))))
      .toBe(false);
    // The link surface is unaffected — only the skills are withheld.
    expect(result.linked).toEqual(["tools"]);
  });

  // req 13 — the orchestrator turns this list into card issues, and a card is
  // keyed by the DECLARED repository name. A failure that names only the skill
  // has nowhere to render, which is how this half of prepare used to reach
  // nothing but the log.
  it("attributes a failure to the declared repository, in the declaration's spelling", () => {
    // `from:` matches case-insensitively, so the `use` entry's spelling is not
    // the card's key — the declaration's is.
    declare(
      "plugins:\n  repos:\n    - repo: acme/tools\n      name: Tools\n      branch: main\n"
      + "  use:\n    - plugin: probe\n      from: tools\n      alias: reqs\n",
    );
    // Declared `skills:` that this generation does not ship — a plugin
    // promising instructions it did not deliver.
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
    // Somebody else's directory is already at the published name, so the copy
    // is refused rather than deleting their work.
    const foreign = path.join(workspaceDir, ".claude", "skills", namespacedName("reqs", "probe"));
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: mine\n---\n");

    const failed = preparePlugins(opts()).skillsFailed;
    // The hashed directory name is right on disk and wrong on a card; the user
    // knows this skill as the import alias plus the skill's own name.
    expect(failed[0]?.repo).toBe("tools");
    expect(failed[0]?.skill).toBe("reqs/probe");
    expect(failed[0]?.reason).toContain("not created by ShipIt");
  });

  // A refresh republishes while a prepare pass is already running, and `active`
  // is a symlink publication swaps atomically. A pass that follows it more than
  // once can therefore read the manifest from one generation and the skill
  // files from the next (sibling finding, docs/262).
  it("describes ONE generation even when a refresh swaps `active` mid-pass", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, {
      "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nGeneration A.\n",
    });

    // Swap the moment the manifest has been read — the narrowest window there
    // is, and the one the unpinned code lost.
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
    // Not "the newest wins" — the point is that no ONE pass mixes the two.
    // Reading the skills through `active` again would take them from B while
    // the manifest that named them came from A.
    const body = realRead(
      path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe"), "SKILL.md"),
      "utf-8",
    );
    expect(body).toContain("Generation A.");
    // The content assertion above is the discriminating one; this only says the
    // pass completed cleanly. The worst unpinned outcome — `containedRealPath`
    // resolving base and target in two independent calls, so a swap between
    // them reports the plugin as resolving outside its own checkout — needs the
    // swap to land INSIDE that function, which this timing does not produce.
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

// req 19 — the standing grant is to fetch and execute the repository the
// declaration NAMES. Re-pointing a `repos:` entry leaves the previous
// repository's generation live under the same name until an activation round
// retires it, and that round is fire-and-forget behind a fetch that can take
// minutes or fail outright. Every orchestrator reader refuses such a generation;
// this half had no record check at all, so the generation the card refused was
// still the one the agent got.
describe("preparePlugins — a generation belongs to the repository the declaration names", () => {
  const SKILLS_MANIFEST = "exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n      cli:\n        probe: cli/probe.mjs\n";
  const FILES = { "pkg/skills/probe/SKILL.md": "---\nname: probe\n---\n\nBody.\n" };

  it("exposes nothing of a generation left by the PREVIOUS repository", () => {
    declare();
    // The declaration says `acme/tools`; what is live came from `acme/old`.
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES, "acme/old");

    const result = preparePlugins(opts());

    // Not linked, not skilled, not on PATH — one refusal reaching all three
    // halves of the pass, because they share one verified resolution.
    expect(result.linked).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, ".claude", "skills", namespacedName("probe", "probe")))).toBe(false);
    // Reported as `missing`, which the card already renders as unavailable —
    // and the activation that refused this generation is reporting its own
    // failure with a reason. A second failure row here would state one fact
    // twice, as two problems.
    expect(result.missing).toEqual(["tools"]);
    expect(result.skillsFailed).toEqual([]);
    // …and the card is TOLD why. `missing` never leaves the worker — the
    // orchestrator ingests only the failure lists — so without this the card
    // renders a bare `unavailable`, which is the wrong story: something is
    // published here, it is just not this declaration's (req 13 asks for the
    // why, not only the fact).
    expect(result.linkFailed).toEqual([
      { repo: "tools", reason: expect.stringContaining("published from `acme/old`") },
    ]);
  });

  it("refuses a legacy record with no source at all", () => {
    // #2225 deliberately does NOT delete such a generation: nothing can prove
    // whose it is, and deleting would drop every plugin in every live session on
    // the first deploy, ahead of a fetch that may fail. Refusing to EXPOSE it is
    // what makes keeping it safe.
    declare();
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES, null);

    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    expect(result.linked).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.commands).toEqual([]);
    // A legacy version cannot be blamed on a repository, so the reason says
    // what is actually true: it cannot be confirmed as this one's.
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

    // The consumer re-points `repos:` and the next generation to be published
    // is still the old repository's — the window before activation retires it.
    publishGeneration("tools", "b".repeat(40), SKILLS_MANIFEST, FILES, "acme/old");
    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    // Gone, not merely unreadable: the link resolves fine, it just resolves to
    // a repository this project's declaration does not name.
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

    // The point of the whole path is to stop the agent reaching a tree it may
    // not use. "We could not take it away" is the one outcome that must not
    // render as a clean `unavailable`.
    expect(result.linkFailed.map((f) => f.reason)).toEqual([
      expect.stringContaining("published from `acme/old`"),
      expect.stringContaining("could not be removed"),
    ]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);
  });

  it("matches the declaration's repository case-insensitively", () => {
    // `destinationKey` lowercases, and a consumer may write `AcMe/Tools`.
    declare("plugins:\n  repos:\n    - repo: AcMe/Tools\n      name: tools\n      branch: main\n"
      + "  use:\n    - plugin: probe\n      from: tools\n");
    publishGeneration("tools", "a".repeat(40), SKILLS_MANIFEST, FILES);

    expect(preparePlugins(opts()).linked).toEqual(["tools"]);
  });

  // `repo: self` has no generation, so there is nothing to check and nothing to
  // refuse. Asserted narrowly on purpose: a self import materializes no skills
  // today either (its consumer-path parity is still its own piece of work), so
  // this case must not be read as "self is fully supported".
  it("has nothing to refuse for `repo: self`, which has no generation (req 27)", () => {
    declare("exports:\n  plugins:\n    probe:\n      skills: pkg/skills\n"
      + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
      + "  use:\n    - plugin: probe\n      from: dev\n");
    fs.mkdirSync(path.join(workspaceDir, "pkg", "skills", "probe"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "pkg", "skills", "probe", "SKILL.md"), "---\nname: probe\n---\n");

    const result = preparePlugins(opts());

    // Never enters the link loop, so it can neither be reported missing nor
    // refused — the identity check is not consulted for it at all.
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

    // The declaration drops every plugin repo. A long-lived container would
    // otherwise keep exposing the old one until it was recreated.
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    const result = preparePlugins(opts());

    expect(result.unlinked).toEqual(["tools"]);
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(false);
  });

  // Re-pointing a `repos:` entry retires what the previous repository left,
  // while the declaration keeps naming the repo — so `removeStaleLinks` does not
  // see it as stale. The link would otherwise survive pointing at nothing.
  it("drops its own link when the generation is retired under a still-declared repo", () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    preparePlugins(opts());
    expect(fs.existsSync(path.join(pluginsDir, "tools"))).toBe(true);

    fs.rmSync(path.join(store, "tools", "active"));
    const result = preparePlugins(opts());

    expect(result.missing).toEqual(["tools"]);
    // Gone entirely — not merely unresolvable. `existsSync` follows the link, so
    // it cannot tell a removed entry from a dangling one; `lstat` can.
    expect(fs.lstatSync(path.join(pluginsDir, "tools"), { throwIfNoEntry: false })).toBeUndefined();
    // Not reported as unlinked: that list means the declaration dropped the
    // repo, and this declaration still names it.
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
    // Same name, different target — not ours to remove, broken or not.
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
