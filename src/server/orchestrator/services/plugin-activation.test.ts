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
import { assemblePluginSnapshot } from "../api-routes-plugin-repos.js";
import type { ApiDeps } from "../api-routes.js";
import { pluginsRoot, readActiveGeneration } from "../plugin-generations.js";
import { writeInstallRecord } from "../plugin-install-record.js";
import { expectInvalidShipitConfig } from "../../shared/shipit-config-test-guard.js";

let tmp: string;
let sessionDir: string;
let workspaceDir: string;
let cacheRoot: string;
let originDir: string;

function getBareCacheDir(repoUrl: string): string {
  return path.join(cacheRoot, Buffer.from(repoUrl).toString("hex").slice(0, 16));
}

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

  it("retires a generation left under a name now declared `repo: self`", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    const repoRoot = path.join(sessionDir, "state", "plugins", "tools");
    expect(fs.existsSync(path.join(repoRoot, "active"))).toBe(true);

    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: tools\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(fs.existsSync(path.join(repoRoot, "active"))).toBe(false);
    expect(fs.readdirSync(path.join(repoRoot, "generations"))).toEqual([]);
  });

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

  it("still settles when the declaration names no tracked repos", async () => {
    const settled: string[] = [];
    const hook = { ...deps(), onSettled: (id: string) => settled.push(id) };

    writeConfig("agent:\n  install: npm install\n");
    await activateDeclaredPlugins("sess", workspaceDir, hook);
    expect(settled).toEqual(["sess"]);

    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: dev\n");
    await activateDeclaredPlugins("sess", workspaceDir, hook);
    expect(settled).toEqual(["sess", "sess"]);
  });

  it("still settles when the session layout has no resolvable state dir", async () => {
    const flat = path.join(tmp, "flat");
    fs.mkdirSync(flat, { recursive: true });
    fs.writeFileSync(path.join(flat, "shipit.yaml"), "agent:\n  install: npm install\n");

    const settled: string[] = [];
    await activateDeclaredPlugins("sess", flat, { ...deps(), onSettled: (id) => settled.push(id) });
    expect(settled).toEqual(["sess"]);
  });

  it("a malformed shipit.yaml is not fatal", async () => {
    expectInvalidShipitConfig(() => {
      writeConfig("plugins: [unclosed\n  - broken");
    });
    await expect(activateDeclaredPlugins("sess", workspaceDir, deps())).resolves.toEqual(new Map());
  });

  it("re-running after a failure recovers without restarting the session", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: acme/missing\n      name: gone\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getActivationState("sess", "gone")?.error).toBeTruthy();

    writeConfig("plugins:\n  repos:\n    - repo: acme/tools\n      name: gone\n      branch: main\n");
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    const state = getActivationState("sess", "gone");
    expect(state?.error).toBeUndefined();
    expect(state?.generation?.commit).toBeTruthy();
  });
});

