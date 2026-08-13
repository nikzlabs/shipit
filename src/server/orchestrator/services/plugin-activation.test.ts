/**
 * docs/262 — the activation lifecycle: which declared repositories get
 * activated, what the tab is told about the attempt, and what happens when one
 * repository fails while another succeeds (req 14 independence).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  activateDeclaredPlugins,
  clearActivationState,
  getActivationState,
} from "./plugin-activation.js";

let tmp: string;
let sessionDir: string;
let workspaceDir: string;
let cacheRoot: string;
let originDir: string;

/** Serve every plugin repo from one local origin, keyed by URL hash. */
function getBareCacheDir(repoUrl: string): string {
  return path.join(cacheRoot, Buffer.from(repoUrl).toString("hex").slice(0, 16));
}

/** Build the bare cache on demand — stands in for a network fetch. */
const ensureCache = async (cacheDir: string, repoUrl: string): Promise<void> => {
  if (repoUrl.includes("missing")) throw new Error("authorization failed");
  if (fs.existsSync(path.join(cacheDir, "HEAD"))) return;
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  await simpleGit().raw(["clone", "--bare", originDir, cacheDir]);
};

const deps = () => ({ getBareCacheDir, ensureCache, pinStorePath: path.join(tmp, "plugin-pins.json") });

function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-activation-"));
  sessionDir = path.join(tmp, "session");
  workspaceDir = path.join(sessionDir, "workspace");
  cacheRoot = path.join(tmp, "cache");
  originDir = path.join(tmp, "origin");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "state"), { recursive: true });
  fs.mkdirSync(originDir, { recursive: true });

  const git = simpleGit(originDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  fs.writeFileSync(
    path.join(originDir, "shipit.yaml"),
    "exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n",
  );
  await git.add(".");
  await git.commit("initial");
});

