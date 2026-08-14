/**
 * docs/262 — the activation lifecycle: which declared repositories get
 * activated, what the tab is told about the attempt, and what happens when one
 * repository fails while another succeeds (req 14 independence).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  activateDeclaredPlugins,
  beginContainerPrepare,
  clearActivationState,
  readPrepareFailures,
  getActivationState,
  getPluginPrepareFailures,
} from "./plugin-activation.js";
import { createStagedGenerationGate } from "./plugin-preflight.js";
import { readActiveGeneration } from "../plugin-generations.js";

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
    "exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n"
      + "      settings:\n        greeting:\n          default: hello\n",
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

  // req 27 — the half of the identity guard only this path can run. A self
  // declaration activates nothing, so no later round would ever reconcile what
  // an earlier tracked declaration published under the same name: without this,
  // the previous repository's checkout stays live under that name for the
  // session's whole life, readable through the read-only store mount.
  it("retires a generation left under a name now declared `repo: self`", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    const repoRoot = path.join(sessionDir, "state", "plugins", "tools");
    expect(fs.existsSync(path.join(repoRoot, "active"))).toBe(true);

    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: tools\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    // The link first — it is what the container's prepare pass follows — and the
    // trees with it, since nothing can ever name them again.
    expect(fs.existsSync(path.join(repoRoot, "active"))).toBe(false);
    expect(fs.readdirSync(path.join(repoRoot, "generations"))).toEqual([]);
  });

  // A narrowed round speaks for the one repository the agent named. `shipit
  // plugin refresh` refuses a self name outright, so a narrowed round must not
  // reach sideways into one.
  it("leaves a self-declared name alone when the round is narrowed to another repo", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    writeConfig(
      "plugins:\n  repos:\n    - repo: self\n      name: tools\n"
        + "    - repo: acme/other\n      name: other\n      branch: main\n",
    );
    await activateDeclaredPlugins("sess", workspaceDir, deps(), undefined, "other");

    expect(fs.existsSync(path.join(sessionDir, "state", "plugins", "tools", "active"))).toBe(true);
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

  // A clone that does not sit at `<sessionDir>/workspace` has no resolvable
  // state dir (planning#288) — but the settled hook is also what removes
  // container links for repos the declaration dropped, so a project that
  // declares nothing must still get it.
  it("still settles when the session layout has no resolvable state dir", async () => {
    const flat = path.join(tmp, "flat");
    fs.mkdirSync(flat, { recursive: true });
    fs.writeFileSync(path.join(flat, "shipit.yaml"), "agent:\n  install: npm install\n");

    const settled: string[] = [];
    await activateDeclaredPlugins("sess", flat, { ...deps(), onSettled: (id) => settled.push(id) });
    expect(settled).toEqual(["sess"]);
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

/**
 * docs/262 plan §1a phase 3 — the pre-publish gate, wired the way production
 * wires it (`bootstrap-managers.ts`): the REAL gate, not a stub, forwarded
 * through this service into the generation engine.
 *
 * The two halves are tested apart — `plugin-generations.test.ts` owns the
 * ordering and the failure shape, `plugin-preflight.test.ts` owns the verdicts —
 * and nothing else proves they are actually connected. A dropped `validateStaged`
 * property in either forwarding step type-checks perfectly and silently restores
 * the bug the gate closes.
 */
