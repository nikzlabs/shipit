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

  it("a malformed shipit.yaml is not fatal", async () => {
    writeConfig("plugins: [unclosed\n  - broken");
    await expect(activateDeclaredPlugins("sess", workspaceDir, deps())).resolves.toBeUndefined();
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

  it("an activation that finishes after disposal cannot repopulate the state map", async () => {
    writeConfig(declareTools);
    const running = activateDeclaredPlugins("sess", workspaceDir, deps());
    // The session goes away while the fetch/clone is in flight.
    clearActivationState("sess");
    await running;
    expect(getActivationState("sess", "tools")).toBeUndefined();
  });
});
