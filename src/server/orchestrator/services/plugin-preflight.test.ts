/**
 * docs/262 plan §1a phase 3 — the pre-publish gate's own verdicts.
 *
 * The fixture is a real session layout on disk: a consuming project at
 * `<sessionDir>/workspace` with a `shipit.yaml` declaring a tracked plugin
 * repository, and a staged checkout in a directory nothing has published. That
 * is exactly what `activateGeneration` hands the gate, so these run the real
 * collector against the real declaration — no stubs on either side.
 *
 * A repository is made LIVE the way activation makes one live: a generation
 * directory with its record inside it, and the `active` symlink pointing at it.
 * Several of these findings only exist when a sibling is genuinely live, so the
 * fixture builds one rather than declaring one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStagedGenerationGate } from "./plugin-preflight.js";
import { buildPluginReposSnapshot } from "../../shared/plugin-repos.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";
import type { StagedGeneration } from "../plugin-generations.js";

let sessionDir: string;
let workspaceDir: string;
let stateDir: string;
let stagingDir: string;

const COMMIT = "a".repeat(40);
const TOOLS_SOURCE = "acme/tools";

/**
 * A consumer declaration importing `probe` from the tracked repo `tools`.
 *
 * It names a `compose:` file even before one exists, because that is what makes
 * the project's own services part of the collision domain — a project with no
 * `compose:` block has no stack, and the gate must not invent one from a
 * conventional filename (plan §1b).
 */
const CONSUMER = `
compose: docker-compose.yml
plugins:
  repos:
    - repo: acme/tools
      name: tools
      branch: main
  use:
    - plugin: probe
      from: tools
`;

/** The staged repository's own manifest — one export, one compose fragment. */
const MANIFEST = `
exports:
  plugins:
    probe:
      compose: probe/docker-compose.yml
      cli:
        probe: bin/probe.mjs
`;

const FRAGMENT = `
services:
  probe:
    image: node:22-alpine
    command: node /app/server.mjs
    volumes:
      - .:/app:ro
`;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-preflight-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  stagingDir = path.join(stateDir, "plugins", "tools", "generations", `${COMMIT}.staging-1234`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(stagingDir, "probe"), { recursive: true });
  declare(CONSUMER);
  writeStaged(MANIFEST, FRAGMENT);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeStaged(manifest: string, fragment: string): void {
  fs.writeFileSync(path.join(stagingDir, "shipit.yaml"), manifest);
  fs.writeFileSync(path.join(stagingDir, "probe", "docker-compose.yml"), fragment);
}

function judge(
  over: Partial<StagedGeneration> = {},
  opts: { containEgress?: boolean } = {},
): ReturnType<ReturnType<typeof createStagedGenerationGate>> {
  return createStagedGenerationGate({
    workspaceDir,
    containEgress: () => opts.containEgress ?? false,
  })({ repoName: "tools", source: TOOLS_SOURCE, commit: COMMIT, stagingDir, ...over });
}

/** Replace the consuming project's declaration for one test. */
function declare(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
}

/** Give the consuming project a stack of its own — the other half of req 20's domain. */
function declareProjectStack(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), body);
}

/**
 * Publish a generation for `name` the way activation does — record inside the
 * generation directory, `active` symlinked at it.
 */
