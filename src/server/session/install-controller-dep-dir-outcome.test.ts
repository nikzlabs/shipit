import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InstallController } from "./install-controller.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";

// Quote "true" commands in YAML: booleans invalidate config and bypass the dep checks.
function makeWorkspace(agentBlock: string): { workspaceDir: string; stateDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-dep-outcome-"));
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

describe("install outcome — declared dep dirs must actually hold something", () => {
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

  async function runInstall(commands: string[]): Promise<{ ok: boolean; message?: string }> {
    const res = await app.inject({ method: "POST", url: "/install", payload: { commands } });
    expect(res.json()).toEqual({ started: true });
    for (let i = 0; i < 200; i++) {
      const status = (await app.inject({ method: "GET", url: "/install/status" })).json() as {
        running: boolean;
        lastResult: { ok: boolean; message?: string } | null;
      };
      if (!status.running && status.lastResult) return status.lastResult;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("install never settled");
  }

  const errorMessages = () =>
    events
      .filter((e) => e.type === "install_error")
      .map((e) => (e.data as { message: string }).message);

  it("fails an install that exits 0 but leaves a declared dep dir empty", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("node_modules");
    expect(errorMessages().join("\n")).toContain("node_modules");
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(false);
  });

  it("fails when the install command launders its own non-zero exit", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules && false || true\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules && false || true"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("agent.dep-dirs");
  });

  it("succeeds, and writes the marker, when the dep dir is populated", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules/pkg\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules/pkg"]);

    expect(result.ok).toBe(true);
    expect(errorMessages()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("fails when ANY declared dep dir is empty, even with the others populated", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules/pkg tools/node_modules\n" +
        "  dep-dirs:\n    - node_modules\n    - tools/node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules/pkg tools/node_modules"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("tools/node_modules");
    expect(result.message).not.toContain(" node_modules,");
  });

  it("succeeds when a declared dep dir is ABSENT, not empty", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("succeeds when the repo opts out with an empty dep-dirs list", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules\n  dep-dirs: []\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules"]);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  function writeNpmTree(
    workspaceDir: string,
    required: Record<string, { version: string }>,
    installed: Record<string, { version: string }> | null,
  ): void {
    const lock = (packages: Record<string, { version: string }>) =>
      JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { "": { version: "0.0.0" }, ...packages } });
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), lock(required));
    fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
    if (installed !== null) {
      fs.writeFileSync(path.join(workspaceDir, "node_modules", ".package-lock.json"), lock(installed));
    }
  }

  it("fails when a `||` fallback exits 0 over a present-but-STALE tree", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - false || true\n  dep-dirs:\n    - node_modules\n",
    );
    writeNpmTree(workspaceDir, { "node_modules/vite": { version: "5.4.0" } }, { "node_modules/vite": { version: "4.0.0" } });
    register(workspaceDir, stateDir);

    const result = await runInstall(["false || true"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("package-lock.json");
    expect(result.message).toContain("node_modules/vite");
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(false);
  });

  it("succeeds when the tree matches the lockfile", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n",
    );
    writeNpmTree(workspaceDir, { "node_modules/vite": { version: "5.4.0" } }, { "node_modules/vite": { version: "5.4.0" } });
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(errorMessages()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("succeeds for a legitimately PARTIAL dep dir — the regression guard", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n    - dist\n",
    );
    writeNpmTree(workspaceDir, { "node_modules/vite": { version: "5.4.0" } }, null);
    fs.mkdirSync(path.join(workspaceDir, "node_modules", "vite"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "dist", "bundle.js"), "// built once");
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(errorMessages()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("succeeds when a workspaces install hoisted a declared dep dir away", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n" +
        "    - server/node_modules\n    - web/node_modules\n",
    );
    const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" } };
    for (const [name, target] of [["@fix/server", "server"], ["@fix/web", "web"]]) {
      packages[`node_modules/${name}`] = { resolved: target, link: true };
      packages[target] = { name, version: "1.0.0" };
    }
    const lockfile = JSON.stringify({ name: "root", lockfileVersion: 3, packages });
    fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "node_modules", ".package-lock.json"), lockfile);
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), lockfile);
    fs.mkdirSync(path.join(workspaceDir, "server", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "web", "node_modules"), { recursive: true });
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(errorMessages()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
    const logs = events
      .filter((e) => e.type === "install_log")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(logs).toContain("server/node_modules, web/node_modules");
  });

  it("still fails when npm's record says an empty workspace dir holds a tree", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n" +
        "    - server/node_modules\n    - web/node_modules\n",
    );
    const packages: Record<string, unknown> = {
      "": { name: "root", version: "1.0.0" },
      "server/node_modules/lodash": { version: "3.10.1", resolved: "https://x/lodash" },
    };
    for (const [name, target] of [["@fix/server", "server"], ["@fix/web", "web"]]) {
      packages[`node_modules/${name}`] = { resolved: target, link: true };
    }
    const lockfile = JSON.stringify({ name: "root", lockfileVersion: 3, packages });
    fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "node_modules", ".package-lock.json"), lockfile);
    fs.writeFileSync(path.join(workspaceDir, "package-lock.json"), lockfile);
    fs.mkdirSync(path.join(workspaceDir, "server", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "web", "node_modules"), { recursive: true });
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("server/node_modules");
    expect(result.message).not.toContain("web/node_modules");
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(false);
  });

  it("still fails a hoisting monorepo whose ROOT dep dir is empty", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - false || true\n  dep-dirs:\n    - node_modules\n    - server/node_modules\n",
    );
    fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "server", "node_modules"), { recursive: true });
    register(workspaceDir, stateDir);

    const result = await runInstall(["false || true"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("node_modules, server/node_modules");
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(false);
  });

  it("still reports a non-zero exit as the command failure it is", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - exit 3\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["exit 3"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("exited with code 3");
    expect(result.message).not.toContain("agent.dep-dirs");
  });
});
