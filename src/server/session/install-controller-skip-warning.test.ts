import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InstallController } from "./install-controller.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { runtimeKey } from "./install-runtime.js";
import { makeMarker, serializeMarker } from "../shared/install-marker.js";
import { computeInstallDepsHash } from "../shared/deps-hash.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";

function makeWorkspace(agentBlock: string): { workspaceDir: string; stateDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-skip-warn-"));
  const workspaceDir = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), `agent:\n${agentBlock}`);
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0" }),
  );
  return { workspaceDir, stateDir };
}

function writeMatchingMarker(workspaceDir: string, stateDir: string, commands: string[]): void {
  const stamp = {
    sourceCommit: null,
    runtimeKey: runtimeKey(),
    installCommands: commands,
    depsHash: computeInstallDepsHash(workspaceDir, commands, null),
  };
  fs.writeFileSync(
    path.join(stateDir, INSTALL_MARKER_FILE),
    serializeMarker(makeMarker(stamp, new Date().toISOString())),
  );
}

describe("install skip warning — controller wiring", () => {
  let app: FastifyInstance;
  let events: WorkerSSEEvent[];
  let tmpRoots: string[];

  beforeEach(() => {
    events = [];
    tmpRoots = [];
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  function register(workspaceDir: string, stateDir: string): void {
    tmpRoots.push(path.dirname(workspaceDir));
    new InstallController({
      workspaceDir,
      stateDir,
      broadcast: (e) => events.push(e),
      mcpConfig: {} as McpConfigController,
    }).registerRoutes(app);
  }

  const logText = () =>
    events
      .filter((e) => e.type === "install_log")
      .map((e) => (e.data as { text: string }).text)
      .join("");

  it("logs the warning on a skip, and still skips", async () => {
    const commands = ["npm ci", "npm run build"];
    const { workspaceDir, stateDir } = makeWorkspace("  install:\n    - npm ci\n    - npm run build\n");
    writeMatchingMarker(workspaceDir, stateDir, commands);
    register(workspaceDir, stateDir);

    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });

    expect(res.json()).toEqual({ skipped: true, reason: "marker" });
    expect(logText()).toContain("npm run build");
    expect(logText()).toContain("agent.dep-dirs");
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("says nothing when dep-dirs covers the build output", async () => {
    const commands = ["npm ci", "npm run build"];
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - npm ci\n    - npm run build\n  dep-dirs:\n    - node_modules\n    - dist\n",
    );
    writeMatchingMarker(workspaceDir, stateDir, commands);
    register(workspaceDir, stateDir);

    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });

    expect(res.json()).toEqual({ skipped: true, reason: "marker" });
    expect(logText()).toBe("");
  });

  it("says nothing when the install is a plain dependency install", async () => {
    const commands = ["npm ci"];
    const { workspaceDir, stateDir } = makeWorkspace("  install:\n    - npm ci\n");
    writeMatchingMarker(workspaceDir, stateDir, commands);
    register(workspaceDir, stateDir);

    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });

    expect(res.json()).toEqual({ skipped: true, reason: "marker" });
    expect(logText()).toBe("");
  });

  // nikzlabs/shipit#3234: the shape an npm run killed part-way leaves behind.
  function writeNpmProject(workspaceDir: string, opts: { recorded: boolean }): void {
    const lockfile = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: { "": { version: "0.0.0" }, "node_modules/vite": { version: "5.4.10" } },
    });
    fs.writeFileSync(path.join(workspaceDir, "web", "package-lock.json"), lockfile);
    fs.mkdirSync(path.join(workspaceDir, "web", "node_modules", "vite"), { recursive: true });
    if (opts.recorded) {
      fs.writeFileSync(path.join(workspaceDir, "web", "node_modules", ".package-lock.json"), lockfile);
    }
  }

  it("reinstalls when the marker matches but a restored npm tree is incomplete", async () => {
    const commands = ["true"];
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - web/node_modules\n",
    );
    fs.mkdirSync(path.join(workspaceDir, "web"));
    writeNpmProject(workspaceDir, { recorded: false });
    writeMatchingMarker(workspaceDir, stateDir, commands);
    register(workspaceDir, stateDir);

    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });

    expect(res.json()).toEqual({ started: true });
    expect(logText()).toContain("web/node_modules");
    expect(logText()).toContain("reinstalling");
    for (let i = 0; i < 200; i++) {
      const status = (await app.inject({ method: "GET", url: "/install/status" })).json() as {
        running: boolean;
      };
      if (!status.running) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  it("still skips when the restored npm tree holds everything npm recorded", async () => {
    const commands = ["true"];
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - web/node_modules\n",
    );
    fs.mkdirSync(path.join(workspaceDir, "web"));
    writeNpmProject(workspaceDir, { recorded: true });
    writeMatchingMarker(workspaceDir, stateDir, commands);
    register(workspaceDir, stateDir);

    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });

    expect(res.json()).toEqual({ skipped: true, reason: "marker" });
    expect(logText()).toBe("");
  });
});
