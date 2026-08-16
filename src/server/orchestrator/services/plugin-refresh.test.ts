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
import { writeInstallRecord } from "../plugin-install-record.js";
import { pluginsRoot } from "../plugin-generations.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";

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

    // The SAME repository, at a ref that cannot be resolved — the shape a
    // deleted tag or a bad pin produces. It has to stay the same repository:
    // pointing the name at a DIFFERENT one is a re-point, and a stranger's
    // files are not a degraded version of this plugin (see the test below).
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      pin: v-does-not-exist\n");
    const failed = await refreshPluginRepos("sess", workspaceDir, deps());

    expect(failed.rows[0]!.status).toBe("failed");
    expect(failed.rows[0]!.after).toBe(live);
  });

  // Re-pointing is not refreshing. Every on-disk path is keyed by the
  // declaration NAME, so before the generation recorded its source the old
  // repository's checkout stayed live under the new declaration — the report,
  // the Plugins tab and `/plugins/tools` all showed the new repository at the
  // old repository's commit.
  it("does not keep the previous repository live when the name is re-pointed", async () => {
    writeConfig(DECLARATION);
    await refreshPluginRepos("sess", workspaceDir, deps());

    writeConfig("plugins:\n  repos:\n    - repo: acme/missing\n      name: tools\n      branch: main\n");
    const failed = await refreshPluginRepos("sess", workspaceDir, deps());

    expect(failed.rows[0]!.status).toBe("failed");
    expect(failed.rows[0]!.detail).toContain("authorization failed");
    expect(failed.rows[0]!.after).toBeNull();
  });

  // The shared activation-state map belongs to the UI and is owned by whichever
  // round finishes last. Deriving the report from it meant a refresh whose
  // install had just failed could read back as `unchanged` and exit 0, because a
  // second trigger had already replaced the state with `activating: true`.
  it("reports ITS OWN round's failure, not the shared latest-attempt state", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/missing\n      name: tools\n      branch: main\n");
    const failed = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(failed.rows[0]!.status).toBe("failed");

    // Wipe the shared map, exactly as a disposal would. The row already
    // computed above stands on its own; a fresh round still answers for itself.
    clearActivationState("sess");
    const again = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(again.rows[0]!.status).toBe("failed");
    expect(again.rows[0]!.detail).toContain("authorization failed");
  });

  it("returns no rows, and no error, for a project that declares nothing", async () => {
    writeConfig("agent:\n  install: npm install\n");
    const result = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(result).toEqual({ rows: [] });
  });
});

/**
 * docs/266 — what a consumer whose live version is broken can see and do.
 *
 * Both halves were missing at once, and that is what made the reported episode
 * expensive: the round said `unchanged` and exited 0 while the plugin was
 * unusable, and there was no way to try the same version again.
 */
describe("refreshPluginRepos — diagnosing and retrying a live version", () => {
  it("reports the LIVE version's own degradation on a round that did nothing", async () => {
    // A manifest that declares an install this runtime has no runner for: the
    // generation goes live "active but not installed" (req 13 degrades visibly),
    // and until now that sentence reached only the Plugins tab.
    fs.writeFileSync(
      path.join(originDir, "shipit.yaml"),
      "exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n      install: npm ci\n",
    );
    const git = simpleGit(originDir);
    await git.add(".");
    await git.commit("declare an install");

    writeConfig(`${DECLARATION}  use:\n    - plugin: probe\n      from: tools\n`);
    const first = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(first.rows[0]!.status).toBe("activated");

    const again = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(again.rows[0]!.status).toBe("unchanged");
    expect(again.rows[0]!.degraded?.join(" ")).toContain("not installed");
  });

  it("says nothing extra when the live version is fine", async () => {
    writeConfig(DECLARATION);
    await refreshPluginRepos("sess", workspaceDir, deps());
    const again = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(again.rows[0]!.degraded).toBeUndefined();
  });

  it("reports a FAILED install for the live version on a later plain refresh", async () => {
    // The gap review found: `degraded` read only the generation's own warnings,
    // and a failed install publishes NO generation — so the state this feature
    // exists for (live version, install failed) was silent on every round after
    // the one that failed. The durable record is the only carrier of it.
    writeConfig(DECLARATION);
    const first = await refreshPluginRepos("sess", workspaceDir, deps());
    const live = first.rows[0]!.after!;

    writeInstallRecord(pluginsRoot(sessionStateDirForWorkspace(workspaceDir)), "tools", {
      commit: live,
      at: "2026-08-16T12:00:00.000Z",
      outcome: "failed",
      detail: "install for `web` exited 1",
    });

    const again = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(again.rows[0]!.status).toBe("unchanged");
    expect(again.rows[0]!.degraded?.join(" ")).toContain("FAILED");
  });

  it("does not report a failed attempt on a version that is not live", async () => {
    // A failed refresh to B leaves A serving. Naming B's failure under A would
    // be the fabricated diagnosis the same review finding names.
    writeConfig(DECLARATION);
    await refreshPluginRepos("sess", workspaceDir, deps());

    writeInstallRecord(pluginsRoot(sessionStateDirForWorkspace(workspaceDir)), "tools", {
      commit: "b".repeat(40),
      at: "2026-08-16T12:00:00.000Z",
      outcome: "failed",
      detail: "install for `web` exited 1",
    });

    const again = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(again.rows[0]!.degraded).toBeUndefined();
  });

  it("refuses --force without a repository name, and runs nothing", async () => {
    // It discards a live version's writable layer; a forgotten name must not
    // apply that to every declared repository.
    writeConfig(DECLARATION);
    const before = await refreshPluginRepos("sess", workspaceDir, deps());
    expect(before.rows[0]!.status).toBe("activated");

    const forced = await refreshPluginRepos("sess", workspaceDir, deps(), undefined, true);
    expect(forced.rows).toEqual([]);
    expect(forced.error).toContain("needs the name of one plugin repository");
  });

  it("does not claim a re-install when --force ran a FIRST activation", async () => {
    // Nothing was live, so the forced round is an ordinary activation. Saying
    // `re-installed` there would describe work on a version that never existed.
    writeConfig(DECLARATION);
    const first = await refreshPluginRepos("sess", workspaceDir, deps(), "tools", true);

    expect(first.rows[0]!.status).toBe("activated");
    expect(first.rows[0]!.before).toBeNull();
    expect(first.rows[0]!.reinstalled).toBeUndefined();
  });

  it("re-activates the commit already live, instead of reporting `unchanged`", async () => {
    writeConfig(DECLARATION);
    const first = await refreshPluginRepos("sess", workspaceDir, deps());
    const live = first.rows[0]!.after;

    // Without --force this is the terminal `unchanged` the issue reported: the
    // consumer's only escape was the plugin's author publishing a new commit.
    const plain = await refreshPluginRepos("sess", workspaceDir, deps(), "tools");
    expect(plain.rows[0]!.status).toBe("unchanged");
    expect(plain.rows[0]!.reinstalled).toBeUndefined();

    const forced = await refreshPluginRepos("sess", workspaceDir, deps(), "tools", true);
    expect(forced.rows[0]!.reinstalled).toBe(true);
    // The same version — a retry, not an upgrade.
    expect(forced.rows[0]!.after).toBe(live);
  });
});
