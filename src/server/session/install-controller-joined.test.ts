import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { InstallController } from "./install-controller.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { parseMarker } from "../shared/install-marker.js";
import { INSTALL_MARKER_FILE } from "../shared/fs-constants.js";

/**
 * A request that arrives while an install runs joins it and is told the install started
 * (planning#702). When the workspace moved meanwhile — a claim reset the clone — the finished
 * install is for the tree before, so the worker installs again before it reports completion.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

describe("an install request that joins a running install", () => {
  let app: FastifyInstance | undefined;
  let root: string | undefined;

  afterEach(async () => {
    if (app) {
      await waitIdle(app);
      await app.close();
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
    app = undefined;
    root = undefined;
  });

  async function waitIdle(server: FastifyInstance): Promise<{ ok: boolean } | null> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = (await server.inject({ method: "GET", url: "/install/status" })).json() as {
        running: boolean;
        lastResult: { ok: boolean } | null;
      };
      if (!status.running) return status.lastResult;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("install did not finish");
  }

  function setup(opts: { command: string; installInputs?: string[] }) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "install-joined-"));
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const runsFile = path.join(root, "runs.log");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const inputs = opts.installInputs ? `  install-inputs: [${opts.installInputs.join(", ")}]\n` : "";
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(opts.command)}\n${inputs}`,
    );
    fs.writeFileSync(path.join(workspaceDir, "deps.txt"), "a\n");
    fs.writeFileSync(path.join(workspaceDir, "app.txt"), "v1\n");
    git(workspaceDir, "init", "-q");
    git(workspaceDir, "add", ".");
    git(workspaceDir, "commit", "-q", "-m", "B");

    const server = Fastify({ logger: false });
    app = server;
    const terminalEvents: string[] = [];
    const controller = new InstallController({
      workspaceDir,
      stateDir,
      broadcast: (event) => {
        if (event.type === "install_done" || event.type === "install_error") terminalEvents.push(event.type);
      },
      mcpConfig: {} as McpConfigController,
    });
    controller.registerRoutes(server);

    const runs = (): string[] =>
      fs.existsSync(runsFile) ? fs.readFileSync(runsFile, "utf8").split("\n").filter(Boolean) : [];
    return {
      controller,
      post: async (command = opts.command) =>
        (await server.inject({ method: "POST", url: "/install", payload: { commands: [command] } })).json(),
      terminalEvents,
      remove: (file: string): void => {
        git(workspaceDir, "rm", "-q", file);
        git(workspaceDir, "commit", "-q", "-m", `C: remove ${file}`);
      },
      moveTo: (file: string, content: string): string => {
        fs.writeFileSync(path.join(workspaceDir, file), content);
        git(workspaceDir, "add", file);
        git(workspaceDir, "commit", "-q", "-m", `C: ${file}`);
        return git(workspaceDir, "rev-parse", "HEAD");
      },
      runs: (): number => runs().length,
      runLines: runs,
      untilRuns: async (n: number): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (runs().length < n) {
          if (Date.now() > deadline) throw new Error(`fewer than ${n} install runs`);
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      markerCommit: (): string | null =>
        parseMarker(fs.readFileSync(path.join(stateDir, INSTALL_MARKER_FILE), "utf8"))?.sourceCommit ?? null,
      waitIdle: () => waitIdle(server),
    };
  }

  const SLOW_OK = "echo run >> ../runs.log && sleep 0.4";
  const SLOW_FAIL = "echo run >> ../runs.log && sleep 0.4 && exit 3";

  it("installs again for a joiner whose workspace moved during the install, and reports once", async () => {
    const w = setup({ command: SLOW_OK });
    expect(await w.post()).toEqual({ started: true });
    await w.untilRuns(1);
    const moved = w.moveTo("app.txt", "v2\n");
    expect(await w.post()).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runs()).toBe(2);
    expect(w.markerCommit()).toBe(moved);
    expect(w.terminalEvents).toEqual(["install_done"]);
  });

  it("reports the joiner's success when only the install for the tree before failed", async () => {
    // Each run logs its own exit status, decided before the line is written.
    const w = setup({ command: "test ! -f broken.txt; r=$?; echo run $r >> ../runs.log; sleep 0.4; exit $r" });
    w.moveTo("broken.txt", "x\n");
    expect(await w.post()).toEqual({ started: true });
    await w.untilRuns(1);
    w.remove("broken.txt");
    expect(await w.post()).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runLines()).toEqual(["run 1", "run 0"]);
    expect(w.terminalEvents).toEqual(["install_done"]);
  });

  it("after a stop, neither installs for the dropped join nor reports over the next install", async () => {
    const w = setup({ command: SLOW_OK });
    expect(await w.post()).toEqual({ started: true });
    await w.untilRuns(1);
    w.moveTo("app.txt", "v2\n");
    expect(await w.post()).toEqual({ started: true, joined: true });
    w.controller.stop();
    expect(await w.post("echo next >> ../runs.log && sleep 0.8")).toEqual({ started: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runLines()).toEqual(["run", "next"]);
    expect(w.terminalEvents).toEqual(["install_done"]);
  });

  it("installs the joiner's own commands when they differ", async () => {
    const w = setup({ command: SLOW_OK });
    expect(await w.post()).toEqual({ started: true });
    expect(await w.post("echo second >> ../runs.log")).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runs()).toBe(2);
    expect(fs.readFileSync(path.join(root!, "runs.log"), "utf8")).toBe("run\nsecond\n");
  });

  it("reports a marker that cannot be written as a failed install, not a hang", async () => {
    const w = setup({ command: "echo run >> ../runs.log" });
    fs.mkdirSync(path.join(root!, "state", INSTALL_MARKER_FILE));
    expect(await w.post()).toEqual({ started: true });

    expect(await w.waitIdle()).toMatchObject({ ok: false });
    expect(w.terminalEvents).toEqual(["install_error"]);
  });

  it("installs once for a joiner on the same tree", async () => {
    const w = setup({ command: SLOW_OK });
    expect(await w.post()).toEqual({ started: true });
    expect(await w.post()).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runs()).toBe(1);
  });

  it("installs once when the content key covers the move", async () => {
    const w = setup({ command: SLOW_OK, installInputs: ["deps.txt"] });
    expect(await w.post()).toEqual({ started: true });
    w.moveTo("app.txt", "v2\n");
    expect(await w.post()).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toEqual({ ok: true });
    expect(w.runs()).toBe(1);
  });

  it("installs again after a failed install for the tree before", async () => {
    const w = setup({ command: SLOW_FAIL });
    expect(await w.post()).toEqual({ started: true });
    w.moveTo("deps.txt", "a\nb\n");
    expect(await w.post()).toEqual({ started: true, joined: true });

    expect(await w.waitIdle()).toMatchObject({ ok: false });
    expect(w.runs()).toBe(2);
    expect(w.terminalEvents).toEqual(["install_error"]);
  });
});