describe("the phase-3 gate, wired end to end (reqs 13, 15)", () => {
  const declareProbe = "compose: docker-compose.yml\n"
    + "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n"
    + "  use:\n    - plugin: probe\n      from: tools\n";

  // ensureCache skips existing caches, so fetch subsequent commits here.
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
    await publishFragment("services:\n  probe:\n    build: .\n");
    writeConfig(declareProbe);

    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      validateStaged: createStagedGenerationGate({ workspaceDir, containEgress: () => false }),
    });

    const state = getActivationState("sess", "tools");
    expect(state?.error).toContain("build:");
    expect(state?.generation).toBeUndefined();
    expect(liveCommit()).toBeUndefined();
  });

  it("tells the user WHICH rule refused the project's own compose file", async () => {
    await publishFragment('services:\n  probe:\n    image: node:22-alpine\n    user: "1000"\n');
    writeConfig(declareProbe);
    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      'services:\n  web:\n    image: node:22-alpine\n    user: "0"\n',
    );

    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      validateStaged: createStagedGenerationGate({ workspaceDir, containEgress: () => true }),
    });

    const state = getActivationState("sess", "tools");
    expect(state?.error).toContain("refuses this project's own compose file");
    expect(state?.error).not.toContain("could not read");
    expect(state?.error).toContain("`web`");
    expect(state?.error).toContain("`user:`");
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

  it("a failed first install still gives the card the hosts it declared (req 24)", async () => {
    fs.writeFileSync(
      path.join(originDir, "shipit.yaml"),
      "exports:\n  plugins:\n    probe:\n      hosts: [downloads.vendor.example]\n"
        + "      cli:\n        probe: bin/probe.mjs\n",
    );
    const git = simpleGit(originDir);
    await git.add(".");
    await git.commit("declare a host");

    writeConfig(`${declareTools}  use:\n    - plugin: probe\n      from: tools\n`);
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      runInstall: async () => ({ ok: false, reason: "install for `probe` exited 1" }),
    });
    expect(getActivationState("sess", "tools")?.generation).toBeUndefined();

    const snapshot = assemblePluginSnapshot("sess", workspaceDir, null, {
      containerManager: {
        isEgressContained: () => true,
        resolveEgress: () => ({ contained: true, extraHosts: [] }),
      },
    } as unknown as ApiDeps);

    expect(snapshot.repos[0]?.uses[0]?.hosts).toEqual([
      { host: "downloads.vendor.example", reach: "grantable", optional: false },
    ]);
  });

  it("puts the dependency-store reason on the card, beside the problems and not among them", async () => {
    writeConfig(`${declareTools}  use:\n    - plugin: probe\n      from: tools\n`);
    const cold = "Dependencies are installed from scratch in every session and never shared: "
      + "`probe`'s install command is not one ShipIt can identify the inputs of.";
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      runInstall: async (job) => {
        writeInstallRecord(pluginsRoot(path.join(sessionDir, "state")), job.repoName, {
          commit: job.commit,
          generationId: job.generationId,
          at: new Date().toISOString(),
          outcome: "succeeded",
          depStoreReason: cold,
        });
        return { ok: true };
      },
    });

    const snapshot = assemblePluginSnapshot("sess", workspaceDir, null, {} as unknown as ApiDeps);
    expect(snapshot.repos[0]?.status).toBe("active");
    expect(snapshot.repos[0]?.depStoreNotice).toBe(cold);
    expect(snapshot.repos[0]?.issues).toEqual([]);
  });

  it("does not put a rebuild's reason on the generation that is live", async () => {
    writeConfig(`${declareTools}  use:\n    - plugin: probe\n      from: tools\n`);
    let liveCommit = "";
    await activateDeclaredPlugins("sess", workspaceDir, {
      ...deps(),
      runInstall: async (job) => {
        liveCommit = job.commit;
        return { ok: true };
      },
    });
    writeInstallRecord(pluginsRoot(path.join(sessionDir, "state")), "tools", {
      commit: liveCommit,
      generationId: `${liveCommit}.a1b2c3d4`,
      at: new Date().toISOString(),
      outcome: "succeeded",
      depStoreReason: "Dependencies are installed from scratch in every session and never shared: nope.",
    });

    const snapshot = assemblePluginSnapshot("sess", workspaceDir, null, {} as unknown as ApiDeps);
    expect(snapshot.repos[0]?.status).toBe("active");
    expect(snapshot.repos[0]?.depStoreNotice).toBeUndefined();
    expect(snapshot.repos[0]?.issues).toEqual([]);
  });

  it("an activation that finishes after disposal cannot repopulate the state map", async () => {
    writeConfig(declareTools);
    const running = activateDeclaredPlugins("sess", workspaceDir, deps());
    clearActivationState("sess");
    await running;
    expect(getActivationState("sess", "tools")).toBeUndefined();
  });
});

