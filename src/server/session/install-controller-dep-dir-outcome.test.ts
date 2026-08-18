/**
 * docs/272 — an install's OUTCOME is not its exit status.
 *
 * The service gate (`ServiceManager.setInstallRunning(false, { failed })`) keys
 * on the install result, and that result was the exit status alone. An exit
 * status is trivially laundered, and in the field it was: a project whose
 * `npm ci` could not write the shared npm cache worked around it with
 * `npm --prefix game ci … || [ -x game/node_modules/.bin/vite ]`, so a failed
 * install exited 0, ShipIt stamped the install marker, and the gate opened six
 * seconds later over a dep tree that had never been built. The gated services
 * then crash-looped through all five post-install retries, with
 * `install finished — starting 2 gated service(s)` as the only line describing
 * what ShipIt thought had happened.
 *
 * The predicate is deliberately the SAME one `/install` already applies to a
 * matching marker (`emptyDepDirsContradictingMarker`): a declared dep dir that
 * is present-and-EMPTY contradicts the claim that the deps are installed. It
 * is applied on both sides now — ShipIt refuses to TRUST such a marker, so it
 * must equally refuse to WRITE one.
 *
 * ABSENT stays fine on both sides, and that asymmetry is load-bearing: a repo
 * with no install-managed dep dir (the default `node_modules` on a non-Node
 * project) must not be told its install failed.
 */

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

  /**
   * Run `/install` and settle. The route returns as soon as the install is
   * spawned (progress streams over SSE), so the outcome is read from
   * `/install/status` — the same probe the orchestrator's SSE-reconnect path
   * uses, which makes this assert the recovery surface too.
   */
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
    // The marker is the other half of the gate: writing one here would let the
    // NEXT activation skip the install entirely and re-open the gate over the
    // same empty tree, with no failure anywhere.
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(false);
  });

  it("fails when the install command launders its own non-zero exit", async () => {
    // The field shape, reduced: the real command was
    // `npm --prefix game ci … || [ -x game/node_modules/.bin/vite ]`.
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

  it("succeeds when a declared dep dir is ABSENT, not empty", async () => {
    // A repo whose install manages no dep dir at all — the default
    // `node_modules` on a project that never creates one. The skip path treats
    // absence as no contradiction, and so must this one, or every such repo
    // would be told its install failed and never start a gated service.
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - true\n  dep-dirs:\n    - node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("succeeds when the repo opts out with an empty dep-dirs list", async () => {
    // `agent.dep-dirs: []` is the documented opt-out, and it has to remain one:
    // a repo that declares nothing is declaring that nothing is checkable.
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules\n  dep-dirs: []\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules"]);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
  });

  it("still reports a non-zero exit as the command failure it is", async () => {
    // The pre-existing path must be untouched: a real non-zero exit reports the
    // command and its code, not the dep-dir diagnosis.
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