afterEach(() => {
  clearActivationState("sess");
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("activateDeclaredPlugins", () => {
  it("activates a tracked repository and reports the live generation", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    const state = getActivationState("sess", "tools");
    expect(state?.activating).toBe(false);
    expect(state?.error).toBeUndefined();
    expect(state?.generation?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.generation?.exports).toEqual(["probe"]);
  });

  it("skips `self` — it runs the live working tree, not a generation (req 27)", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getActivationState("sess", "dev")).toBeUndefined();
  });

  it("one repository failing leaves the other activated (req 14)", async () => {
    writeConfig(
      "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n"
        + "    - repo: acme/missing\n      name: gone\n      branch: main\n",
    );
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(getActivationState("sess", "tools")?.generation?.commit).toBeTruthy();
    const failed = getActivationState("sess", "gone");
    expect(failed?.error).toContain("authorization failed");
    expect(failed?.generation).toBeUndefined();
  });

  it("does nothing when the project declares no plugins", async () => {
    writeConfig("agent:\n  install: npm install\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getActivationState("sess", "tools")).toBeUndefined();
  });

  // The container's prepare step is also what REMOVES links for repos that are
  // no longer declared, so a round with nothing to activate must still settle —
  // otherwise a dropped repository stays addressable at /plugins/<name> until
  // the container is recreated (review finding).
  it("still settles when the declaration names no tracked repos", async () => {
    const settled: string[] = [];
    const hook = { ...deps(), onSettled: (id: string) => settled.push(id) };

    writeConfig("agent:\n  install: npm install\n");
    await activateDeclaredPlugins("sess", workspaceDir, hook);
    expect(settled).toEqual(["sess"]);

    // Same for a block that parses but leaves nothing tracked.
    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    await activateDeclaredPlugins("sess", workspaceDir, hook);
    expect(settled).toEqual(["sess", "sess"]);
  });

  it("a malformed shipit.yaml is not fatal", async () => {
    writeConfig("plugins: [unclosed\n  - broken");
    // Resolves with an empty outcome map — nothing to activate, nothing thrown.
    await expect(activateDeclaredPlugins("sess", workspaceDir, deps())).resolves.toEqual(new Map());
  });

  it("re-running after a failure recovers without restarting the session", async () => {
    // First attempt: the repo can't be fetched.
    writeConfig("plugins:\n  repos:\n    - repo: acme/missing\n      name: gone\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getActivationState("sess", "gone")?.error).toBeTruthy();

    // The declaration is fixed — the next trigger (a shipit.yaml edit) activates.
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: gone\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    const state = getActivationState("sess", "gone");
    expect(state?.error).toBeUndefined();
    expect(state?.generation?.commit).toBeTruthy();
  });
});

describe("lifetime and selectors", () => {
  const declareTools = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n";

  it("passes the consumer's selectors through — a bad one fails the generation (phase 2)", async () => {
    writeConfig(`${declareTools}  use:\n    - plugin: ghost\n      from: tools\n`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    const state = getActivationState("sess", "tools");
    expect(state?.error).toContain("`ghost`");
    expect(state?.generation).toBeUndefined();
  });

  // Install runs in its own container, so the hook is injected from
  // `bootstrap-managers` and travels through this module untouched. The thread
  // is worth a guard: a dropped hook is silent — the generation activates,
  // and only the plugin's own code notices its dependencies were never
  // installed.
  it("passes the install hook through, against the staged (unpublished) tree", async () => {
    writeConfig(`${declareTools}  use:\n    - plugin: probe\n      from: tools\n`);
    const jobs: { stagingDir: string; exports: string[] }[] = [];
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      runInstall: async (job) => {
        jobs.push({ stagingDir: job.stagingDir, exports: job.exports.map((e) => e.name) });
        return { ok: true };
      },
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.exports).toEqual(["probe"]);
    expect(jobs[0]!.stagingDir).toContain(".staging-");
    expect(getActivationState("sess", "tools")?.generation?.commit).toBeTruthy();
  });

  it("a failed install fails the activation and publishes nothing", async () => {
    writeConfig(`${declareTools}  use:\n    - plugin: probe\n      from: tools\n`);
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      runInstall: async () => ({ ok: false, reason: "install for `probe` exited 1" }),
    });

    const state = getActivationState("sess", "tools");
    expect(state?.error).toContain("exited 1");
    expect(state?.generation).toBeUndefined();
    expect(fs.existsSync(path.join(sessionDir, "state", "plugins", "tools", "active"))).toBe(false);
  });

  it("an activation that finishes after disposal cannot repopulate the state map", async () => {
    writeConfig(declareTools);
    const running = activateDeclaredPlugins("sess", workspaceDir, deps());
    // The session goes away while the fetch/clone is in flight.
    clearActivationState("sess");
    await running;
    expect(getActivationState("sess", "tools")).toBeUndefined();
  });
});

describe("epoch ownership of the in-flight counter", () => {
  const declareTools = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n";

  // The regression this guards: counters keyed without the epoch let a stale
  // round's decrement land on a NEW round's counter, so the new round's first
  // trigger cleared `activating` while its second was still queued.
  it("a stale round cannot clear a newer round's activating flag", async () => {
    writeConfig(declareTools);

    const stale = activateDeclaredPlugins("sess", workspaceDir, deps());
    clearActivationState("sess"); // the session is disposed and recreated

    const fresh = Promise.all([
      activateDeclaredPlugins("sess", workspaceDir, deps()),
      activateDeclaredPlugins("sess", workspaceDir, deps()),
    ]);

    await stale;
    await fresh;

    // Both new triggers settled, so the flag is down and the generation is live.
    const state = getActivationState("sess", "tools");
    expect(state?.activating).toBe(false);
    expect(state?.generation?.commit).toBeTruthy();
  });

  it("leaves activating set while a second trigger is still queued", async () => {
    writeConfig(declareTools);
    const first = activateDeclaredPlugins("sess", workspaceDir, deps());
    const second = activateDeclaredPlugins("sess", workspaceDir, deps());
    await first;
    await second;
    expect(getActivationState("sess", "tools")?.activating).toBe(false);
  });

  it("notifies onSettled once the round finishes", async () => {
    writeConfig(declareTools);
    const settled: string[] = [];
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      onSettled: (id) => settled.push(id),
    });
    expect(settled).toEqual(["sess"]);
  });

  it("does not notify onSettled for a disposed session", async () => {
    writeConfig(declareTools);
    const settled: string[] = [];
    const running = activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      onSettled: (id) => settled.push(id),
    });
    clearActivationState("sess");
    await running;
    expect(settled).toEqual([]);
  });
});
