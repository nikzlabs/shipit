/**
 * docs/262 req 12 — `shipit plugin refresh`, server side.
 *
 * Refresh IS activation, so the interesting behaviour here is not the fetch —
 * `plugin-generations.test.ts` owns that — but what the agent is TOLD: which
 * commit moved, which repository was touched, and what a failure reports while
 * the prior generation keeps serving (req 15).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { refreshPluginRepos } from "./plugin-refresh.js";
import { clearActivationState } from "./plugin-activation.js";

let tmp: string;
let sessionDir: string;
let workspaceDir: string;
let cacheRoot: string;
let originDir: string;

const getBareCacheDir = (repoUrl: string): string =>
  path.join(cacheRoot, Buffer.from(repoUrl).toString("hex").slice(0, 16));

const ensureCache = async (cacheDir: string, repoUrl: string): Promise<void> => {
  if (repoUrl.includes("missing")) throw new Error("authorization failed");
  if (fs.existsSync(path.join(cacheDir, "HEAD"))) {
    await simpleGit(cacheDir).raw(["fetch", "--all", "--force"]);
    return;
  }
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  await simpleGit().raw(["clone", "--bare", originDir, cacheDir]);
  await simpleGit(cacheDir).raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
};

const deps = () => ({ getBareCacheDir, ensureCache, pinStorePath: path.join(tmp, "pins.json") });

const DECLARATION = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n";

function writeConfig(yaml: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

/** Add a commit on the plugin origin, so the next refresh has somewhere to go. */
async function commitOnOrigin(message: string): Promise<string> {
  fs.writeFileSync(path.join(originDir, `${message}.txt`), message);
  const git = simpleGit(originDir);
  await git.add(".");
  await git.commit(message);
  return (await git.revparse(["HEAD"])).trim();
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-refresh-"));
  sessionDir = path.join(tmp, "session");
  workspaceDir = path.join(sessionDir, "workspace");
  cacheRoot = path.join(tmp, "cache");
  originDir = path.join(tmp, "origin");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "state"), { recursive: true });
  fs.mkdirSync(originDir, { recursive: true });

  const git = simpleGit(originDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "t@example.com");
  await git.addConfig("user.name", "T");
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

describe("refreshPluginRepos", () => {
  it("reports the commit it moved to", async () => {
    writeConfig(DECLARATION);
    const first = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.status).toBe("activated");
    expect(first.rows[0]!.before).toBeNull();
    expect(first.rows[0]!.after).toMatch(/^[0-9a-f]{40}$/);
    expect(first.rows[0]!.ref).toBe("branch main");

    // The plugin repository gains a commit — this is the case the verb exists
    // for: nothing about the CONSUMER changed, so no other trigger would fire.
    const moved = await commitOnOrigin("second");
    const second = await refreshPluginRepos("sess", workspaceDir, deps());

    expect(second.rows[0]!.before).toBe(first.rows[0]!.after);
    expect(second.rows[0]!.after).toBe(moved);
    expect(second.rows[0]!.status).toBe("activated");
  });

  it("says `unchanged` when the tracked branch has not moved", async () => {
    writeConfig(DECLARATION);
    await refreshPluginRepos("sess", workspaceDir, deps());
    const again = await refreshPluginRepos("sess", workspaceDir, deps());

    expect(again.rows[0]!.status).toBe("unchanged");
    expect(again.rows[0]!.before).toBe(again.rows[0]!.after);
  });

  it("refreshes only the repository the agent named", async () => {
    writeConfig(
      `${DECLARATION}    - repo: acme/other\n      name: other\n      branch: main\n`,
    );
    const all = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(all.rows.map((r) => r.repo).sort()).toEqual(["other", "tools"]);

    const one = await refreshPluginRepos("sess", workspaceDir, deps(), "tools");
    expect(one.rows.map((r) => r.repo)).toEqual(["tools"]);
  });

  it("matches the declared name case-insensitively, like the rest of the grammar", async () => {
    writeConfig(DECLARATION);
    const result = await refreshPluginRepos("sess", workspaceDir, deps(), "TOOLS");
    expect(result.error).toBeUndefined();
    expect(result.rows.map((r) => r.repo)).toEqual(["tools"]);
  });

  it("names what IS declared when asked for a repository that is not", async () => {
    writeConfig(DECLARATION);
    const result = await refreshPluginRepos("sess", workspaceDir, deps(), "ghost");

    expect(result.rows).toEqual([]);
    expect(result.error).toContain("`ghost`");
    expect(result.error).toContain("`tools`");
  });

  it("refuses `repo: self` rather than reporting a no-op as success", async () => {
    // req 27: self IS the working tree. There is no generation to refresh, so
    // "nothing happened" would be a misleading answer.
    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    const result = await refreshPluginRepos("sess", workspaceDir, deps(), "dev");
    expect(result.error).toContain("`dev`");
    // And it says WHY. "not a declared repository" would send the reader
    // looking for a typo that is not there.
    expect(result.error).toContain("repo: self");
  });

  // req 15 — a failed refresh keeps the prior generation whole and live. The
  // agent has to be told BOTH: that the refresh failed, and which commit its
  // session is still running.
  it("reports a failure while the prior generation keeps serving", async () => {
    writeConfig(DECLARATION);
    const good = await refreshPluginRepos("sess", workspaceDir, deps());
    const live = good.rows[0]!.after;

    // The declaration now points the same NAME at a repository that cannot be
    // fetched — the shape a rotated credential or a deleted repo produces.
    writeConfig("plugins:\n  repos:\n    - repo: acme/missing\n      name: tools\n      branch: main\n");
    const failed = await refreshPluginRepos("sess", workspaceDir, deps());

    expect(failed.rows[0]!.status).toBe("failed");
    expect(failed.rows[0]!.detail).toContain("authorization failed");
    expect(failed.rows[0]!.after).toBe(live);
  });

  it("returns no rows, and no error, for a project that declares nothing", async () => {
    writeConfig("agent:\n  install: npm install\n");
    const result = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(result).toEqual({ rows: [] });
  });
});
