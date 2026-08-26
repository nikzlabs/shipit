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
 * matching marker (`classifyEmptyDepDirs`): a declared dep dir that
 * is present-and-EMPTY contradicts the claim that the deps are installed. It
 * is applied on both sides now — ShipIt refuses to TRUST such a marker, so it
 * must equally refuse to WRITE one.
 *
 * ABSENT stays fine on both sides, and that asymmetry is load-bearing: a repo
 * with no install-managed dep dir (the default `node_modules` on a non-Node
 * project) must not be told its install failed.
 *
 * planning#480 — and so does an empty dir npm HOISTED away, which the overlay
 * dep store's mount points turn from absent into present-and-empty. Same
 * predicate, both sides, so the skip path and this one cannot diverge.
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

/**
 * Build a temp workspace whose `shipit.yaml` carries `agentBlock`.
 *
 * **Quote a bare `true` in `agent.install`** (`- "true"`, never `- true`): YAML
 * parses the unquoted form as a BOOLEAN, `resolveShipitConfig` rejects it, and
 * every dep-dir check in this file then takes its "config unreadable → check
 * nothing" branch. Three tests here were passing that way — asserting a success
 * the checks never actually evaluated — until planning#480 needed one of them
 * to discriminate.
 */
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

  it("fails when ANY declared dep dir is empty, even with the others populated", async () => {
    // The design choice, made explicit: the check is `empty.length > 0`, so one
    // empty declaration fails the whole install. That is the incident's own
    // shape (`game/node_modules` and `tools/debug/node_modules` were both
    // declared) and the conservative reading — a gated service may depend on
    // either directory, and ShipIt cannot tell which. The escape hatch is the
    // declaration itself: a repo that does not produce a directory should not
    // name it in `agent.dep-dirs`.
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - mkdir -p node_modules/pkg tools/node_modules\n" +
        "  dep-dirs:\n    - node_modules\n    - tools/node_modules\n",
    );
    register(workspaceDir, stateDir);

    const result = await runInstall(["mkdir -p node_modules/pkg tools/node_modules"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("tools/node_modules");
    // And it names ONLY the offender, so the message points at the declaration
    // to fix rather than at the whole list.
    expect(result.message).not.toContain(" node_modules,");
  });

  it("succeeds when a declared dep dir is ABSENT, not empty", async () => {
    // A repo whose install manages no dep dir at all — the default
    // `node_modules` on a project that never creates one. The skip path treats
    // absence as no contradiction, and so must this one, or every such repo
    // would be told its install failed and never start a gated service.
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n",
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

  /**
   * nikzlabs#2496 — the STALE half. `empty` catches only the emptiest case; a
   * dep dir still holding the PREVIOUS commit's tree passes it, so the same
   * laundered exit status stamps a marker for the current commit and opens the
   * gate over dependencies that do not match the code.
   */
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
    // Non-empty, so the docs/272 emptiness check passes it — and npm's own
    // record says the tree holds vite 4 while the lockfile asks for vite 5.
    writeNpmTree(workspaceDir, { "node_modules/vite": { version: "5.4.0" } }, { "node_modules/vite": { version: "4.0.0" } });
    register(workspaceDir, stateDir);

    const result = await runInstall(["false || true"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("package-lock.json");
    expect(result.message).toContain("node_modules/vite");
    // Same other half of the gate as the empty case: no marker, so the next
    // activation cannot skip the install and re-open the gate over this tree.
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
    // The `dep-dirs` contract permits declaring a directory a given install does
    // not fully produce, and the doc actively invites declaring a build output.
    // Neither holds an npm record, so neither is compared to a lockfile: here
    // `node_modules` is populated but un-reified (no `.package-lock.json`) while
    // a lockfile sits beside it, and `dist/` holds a stale build nobody rebuilt.
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

  /**
   * planning#480 — the npm-workspaces monorepo, reported from production. Three
   * declared dep dirs; a root `npm install` hoists every package into the root
   * tree and creates no `server/node_modules` at all. The overlay dep store
   * mounts a volume at each declared dir anyway, so the two workspace dirs are
   * present-and-EMPTY rather than absent, and `emptyDepDirsContradictingMarker`'s
   * documented "absence keeps the skip" hatch never fired. Every session of the
   * repo reported a permanent install failure, retrying every 30 seconds, while
   * the app ran correctly the whole time.
   */
  it("succeeds when a workspaces install hoisted a declared dep dir away", async () => {
    const { workspaceDir, stateDir } = makeWorkspace(
      "  install:\n    - \"true\"\n  dep-dirs:\n    - node_modules\n" +
        "    - server/node_modules\n    - web/node_modules\n",
    );
    // The root tree the install produced, carrying npm's own record of the two
    // workspaces it reified as links.
    const packages: Record<string, unknown> = { "": { name: "root", version: "1.0.0" } };
    for (const [name, target] of [["@fix/server", "server"], ["@fix/web", "web"]]) {
      packages[`node_modules/${name}`] = { resolved: target, link: true };
      packages[target] = { name, version: "1.0.0" };
    }
    fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "node_modules", ".package-lock.json"),
      JSON.stringify({ name: "root", lockfileVersion: 3, packages }),
    );
    // The overlay mount points, empty because everything hoisted to the root.
    fs.mkdirSync(path.join(workspaceDir, "server", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "web", "node_modules"), { recursive: true });
    register(workspaceDir, stateDir);

    const result = await runInstall(["true"]);

    expect(result.ok).toBe(true);
    expect(errorMessages()).toEqual([]);
    // The marker matters as much as the outcome: without it the next activation
    // reinstalls, which is the 30-second retry loop the incident reported.
    expect(fs.existsSync(path.join(stateDir, INSTALL_MARKER_FILE))).toBe(true);
    // Accepted, but not silently — the declaration still does not describe what
    // this install produces, and only the user can decide whether to trim it.
    const logs = events
      .filter((e) => e.type === "install_log")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(logs).toContain("server/node_modules, web/node_modules");
  });

  it("still fails a hoisting monorepo whose ROOT dep dir is empty", async () => {
    // The exemption cannot excuse the dir it would have to be read from. With the
    // root tree empty there is no npm record at all — the docs/183 mode 1 / mode 2
    // signature, and the shape a laundered `npm ci` leaves behind.
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
