/**
 * docs/262 plan §1a phase 3 — the pre-publish gate's own verdicts.
 *
 * The fixture is a real session layout on disk: a consuming project at
 * `<sessionDir>/workspace` with a `shipit.yaml` declaring a tracked plugin
 * repository, and a staged checkout in a directory nothing has published. That
 * is exactly what `activateGeneration` hands the gate, so these run the real
 * collector against the real declaration — no stubs on either side.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStagedGenerationGate } from "./plugin-preflight.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";
import type { StagedGeneration } from "../plugin-generations.js";

let sessionDir: string;
let workspaceDir: string;
let stagingDir: string;

const COMMIT = "a".repeat(40);

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
    ports:
      - "4820:4820"
`;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-preflight-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stagingDir = path.join(sessionDir, SESSION_STATE_SUBDIR, "plugins", "tools", "generations", `${COMMIT}.staging-1234`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(stagingDir, "probe"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), CONSUMER);
  writeStaged(MANIFEST, FRAGMENT);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeStaged(manifest: string, fragment: string): void {
  fs.writeFileSync(path.join(stagingDir, "shipit.yaml"), manifest);
  fs.writeFileSync(path.join(stagingDir, "probe", "docker-compose.yml"), fragment);
}

function judge(over: Partial<StagedGeneration> = {}): ReturnType<ReturnType<typeof createStagedGenerationGate>> {
  return createStagedGenerationGate({
    workspaceDir,
    containEgress: () => false,
  })({ repoName: "tools", commit: COMMIT, stagingDir, ...over });
}

/** Replace the consuming project's declaration for one test. */
function declare(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
}

/** Give the consuming project a stack of its own — the other half of req 20's domain. */
function declareProjectStack(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), body);
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

  // req 14 — repositories are independent. Another declared repository whose
  // services cannot be surfaced is that repository's problem, reported on its
  // own card; it must not hold this one at its previous version.
  it("is unmoved by another repository's problems", () => {
    declare(`
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
    - plugin: broken
      from: other
`);
    expect(judge()).toEqual({ ok: true });
  });

  // A `shipit.yaml` edit landing mid-round. There is no declaration left to
  // judge the candidate against, and the edit has already queued its own round
  // behind this one.
  it("admits a candidate whose declaration has gone away", () => {
    declare("plugins:\n  repos: []\n  use: []\n");
    expect(judge()).toEqual({ ok: true });
  });

  // Fail closed: publishing on an error we cannot explain is the partial state
  // this gate exists to prevent, and a refusal is visible and recoverable.
  it("refuses when it cannot read the declaration at all", () => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "plugins: [oh: : no\n");
    const verdict = judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("could not check");
  });
});
