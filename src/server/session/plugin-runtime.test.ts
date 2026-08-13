/**
 * docs/262 — the container half: what the agent ends up seeing under
 * `/plugins`, and when a plugin's `install` runs, re-runs, or is skipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePlugins } from "./plugin-runtime.js";
import { WORKER_TOKEN_ENV } from "../shared/worker-auth.js";

let tmp: string;
let workspaceDir: string;
let store: string;
let storeRw: string;
let pluginsDir: string;

/** Commands the injected runner saw, with the cwd/env they would have run in. */
let ran: { command: string; cwd: string; env: NodeJS.ProcessEnv }[];
let exitCode: number;

const run = async (command: string, cwd: string, env: NodeJS.ProcessEnv) => {
  ran.push({ command, cwd, env });
  return { code: exitCode, stderrTail: exitCode === 0 ? "" : "boom" };
};

const opts = () => ({ workspaceDir, storeDir: store, storeRwDir: storeRw, pluginsDir, run });

/** Publish a generation the way `plugin-generations.ts` does: dir + `active` symlink. */
function publishGeneration(repoName: string, commit: string, manifest: string, files: Record<string, string> = {}): string {
  const dir = path.join(store, repoName, "generations", commit);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({ repoName, commit, ref: "branch main", activatedAt: "", exports: [] }),
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runtime-"));
  workspaceDir = path.join(tmp, "workspace");
  // One host directory, two views — exactly how the container sees it.
  store = path.join(tmp, "plugin-store");
  storeRw = store;
  pluginsDir = path.join(tmp, "plugins");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  ran = [];
  exitCode = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function declare(yaml = DECLARATION): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

describe("preparePlugins — the agent-facing surface", () => {
  it("links a live checkout at /plugins/<name>", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);

    const result = await preparePlugins(opts());

    expect(result.linked).toEqual(["tools"]);
    // The link target must be the STORE path, not the generation: both hops
    // resolve in-container, so a later generation swap is visible with no
    // remount (plan §2 "as built").
    expect(fs.readlinkSync(path.join(pluginsDir, "tools"))).toBe(path.join(store, "tools", "active"));
    expect(fs.existsSync(path.join(pluginsDir, "tools", "shipit.yaml"))).toBe(true);
  });

  it("follows a generation swap without re-linking", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "mark.txt": "first" });
    await preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), PROBE_MANIFEST, { "mark.txt": "second" });

    // No second prepare — the symlink chain alone must resolve to the new one.
    expect(fs.readFileSync(path.join(pluginsDir, "tools", "mark.txt"), "utf8")).toBe("second");
  });

  it("reports a declared repo with no generation instead of failing", async () => {
    declare();
    const result = await preparePlugins(opts());
    expect(result.missing).toEqual(["tools"]);
    expect(result.installs).toEqual([]);
  });

  it("skips `repo: self` — it has no generation (req 27)", async () => {
    declare("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    const result = await preparePlugins(opts());
    expect(result.linked).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("does nothing when the project declares no plugins", async () => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: npm install\n");
    expect(await preparePlugins(opts())).toEqual({ linked: [], missing: [], installs: [] });
  });

  it("refuses to clobber a real file at the link path", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST);
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, "tools"), "not ours");

    const result = await preparePlugins(opts());
    expect(result.linked).toEqual([]);
    expect(fs.readFileSync(path.join(pluginsDir, "tools"), "utf8")).toBe("not ours");
  });
});

describe("preparePlugins — install", () => {
  it("runs install with cwd in the writable view and the generation's commit", async () => {
    declare();
    const commit = "a".repeat(40);
    publishGeneration("tools", commit, PROBE_MANIFEST, { "inputs.txt": "v1" });

    const result = await preparePlugins(opts());

    expect(result.installs).toEqual([{ repo: "tools", plugin: "probe", alias: "probe", status: "ran" }]);
    expect(ran).toHaveLength(1);
    expect(ran[0].command).toBe("echo installing");
    expect(ran[0].cwd).toBe(path.join(storeRw, "tools", "active"));
    expect(ran[0].env.SHIPIT_PLUGIN_COMMIT).toBe(commit);
    expect(ran[0].env.SHIPIT_PROJECT_DIR).toBe(workspaceDir);
  });

  it("does not hand the worker's own token to plugin code", async () => {
    vi.stubEnv(WORKER_TOKEN_ENV, "super-secret");
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "inputs.txt": "v1" });

    await preparePlugins(opts());

    expect(process.env[WORKER_TOKEN_ENV]).toBe("super-secret");
    expect(ran[0].env[WORKER_TOKEN_ENV]).toBeUndefined();
  });

  it("skips a second run when nothing the stamp covers changed", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "inputs.txt": "v1" });

    await preparePlugins(opts());
    const second = await preparePlugins(opts());

    expect(second.installs[0].status).toBe("skipped");
    expect(ran).toHaveLength(1);
  });

  it("re-runs when the commit changes", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "inputs.txt": "v1" });
    await preparePlugins(opts());

    publishGeneration("tools", "b".repeat(40), PROBE_MANIFEST, { "inputs.txt": "v1" });
    const second = await preparePlugins(opts());

    expect(second.installs[0].status).toBe("ran");
    expect(ran).toHaveLength(2);
    expect(ran[1].env.SHIPIT_PLUGIN_COMMIT).toBe("b".repeat(40));
  });

  it("re-runs when a declared install input's content changes", async () => {
    declare();
    const commit = "a".repeat(40);
    const dir = publishGeneration("tools", commit, PROBE_MANIFEST, { "inputs.txt": "v1" });
    await preparePlugins(opts());

    fs.writeFileSync(path.join(dir, "inputs.txt"), "v2");
    expect((await preparePlugins(opts())).installs[0].status).toBe("ran");
    expect(ran).toHaveLength(2);
  });

  it("reports a failing install without stamping it", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), PROBE_MANIFEST, { "inputs.txt": "v1" });
    exitCode = 1;

    const first = await preparePlugins(opts());
    expect(first.installs[0]).toMatchObject({ status: "failed" });
    expect(first.installs[0].error).toContain("boom");

    // Not stamped, so the next prepare tries again rather than reporting success.
    exitCode = 0;
    expect((await preparePlugins(opts())).installs[0].status).toBe("ran");
  });

  it("reports `none` for a plugin that declares no install", async () => {
    declare();
    publishGeneration("tools", "a".repeat(40), "exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n");

    expect((await preparePlugins(opts())).installs[0].status).toBe("none");
    expect(ran).toEqual([]);
  });

  it("installs only the plugins the consumer selected", async () => {
    declare();
    publishGeneration(
      "tools",
      "a".repeat(40),
      `${PROBE_MANIFEST}    other:\n      install: echo other\n`,
    );

    const result = await preparePlugins(opts());
    expect(result.installs.map((i) => i.plugin)).toEqual(["probe"]);
    expect(ran.map((r) => r.command)).toEqual(["echo installing"]);
  });
});
