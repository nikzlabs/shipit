/**
 * docs/262 — the session-level resolver: a `shipit.yaml` on disk in, the compose
 * services that session surfaces out.
 *
 * Exercised through a `repo: self` declaration, which is the one shape that
 * needs no fetch and no Docker (req 27): the "checkout" is the workspace itself,
 * so the whole path runs against the integration fakes the way plan §5 asks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSessionPluginServices } from "./plugin-services.js";
import { getPluginServiceFailures } from "./plugin-activation.js";
import { PLUGIN_PORT_BAND_START } from "../plugin-ports.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "../session-state-dir.js";

let sessionDir: string;
let workspaceDir: string;

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-services-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(path.join(workspaceDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, SESSION_STATE_SUBDIR), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "tools", "docker-compose.yml"), `
services:
  probe:
    image: node:22-alpine
    volumes:
      - .:/app:ro
    ports:
      - "4820:4820"
`);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), body);
}

const SELF_DECLARATION = `
exports:
  plugins:
    probe:
      compose: tools/docker-compose.yml
plugins:
  repos:
    - repo: self
      name: mine
  use:
    - plugin: probe
      from: mine
`;

const resolve = (): Promise<Awaited<ReturnType<typeof resolveSessionPluginServices>>> =>
  resolveSessionPluginServices(SESSION_ID, workspaceDir, { containEgress: false });

describe("resolveSessionPluginServices", () => {
  it("surfaces a self-declared plugin's services with a published port", async () => {
    writeConfig(SELF_DECLARATION);
    const services = await resolve();
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: "probe", port: 4820, publishedPort: 4820 });
    expect(getPluginServiceFailures(SESSION_ID, "mine")).toEqual([]);
  });

  it("gives a plugin a different published port when the project already serves on it", async () => {
    writeConfig(`compose: docker-compose.yml\n${SELF_DECLARATION}`);
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), `
services:
  web:
    image: node:20
    ports:
      - "4820:4820"
`);
    const services = await resolve();
    expect(services[0].port).toBe(4820);
    expect(services[0].publishedPort).toBe(PLUGIN_PORT_BAND_START);
  });

  it("returns nothing, and records nothing, for a project that declares no plugins", async () => {
    writeConfig("compose: docker-compose.yml\n");
    expect(await resolve()).toEqual([]);
    expect(getPluginServiceFailures(SESSION_ID, "mine")).toEqual([]);
  });

  it("drops a tracked plugin with no runtime layer and remembers why", async () => {
    // A tracked repository with a live generation on disk, and no Docker to
    // build its overlay volume from — which is the state a `repo: self` session
    // can reach only by declaring one, so it is built here directly.
    const stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
    const generation = path.join(stateDir, "plugins", "tools", "generations", "abc123");
    fs.mkdirSync(path.join(generation, "tools"), { recursive: true });
    fs.writeFileSync(path.join(generation, "shipit.yaml"), `
exports:
  plugins:
    probe:
      compose: tools/docker-compose.yml
`);
    fs.writeFileSync(path.join(generation, "tools", "docker-compose.yml"), `
services:
  probe:
    image: node:22-alpine
`);
    fs.writeFileSync(
      path.join(generation, ".shipit-generation.json"),
      // `source` is what proves this generation belongs to the declaration that
      // names it; a record without it reads as unverified everywhere since
      // #2225, so the fixture has to carry it to reach the runtime-layer step.
      JSON.stringify({ repoName: "tools", source: "someone/tools", commit: "abc123", exports: ["probe"] }),
    );
    fs.symlinkSync(
      path.join("generations", "abc123"),
      path.join(stateDir, "plugins", "tools", "active"),
    );
    writeConfig(`
plugins:
  repos:
    - repo: someone/tools
      name: tools
  use:
    - plugin: probe
      from: tools
`);

    expect(await resolve()).toEqual([]);
    expect(getPluginServiceFailures(SESSION_ID, "tools")[0]).toContain("writable layer is not available");
  });

  it("clears a recorded failure once the declaration no longer has the problem", async () => {
    writeConfig(SELF_DECLARATION);
    await resolve();
    expect(getPluginServiceFailures(SESSION_ID, "tools")).toEqual([]);
  });
});