function makeLive(name: string, source: string, manifest: string, fragment: string): void {
  const commit = "b".repeat(40);
  const dir = path.join(stateDir, "plugins", name, "generations", commit);
  fs.mkdirSync(path.join(dir, "probe"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(path.join(dir, "probe", "docker-compose.yml"), fragment);
  fs.writeFileSync(path.join(dir, ".shipit-generation.json"), JSON.stringify({
    repoName: name,
    source,
    commit,
    ref: "branch main",
    activatedAt: new Date().toISOString(),
    exports: ["probe"],
    manifestWarnings: [],
  }));
  fs.symlinkSync(path.join("generations", commit), path.join(stateDir, "plugins", name, "active"));
}

describe("the phase-3 gate (reqs 13, 15, 20)", () => {
  it("admits a candidate whose fragment is usable", () => {
    expect(judge()).toEqual({ ok: true });
  });

  it("refuses a candidate whose fragment cannot be used, naming what is wrong", () => {
    // `build:` is refused for plugin fragments: a plugin service's own files
    // reach it through the generation's overlay volume, which cannot be a build
    // context (`plugin-compose.ts`).
    writeStaged(MANIFEST, `
services:
  probe:
    build: .
`);
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    // req 13 — the user sees which service and which key, not "invalid fragment".
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("`probe`");
    expect(reason).toContain("build:");
    // And which version was rejected, since the card's other half is the prior
    // one that keeps running.
    expect(reason).toContain(COMMIT.slice(0, 9));
  });

  it("refuses a candidate whose service name the project already claims", () => {
    // The project's own compose file is the other half of req 20's domain, and
    // a project service always wins — it is the thing the consumer did not
    // import and cannot be asked to rename.
    declareProjectStack(`
services:
  probe:
    image: node:22-alpine
`);
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("collides");
  });

  it("admits the same candidate once the consumer renames the colliding service", () => {
    declareProjectStack(`
services:
  probe:
    image: node:22-alpine
`);
    declare(`
compose: docker-compose.yml
plugins:
  repos:
    - repo: acme/tools
      name: tools
      branch: main
  use:
    - plugin: probe
      from: tools
      overrides:
        services:
          probe:
            as: tools-probe
`);
    expect(judge()).toEqual({ ok: true });
  });

  /**
   * Domain 5 of the same phase, and deliberately NOT fatal (plan §1a's
   * amendment): a contested command withholds *that command* from every
   * claimant and activates everything else, because the clash is a defect in
   * the consuming declaration rather than in either repository's version, and
   * both are fixed in the same `use` entry. Failing the generation over it would
   * take out a working plugin's services and skills over a naming clash it did
   * not cause. The refusal is reported on the card by `plugin-commands.ts`.
   *
   * This is a guard on that ruling, not an omission: without it, the next slice
   * reads the gate as half-built and adds a second mechanism.
   */
  it("does not refuse a candidate over a companion-CLI command collision", () => {
    // `git` is a name ShipIt reserves outright — the strongest command refusal
    // there is, and still not a reason to withhold the whole version.
    writeStaged(`
exports:
  plugins:
    probe:
      compose: probe/docker-compose.yml
      cli:
        git: bin/probe.mjs
`, FRAGMENT);

    expect(judge()).toEqual({ ok: true });
  });

  it("admits a candidate that exports no compose fragment at all", () => {
    writeStaged(`
exports:
  plugins:
    probe:
      cli:
        probe: bin/probe.mjs
`, FRAGMENT);

    expect(judge()).toEqual({ ok: true });
  });
});

/**
 * req 14 — repositories are independent, in both directions. A sibling's own
 * problems must not hold this candidate back; this candidate must not take a
 * sibling's working services away. The claim order inside the collector is the
 * DECLARATION's, so the second half is not symmetric with the first and needs
 * its own rule (the differential half of the verdict).
 */
describe("the phase-3 gate and its siblings (req 14)", () => {
  const OTHER = `
compose: docker-compose.yml
plugins:
  repos:
    - repo: acme/tools
      name: tools
      branch: main
    - repo: acme/other
      name: other
      branch: main
  use:
    - plugin: probe
      from: tools
    - plugin: probe
      from: other
      alias: other-probe
`;

  it("is unmoved by a live sibling whose own fragment is broken", () => {
    declare(OTHER);
    // A genuinely live sibling with a genuinely unusable fragment — the shape a
    // declaration-only stand-in cannot produce, because the collector skips a
    // repository with no generation.
    makeLive("other", "acme/other", MANIFEST, "services:\n  side:\n    build: .\n");

    expect(judge()).toEqual({ ok: true });
  });

  it("refuses a candidate that would take a live sibling's services away", () => {
    declare(OTHER);
    // The sibling is live and serving `side`. `tools` is declared FIRST, so the
    // collector would hand it the name and attribute the collision to `other` —
    // the staged repository would look blameless and publish, silently
    // disabling a repository that works today.
    makeLive("other", "acme/other", MANIFEST, `
services:
  side:
    image: node:22-alpine
`);
    writeStaged(MANIFEST, `
services:
  side:
    image: node:22-alpine
`);
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("`other`");
    expect(reason).toContain("collides");
  });
});

/**
 * Fail closed. Each of these is a state in which the gate cannot know the
 * answer, and publishing without knowing is the partial version it exists to
 * prevent. A refusal keeps the prior version whole and is retried next round.
 */
describe("the phase-3 gate fails closed (reqs 13, 15)", () => {
  // A `shipit.yaml` edit landing mid-round. Admitting the candidate looks
  // harmless and is not: the round behind this one maps only the repositories
  // the project CURRENTLY declares, so a removed one gets no follow-up — and
  // re-adding it at the same commit returns `unchanged` before the gate is
  // consulted, so an ungated generation becomes live.
  it("refuses a candidate whose declaration has gone away", () => {
    declare("plugins:\n  repos: []\n  use: []\n");
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("changed while");
  });

  // A name is not identity: the same `tools` entry can be re-pointed at another
  // repository mid-round, and this candidate's files are the previous one's.
  it("refuses a candidate whose declaration was re-pointed at another repository", () => {
    declare(CONSUMER.replace("acme/tools", "acme/elsewhere"));
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("changed while");
  });

  // The project's own stack is UNKNOWN, not absent — publishing against an
  // unknown name domain is how a colliding candidate goes live and has its
  // services withheld by the very next service round.
  it("refuses when the project's own compose file cannot be read", () => {
    declareProjectStack("services: [this is: : not yaml\n");
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("could not read this project's own compose file");
    // planning#377 — and where the parse gave up, which used to be discarded.
    expect(reason).toContain("not valid YAML");
  });

  /**
   * planning#377 — the file is not unreadable. ShipIt read it, understood it,
   * and REFUSED it, and it already holds the sentence that names the one line
   * to add. Calling that "could not read" sent the user hunting for a syntax
   * error in a file that has none — and the rule refuses STOCK compose files,
   * so this is the normal first contact with a contained session, not an edge.
   */
  it("says a refused project compose file was refused, and why", () => {
    // A declared ROOT user: valid YAML the rule declines. It was an absent
    // `user:` until docs/271 stopped refusing that one.
    declareProjectStack(`
services:
  web:
    image: node:22-alpine
    user: "0"
`);
    const verdict = judge({}, { containEgress: true });

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("refuses this project's own compose file");
    expect(reason).not.toContain("could not read");
    // The actionable half: the rule, and the line that satisfies it.
    expect(reason).toContain("`web`");
    expect(reason).toContain("`user:`");
    expect(reason).toContain(COMMIT.slice(0, 9));
  });

  /**
   * The reason is only a fix if the user can see it. It travels:
   * verdict → `activateGeneration`'s failed outcome → the repository's
   * activation state `error` → the runtime entry the `/api/plugin-repos` route
   * builds → `issues[0]` on the card the Plugins tab renders. This asserts the
   * last hop with the real message, so a reason that reaches a new field and
   * stops there fails here.
   */
  it("puts that reason at the top of the repository's card", () => {
    declareProjectStack(`
services:
  web:
    image: node:22-alpine
    user: "0"
`);
    const reason = (judge({}, { containEgress: true }) as { reason: string }).reason;

    const snapshot = buildPluginReposSnapshot(
      resolveShipitConfig(workspaceDir).plugins,
      [],
      null,
      [],
      { tools: { activating: false, error: reason } },
    );

    // `error` is unshifted ahead of every advisory — the failure is the headline.
    expect(snapshot.repos[0].issues[0]).toBe(reason);
    expect(snapshot.repos[0].issues[0]).toContain("`user:`");
  });

  it("refuses when it cannot read the declaration at all", () => {
    declare("plugins: [oh: : no\n");
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("could not check");
  });
});