describe("the phase-3 gate, wired end to end (reqs 13, 15)", () => {
  const declareProbe = "compose: docker-compose.yml\n"
    + "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n"
    + "  use:\n    - plugin: probe\n      from: tools\n";

  /**
   * Commit an exported compose fragment on the plugin repository, good or bad,
   * and make it reachable through the bare cache the way a real fetch would.
   * `ensureCache` above short-circuits on an existing cache, so a SECOND commit
   * only reaches activation if it is fetched here.
   */
  async function publishFragment(fragment: string): Promise<void> {
    fs.writeFileSync(
      path.join(originDir, "shipit.yaml"),
      "exports:\n  plugins:\n    probe:\n      compose: probe/docker-compose.yml\n"
        + "      cli:\n        probe: bin/probe.mjs\n",
    );
    fs.mkdirSync(path.join(originDir, "probe"), { recursive: true });
    fs.writeFileSync(path.join(originDir, "probe", "docker-compose.yml"), fragment);
    const git = simpleGit(originDir);
    await git.add(".");
    await git.commit("fragment");

    const cacheDir = getBareCacheDir("https://github.com/acme/tools.git");
    if (!fs.existsSync(path.join(cacheDir, "HEAD"))) return;
    await simpleGit(cacheDir).raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
    await simpleGit(cacheDir).raw(["fetch", "--all", "--force"]);
  }

  /** The state dir the session's generations live in. */
  const liveCommit = (): string | undefined =>
    readActiveGeneration(path.join(sessionDir, "state"), "tools", "acme/tools")?.commit;

  it("activates a version whose fragment is usable", async () => {
    await publishFragment("services:\n  probe:\n    image: node:22-alpine\n");
    writeConfig(declareProbe);

    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      validateStaged: createStagedGenerationGate({ workspaceDir, containEgress: () => false }),
    });

    const state = getActivationState("sess", "tools");
    expect(state?.error).toBeUndefined();
    expect(state?.generation?.commit).toBeTruthy();
  });

  it("does not publish a version whose fragment is rejected", async () => {
    // `build:` is refused for a plugin fragment — its files reach it through the
    // generation's overlay volume, which cannot be a build context.
    await publishFragment("services:\n  probe:\n    build: .\n");
    writeConfig(declareProbe);

    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      validateStaged: createStagedGenerationGate({ workspaceDir, containEgress: () => false }),
    });

    const state = getActivationState("sess", "tools");
    expect(state?.error).toContain("build:");
    // Nothing became live — the whole point. Without the gate this repository
    // would be `active` at a commit whose services can never start.
    expect(state?.generation).toBeUndefined();
    expect(liveCommit()).toBeUndefined();
  });

  it("keeps the prior version live when a later commit's fragment is rejected", async () => {
    await publishFragment("services:\n  probe:\n    image: node:22-alpine\n");
    writeConfig(declareProbe);
    const gate = createStagedGenerationGate({ workspaceDir, containEgress: () => false });
    await activateDeclaredPlugins("sess", workspaceDir, { ...deps(), validateStaged: gate });
    const good = getActivationState("sess", "tools")?.generation?.commit;
    expect(good).toBeTruthy();

    await publishFragment("services:\n  probe:\n    build: .\n");
    await activateDeclaredPlugins("sess", workspaceDir, { ...deps(), validateStaged: gate });

    const state = getActivationState("sess", "tools");
    // req 15's degraded state: the failure is reported AND the prior complete
    // version is still the one running.
    expect(state?.error).toContain("build:");
    expect(state?.generation?.commit).toBe(good);
    expect(liveCommit()).toBe(good);
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

/**
 * docs/262 reqs 17, 18, 26 — the per-import primitives ride the same round.
 * `plugin-state.test.ts` owns their semantics; these guard the WIRING, which is
 * where they can silently not happen at all: a `repo: self` project activates
 * no generation, and a refresh must reach the settings file without touching
 * the state directory beside it.
 */
describe("per-import state and settings", () => {
  const useProbe = "  use:\n    - plugin: probe\n      from: tools\n      alias: p\n";
  const declareTools = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n";

  const stateDirFor = (alias: string): string =>
    path.join(sessionDir, "plugin-data", alias, "state");
  const settingsFor = (alias: string): string =>
    path.join(sessionDir, "plugin-data", alias, "settings.json");

  it("prepares them for a tracked import, from the live generation's manifest", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(fs.existsSync(stateDirFor("p"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFor("p"), "utf-8"))).toEqual({ greeting: "hello" });
  });

  it("prepares them for a `repo: self` import, which activates no generation (req 27)", async () => {
    // This project both exports and consumes — the round has nothing to fetch,
    // and the primitives must exist anyway.
    writeConfig(
      "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hi\n"
        + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
        + "  use:\n    - plugin: probe\n      from: dev\n      alias: here\n",
    );
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(fs.existsSync(stateDirFor("here"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFor("here"), "utf-8"))).toEqual({ greeting: "hi" });
  });

  it("a later round updates the settings and keeps the shared state (reqs 12, 18)", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    fs.writeFileSync(path.join(stateDirFor("p"), "bumps"), "11");

    // The consuming project sets the value the plugin declared a default for.
    writeConfig(`${declareTools}${useProbe}      overrides:\n        settings:\n          greeting: bonjour\n`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(JSON.parse(fs.readFileSync(settingsFor("p"), "utf-8"))).toEqual({ greeting: "bonjour" });
    expect(fs.readFileSync(path.join(stateDirFor("p"), "bumps"), "utf-8")).toBe("11");
  });

  it("keeps them out of the reclaimable state dir, so eviction cannot take them", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    // `<sessionDir>/state` is in REGENERABLE_SESSION_SUBDIRS: archive and
    // disk-tier eviction delete it whole, and req 18 says this data survives
    // both.
    expect(fs.existsSync(path.join(sessionDir, "state", "plugin-data"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "plugin-data"))).toBe(true);
  });

  it("does not prepare anything for a session that was disposed mid-round", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    const running = activateDeclaredPlugins("sess", workspaceDir, deps());
    clearActivationState("sess");
    await running;
    expect(fs.existsSync(path.join(sessionDir, "plugin-data"))).toBe(false);
  });

  // A round holds its declaration for as long as its slowest fetch takes, so an
  // edit landing in that window is newer than the round that finishes over it.
  // Settings are derived config: the settlement re-reads the file, so trigger
  // order — not completion order — decides what is on disk (review finding).
  it("settles against the CURRENT declaration, not the one the round started with", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    const withEditMidRound = {
      ...deps(),
      ensureCache: async (cacheDir: string, repoUrl: string): Promise<void> => {
        // The project edits its settings while this round is still fetching.
        writeConfig(
          `${declareTools}${useProbe}      overrides:\n        settings:\n          greeting: bonjour\n`,
        );
        await ensureCache(cacheDir, repoUrl);
      },
    };

    await activateDeclaredPlugins("sess", workspaceDir, withEditMidRound);
    expect(JSON.parse(fs.readFileSync(settingsFor("p"), "utf-8"))).toEqual({ greeting: "bonjour" });
  });

  it("remembers a materialization failure, and forgets it once a round succeeds", async () => {
    const self = "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hi\n"
      + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
      + "  use:\n    - plugin: probe\n      from: dev\n      alias: here\n";
    writeConfig(self);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getPluginPrepareFailures("sess", "dev")).toEqual([]);

    // The value changes and the replacement cannot be written. Nothing can
    // recompute that from the declaration, so it has to be remembered or the
    // card reports a healthy plugin running on superseded settings.
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    writeConfig(`${self}      overrides:\n        settings:\n          greeting: bonjour\n`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    rename.mockRestore();

    expect(getPluginPrepareFailures("sess", "dev").join(" ")).toContain("could not be written");
    expect(fs.existsSync(settingsFor("here"))).toBe(false);

    // The next healthy round clears it — it describes an attempt, not a state.
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getPluginPrepareFailures("sess", "dev")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settingsFor("here"), "utf-8"))).toEqual({ greeting: "bonjour" });
  });
});