describe("epoch ownership of the in-flight counter", () => {
  const declareTools = "plugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n";

  it("a stale round cannot clear a newer round's activating flag", async () => {
    writeConfig(declareTools);

    const stale = activateDeclaredPlugins("sess", workspaceDir, deps());
    clearActivationState("sess");

    const fresh = Promise.all([
      activateDeclaredPlugins("sess", workspaceDir, deps()),
      activateDeclaredPlugins("sess", workspaceDir, deps()),
    ]);

    await stale;
    await fresh;

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

    writeConfig(`${declareTools}${useProbe}      overrides:\n        settings:\n          greeting: bonjour\n`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());

    expect(JSON.parse(fs.readFileSync(settingsFor("p"), "utf-8"))).toEqual({ greeting: "bonjour" });
    expect(fs.readFileSync(path.join(stateDirFor("p"), "bumps"), "utf-8")).toBe("11");
  });

  it("keeps them out of the reclaimable state dir, so eviction cannot take them", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
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

  it("settles against the CURRENT declaration, not the one the round started with", async () => {
    writeConfig(`${declareTools}${useProbe}`);
    const withEditMidRound = {
      ...deps(),
      ensureCache: async (cacheDir: string, repoUrl: string): Promise<void> => {
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

    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    writeConfig(`${self}      overrides:\n        settings:\n          greeting: bonjour\n`);
    await activateDeclaredPlugins("sess", workspaceDir, deps());
    rename.mockRestore();

    expect(getPluginPrepareFailures("sess", "dev").join(" ")).toContain("could not be written");
    expect(fs.existsSync(settingsFor("here"))).toBe(false);

    await activateDeclaredPlugins("sess", workspaceDir, deps());
    expect(getPluginPrepareFailures("sess", "dev")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(settingsFor("here"), "utf-8"))).toEqual({ greeting: "bonjour" });
  });
});

describe("container prepare failures", () => {
  const failure = (repo: string, skill: string, reason: string) => ({ repo, skill, reason });

  it("records what the container could not materialize, on the repository's card", () => {
    beginContainerPrepare("sess")([
      failure("tools", "reqs/probe", "`plugins--reqs--probe-abc` has no readable SKILL.md"),
    ]);

    expect(getPluginPrepareFailures("sess", "tools")).toEqual([
      "Skill `reqs/probe`: `plugins--reqs--probe-abc` has no readable SKILL.md",
    ]);
    expect(getPluginPrepareFailures("sess", "other")).toEqual([]);
  });

  it("drops the skill identifier for an all-imports failure, which names none", () => {
    beginContainerPrepare("sess")([failure("tools", "(all)", "could not keep them out of git")]);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual(["Skills: could not keep them out of git"]);
  });

  it("replaces the whole record, so a fixed problem stops being reported", () => {
    beginContainerPrepare("sess")([failure("tools", "reqs/probe", "no readable SKILL.md")]);
    expect(beginContainerPrepare("sess")([])).toBe(true);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([]);
  });

  it("reports whether anything changed, so an unchanged pass pushes no refetch", () => {
    expect(beginContainerPrepare("sess")([])).toBe(false);
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "x")])).toBe(true);
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "x")])).toBe(false);
    expect(beginContainerPrepare("sess")([failure("tools", "a/b", "y")])).toBe(true);
  });

  it("does not write a result that arrives after the session was disposed", () => {
    const record = beginContainerPrepare("sess");
    clearActivationState("sess");
    expect(record([failure("tools", "a/b", "x")])).toBe(false);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([]);
  });

  it("carries a link failure, which names no skill", () => {
    beginContainerPrepare("sess")([
      { repo: "tools", reason: "`/plugins/tools` already exists and is not a link ShipIt made" },
    ]);
    expect(getPluginPrepareFailures("sess", "tools")).toEqual([
      "`/plugins/tools` already exists and is not a link ShipIt made",
    ]);
  });

  it("keeps both halves of prepare on the card at once", async () => {
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
