import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStagedGenerationGate } from "./plugin-preflight.js";
import { buildPluginReposSnapshot } from "../../shared/plugin-repos.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";
import type { StagedGeneration } from "../plugin-generations.js";
import { expectInvalidShipitConfig } from "../../shared/shipit-config-test-guard.js";
import { localProjectComposeAccess } from "../compose-test-helpers.js";

let sessionDir: string;
let workspaceDir: string;
let stateDir: string;
let stagingDir: string;

const COMMIT = "a".repeat(40);
const TOOLS_SOURCE = "acme/tools";

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
    projectCompose: localProjectComposeAccess(workspaceDir),
  })({ repoName: "tools", source: TOOLS_SOURCE, commit: COMMIT, stagingDir, ...over });
}

function declare(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
}

function declareProjectStack(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), body);
}

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
  it("admits a candidate whose fragment is usable", async () => {
    expect(await judge()).toEqual({ ok: true });
  });

  it("refuses a candidate whose fragment cannot be used, naming what is wrong", async () => {
    writeStaged(MANIFEST, `
services:
  probe:
    build: .
`);
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("`probe`");
    expect(reason).toContain("build:");
    expect(reason).toContain(COMMIT.slice(0, 9));
  });

  it("refuses a candidate whose service name the project already claims", async () => {
    declareProjectStack(`
services:
  probe:
    image: node:22-alpine
`);
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("collides");
  });

  it("admits the same candidate once the consumer renames the colliding service", async () => {
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
    expect(await judge()).toEqual({ ok: true });
  });

  it("does not refuse a candidate over a companion-CLI command collision", async () => {
    writeStaged(`
exports:
  plugins:
    probe:
      compose: probe/docker-compose.yml
      cli:
        git: bin/probe.mjs
`, FRAGMENT);

    expect(await judge()).toEqual({ ok: true });
  });

  it("admits a candidate that exports no compose fragment at all", async () => {
    writeStaged(`
exports:
  plugins:
    probe:
      cli:
        probe: bin/probe.mjs
`, FRAGMENT);

    expect(await judge()).toEqual({ ok: true });
  });
});

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

  it("is unmoved by a live sibling whose own fragment is broken", async () => {
    declare(OTHER);
    makeLive("other", "acme/other", MANIFEST, "services:\n  side:\n    build: .\n");

    expect(await judge()).toEqual({ ok: true });
  });

  it("refuses a candidate that would take a live sibling's services away", async () => {
    declare(OTHER);
    // Declaration order attributes this collision to the live sibling.
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
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("`other`");
    expect(reason).toContain("collides");
  });
});

describe("the phase-3 gate fails closed (reqs 13, 15)", () => {
  it("refuses a candidate whose declaration has gone away", async () => {
    declare("plugins:\n  repos: []\n  use: []\n");
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("changed while");
  });

  it("refuses a candidate whose declaration was re-pointed at another repository", async () => {
    declare(CONSUMER.replace("acme/tools", "acme/elsewhere"));
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("changed while");
  });

  it("refuses when the project's own compose file cannot be read", async () => {
    declareProjectStack("services: [this is: : not yaml\n");
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("could not read this project's own compose file");
    expect(reason).toContain("not valid YAML");
  });

  it("says a refused project compose file was refused, and why", async () => {
    declareProjectStack(`
services:
  web:
    image: node:22-alpine
    extends: { file: base.yml, service: web }
`);
    const verdict = await judge({}, { containEgress: true });

    expect(verdict.ok).toBe(false);
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain("refuses this project's own compose file");
    expect(reason).not.toContain("could not read");
    expect(reason).toContain("`web`");
    expect(reason).toContain("`extends`");
    expect(reason).toContain(COMMIT.slice(0, 9));
  });

  it("puts that reason at the top of the repository's card", async () => {
    declareProjectStack(`
services:
  web:
    image: node:22-alpine
    extends: { file: base.yml, service: web }
`);
    const reason = (await judge({}, { containEgress: true }) as { reason: string }).reason;

    const snapshot = buildPluginReposSnapshot(
      resolveShipitConfig(workspaceDir).plugins,
      [],
      null,
      [],
      { tools: { activating: false, error: reason } },
    );

    expect(snapshot.repos[0].issues[0]).toBe(reason);
    expect(snapshot.repos[0].issues[0]).toContain("`extends`");
  });

  it("refuses when it cannot read the declaration at all", async () => {
    expectInvalidShipitConfig(() => {
      declare("plugins: [oh: : no\n");
    });
    const verdict = await judge();

    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("could not check");
  });
});

describe("the phase-3 gate reads the project file through its confined reader (docs/318)", () => {
  it("reads the project file for each verdict and never admits unknown names", async () => {
    declareProjectStack("services:\n  web:\n    image: node:22-alpine\n");
    const reads: string[] = [];
    const gate = createStagedGenerationGate({
      workspaceDir,
      containEgress: () => false,
      projectCompose: {
        readProjectFile: (file) => { reads.push(file); return Promise.reject(new Error("helper image missing")); },
        dockerSocketGrant: () => "not_granted",
        opsSession: false,
      },
    });
    const verdict = await gate({ repoName: "tools", source: TOOLS_SOURCE, commit: COMMIT, stagingDir });
    expect(reads).toEqual(["docker-compose.yml"]);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("helper image missing");
  });

  it("refuses when it has no reader for the project file", async () => {
    declareProjectStack("services:\n  web:\n    image: node:22-alpine\n");
    const verdict = await createStagedGenerationGate({ workspaceDir, containEgress: () => false })(
      { repoName: "tools", source: TOOLS_SOURCE, commit: COMMIT, stagingDir },
    );
    expect(verdict.ok).toBe(false);
  });
});