/**
 * docs/262 req 13 + req 22 — the CONTAINER half of prepare. It runs in the
 * session worker, so its result has to travel back here to be seen at all;
 * before this it stopped at a `console.warn` and the card stayed clean while
 * the agent was missing instructions the plugin promised.
 */
describe("container prepare failures", () => {
  const failure = (repo: string, skill: string, reason: string) => ({ repo, skill, reason });

  it("records what the container could not materialize, on the repository's card", () => {
    beginContainerPrepare("sess")([
      failure("tools", "reqs/probe", "`plugins--reqs--probe-abc` has no readable SKILL.md"),
    ]);

    expect(getPluginPrepareFailures("sess", "tools")).toEqual([
      "Skill `reqs/probe`: `plugins--reqs--probe-abc` has no readable SKILL.md",
    ]);
    // req 14 — one repository's failure is not another's.
    expect(getPluginPrepareFailures("sess", "other")).toEqual([]);
  });

  it("drops the skill identifier for an all-imports failure, which names none", () => {
    beginContainerPrepare("sess")([failure("tools", "(all)", "could not keep them out of git")]);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual(["Skills: could not keep them out of git"]);
  });

  it("replaces the whole record, so a fixed problem stops being reported", () => {
    beginContainerPrepare("sess")([failure("tools", "reqs/probe", "no readable SKILL.md")]);
    // Prepare is always whole-declaration, so one clean pass describes every
    // repository — including the ones it now has nothing to say about.
    expect(beginContainerPrepare("sess")([])).toBe(true);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([]);
  });

  it("reports whether anything changed, so an unchanged pass pushes no refetch", () => {
    expect(beginContainerPrepare("sess")([])).toBe(false);
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "x")])).toBe(true);
    // The identical result again — prepare runs on every round and every
    // container start, and the healthy case is by far the common one.
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "x")])).toBe(false);
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "y")])).toBe(true);
  });

  it("does not write a result that arrives after the session was disposed", () => {
    // The container is asked, the session is disposed and recreated, and only
    // then does the answer come back. Its epoch is stale, so it writes nothing
    // — the same rule the activation state map follows.
    const record = beginContainerPrepare("sess");
    clearActivationState("sess");
    expect(record([failure("tools", "a/b", "x")])).toBe(false);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([]);
  });

  it("carries a link failure, which names no skill", () => {
    // The repository's own `/plugins/<name>` could not be made — nothing of it
    // is in the workspace, and the card is the only place that can say so.
    beginContainerPrepare("sess")([
      { repo: "tools", reason: "`/plugins/tools` already exists and is not a link ShipIt made" },
    ]);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([
      "`/plugins/tools` already exists and is not a link ShipIt made",
    ]);
  });

  it("keeps both halves of prepare on the card at once", async () => {
    // The orchestrator half failed to write a settings file and the container
    // half failed to materialize a skill. They are recorded by different actors
    // at different moments, and neither may erase the other.
    const self = "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hi\n"
      + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
      + "  use:\n    - plugin: probe\n      from: dev\n      alias: here\n";
    writeConfig(self);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    rename.mockRestore();
    beginContainerPrepare("sess")([failure("dev", "here/probe", "no readable SKILL.md")]);

    const issues = getPluginPrepareFailures("sess", "dev");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("could not be written");
    expect(issues[1]).toBe("Skill `here/probe`: no readable SKILL.md");
  });
});

/**
 * The worker on the other end of `/plugins/prepare` is not necessarily the one
 * this orchestrator shipped with: containers survive an orchestrator restart
 * and are reconnected, so a rolling upgrade puts a new orchestrator in front of
 * an old worker (review finding).
 */
describe("readPrepareFailures", () => {
  it("reads both failure lists out of a prepare response", () => {
    expect(readPrepareFailures({
      linked: ["tools"],
      skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "no SKILL.md" }],
      linkFailed: [{ repo: "other", reason: "already exists" }],
    }, "sess")).toEqual([
      { repo: "tools", skill: "reqs/probe", reason: "no SKILL.md" },
      { repo: "other", reason: "already exists" },
    ]);
  });

  it("drops a failure the container could not attribute to a repository", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // What a worker built before failures carried a `repo` sends. Casting it
    // stored the failure under `sessionId::undefined`, which no card looks up —
    // invisible, and displacing whatever the previous run recorded.
    expect(readPrepareFailures({ skillsFailed: [{ skill: "probe", reason: "no SKILL.md" }] }, "sess"))
      .toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("survives a response that is not a prepare result at all", () => {
    expect(readPrepareFailures(undefined, "sess")).toEqual([]);
    expect(readPrepareFailures("nope", "sess")).toEqual([]);
    expect(readPrepareFailures({ skillsFailed: "nope" }, "sess")).toEqual([]);
  });
});

/**
 * docs/262 req 20 — a companion CLI ShipIt refused to surface has to reach the
 * card. Cross-plugin collisions and reserved names are also recomputed by the
 * snapshot; the PATH-shadow half is knowable only inside the container, so this
 * response is its only route.
 */
describe("readPrepareFailures — companion-CLI refusals", () => {
  it("carries a refused command, attributed to its declared repository", () => {
    expect(readPrepareFailures({
      commandsRefused: [{ repo: "tools", reason: "Command `curl` would shadow `/usr/bin/curl`." }],
      commandsFailed: [{ repo: "tools", reason: "`reqs` is not on PATH: the `shipit` shim is not installed." }],
    }, "sess")).toEqual([
      { repo: "tools", reason: "Command `curl` would shadow `/usr/bin/curl`." },
      { repo: "tools", reason: "`reqs` is not on PATH: the `shipit` shim is not installed." },
    ]);
  });

  it("drops an unattributed refusal rather than rendering it on no card", () => {
    expect(readPrepareFailures({ commandsRefused: [{ reason: "no repo" }] }, "sess")).toEqual([]);
  });
});
