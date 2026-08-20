/**
 * Focused unit tests for the docs/178 trust gate inside `setupServiceManager`.
 *
 * The gate is the on-activation half of the repo trust boundary: a repo-backed
 * session whose remote has NOT been trusted must defer all repo-declared
 * auto-execution (`agent.install` + compose startup). A session with no remote
 * is authored locally and is trusted by construction.
 *
 * We drive `setupServiceManager` with a minimal fake runner + fake session
 * manager and a real in-memory `RepoStore`, then observe whether it proceeds
 * past the gate. The tell is the `compose_not_configured` emit: the function
 * reaches it only when the gate lets it through (the temp workspace has no
 * `docker-compose.yml`, so a trusted run falls through to that emit; an
 * untrusted run returns before emitting anything).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { RepoStore } from "./repo-store.js";
import { applyShipitConfigChange, emitPluginReposUpdated, setupServiceManager } from "./service-manager-setup.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { installContentKeyDiagnostic } from "./install-content-key.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";

const REMOTE = "https://github.com/owner/repo.git";

let dbManager: DatabaseManager;
let repoStore: RepoStore;
let tmpDir: string;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  repoStore = new RepoStore(dbManager);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-gate-test-"));
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunner(): SessionRunnerInterface & { emitMessage: ReturnType<typeof vi.fn> } {
  return {
    sessionId: "s1",
    sessionDir: tmpDir,
    emitMessage: vi.fn(),
    on: vi.fn(),
    setServiceManager: vi.fn(),
  } as unknown as SessionRunnerInterface & { emitMessage: ReturnType<typeof vi.fn> };
}

function makeDeps(remoteUrl: string | undefined) {
  const sessionManager = {
    get: () => ({ workspaceDir: tmpDir, remoteUrl }),
  } as unknown as SessionManager;
  return {
    sessionManager,
    repoStore,
    serviceManagers: new Map<string, ServiceManager>(),
    composeStopPromises: new Map<string, Promise<void>>(),
    composeWarnings: new Map<string, string>(),
    composeNotConfigured: new Set<string>(),
    containerManager: null,
    // Sibling of the workspace — required (planning#292) and must resolve outside it.
    serviceEnvDir: path.join(tmpDir, "..", "service-env"),
  };
}

describe("setupServiceManager trust gate (docs/178)", () => {
  it("defers setup for an untrusted remote — nothing is emitted", () => {
    repoStore.add(REMOTE); // untrusted by default
    const runner = makeRunner();
    const deps = makeDeps(REMOTE);

    setupServiceManager(runner, deps);

    expect(runner.emitMessage).not.toHaveBeenCalled();
    expect(deps.composeNotConfigured.has("s1")).toBe(false);
  });

  it("proceeds once the remote is trusted", () => {
    repoStore.add(REMOTE);
    repoStore.setTrusted(REMOTE, true);
    const runner = makeRunner();
    const deps = makeDeps(REMOTE);

    setupServiceManager(runner, deps);

    // No docker-compose.yml in the temp workspace → it reaches the
    // compose-not-configured branch, proving the gate let it through.
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("treats a session with no remote as trusted (locally authored)", () => {
    const runner = makeRunner();
    const deps = makeDeps(""); // empty remote = local session

    setupServiceManager(runner, deps);

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
  });
});

/**
 * The overlay publish hook must not treat a synthesized install success as an
 * installed tree (found by review, 2026-08-20).
 *
 * `publishOverlayBases` takes `installOk` at face value and stamps the base
 * pointer's `markerStamp.installCommands` with the declared list — and that
 * pointer is exactly what `preStampInstallMarker` later reads to decide that a
 * fresh session's dependencies are already installed AND that its command list
 * is accepted. Three paths resolve `ok: true` having observed no install at all
 * (dispose, dispose-before-worker-ready, and the reconnect resync that cannot
 * tell success from failure), so without the `unverified` gate a dropped SSE
 * stream could publish a missing or half-installed dep tree as the SHARED base
 * for the whole scope.
 */
describe("setupServiceManager — overlay publish gate", () => {
  function runnerWithInstall(): ContainerSessionRunner {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  install:\n    - npm ci\n");
    return new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://127.0.0.1:1",
    });
  }

  async function publishCallsFor(outcome: {
    ok: boolean; withheld?: boolean; unverified?: boolean;
  }): Promise<number> {
    repoStore.add(REMOTE);
    repoStore.setTrusted(REMOTE, true);
    const runner = runnerWithInstall();
    vi.spyOn(runner, "runInstall").mockResolvedValue(outcome);
    vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);
    const publishOverlayBases = vi.fn(async () => []);
    setupServiceManager(runner, { ...makeDeps(REMOTE), publishOverlayBases });
    // The publish rides an un-awaited async IIFE hanging off the install promise.
    await vi.waitFor(() => expect(runner.runInstall).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    return publishOverlayBases.mock.calls.length;
  }

  it("publishes when the install genuinely ran", async () => {
    expect(await publishCallsFor({ ok: true })).toBe(1);
  });

  it("does NOT publish an install that was never observed", async () => {
    expect(await publishCallsFor({ ok: true, unverified: true })).toBe(0);
  });

  it("does NOT publish a withheld install (docs/271)", async () => {
    expect(await publishCallsFor({ ok: true, withheld: true })).toBe(0);
  });
});

/**
 * `applyShipitConfigChange` — the incremental "the workspace config moved under
 * us" path, driven both by the in-container file watcher and by
 * orchestrator-side workspace rewrites (rebase / rollback).
 *
 * The bug this covers: a `ServiceManager` captures its `compose:` block (and
 * the session captures `agent.install`) once at setup, so `reconcile()` alone
 * re-parses only the compose FILE. A session rebased onto a base whose
 * `shipit.yaml` changed would keep running the old definition forever.
 */
describe("applyShipitConfigChange", () => {
  /** Minimal ServiceManager stand-in — records what the applier asked of it. */
  function makeFakeManager() {
    return {
      composeFile: "docker-compose.yml",
      dockerSocket: false,
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null as string | null,
      updateComposeConfig: vi.fn(function (this: { composeFile: string; dockerSocket: boolean }, next: { file: string; dockerSocket: boolean }) {
        const changed = next.file !== this.composeFile || next.dockerSocket !== this.dockerSocket;
        this.composeFile = next.file;
        this.dockerSocket = next.dockerSocket;
        return changed;
      }),
    };
  }

  function writeConfig(yaml: string): void {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), yaml);
  }

  function makeLiveDeps(mgr: unknown) {
    const deps = makeDeps("");
    deps.serviceManagers.set("s1", mgr as ServiceManager);
    return deps;
  }

  // docs/262 — an activation round settles on every session activation and every
  // shipit.yaml edit, so the reconcile it can trigger must be gated on the
  // plugin services actually having changed, and must never overlap the first
  // start() (which is what `serializeStackOp` guarantees).
  describe("plugin services on an activation round (docs/262)", () => {
    function makePluginManager(services: unknown[]) {
      return {
        ...makeFakeManager(),
        setPluginServices: vi.fn((next: unknown[]) =>
          JSON.stringify(next) !== JSON.stringify(services)),
        // req 23 — a settled round also resyncs the declared credential names,
        // so a manager in the map has to answer this too.
        refreshSecretsStatus: vi.fn(async () => { /* no secrets store in tests */ }),
      };
    }

    it("reconciles once when the round changes the plugin services", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const mgr = makePluginManager([]);
      const deps = {
        ...makeLiveDeps(mgr),
        resolvePluginServices: vi.fn(async () => [{ name: "probe" }] as never),
      };

      emitPluginReposUpdated(runner, deps)("s1");
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalledTimes(1));
      expect(deps.resolvePluginServices).toHaveBeenCalledWith("s1", tmpDir);
    });

    it("does not reconcile when the round changes nothing", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const mgr = makePluginManager([]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      emitPluginReposUpdated(runner, deps)("s1");
      await vi.waitFor(() => expect(deps.resolvePluginServices).toHaveBeenCalled());
      expect(mgr.reconcile).not.toHaveBeenCalled();
    });

    it("still tells viewers the round settled when there is no manager", () => {
      const runner = makeRunner();
      const deps = { ...makeDeps(""), resolvePluginServices: vi.fn(async () => [] as never) };

      emitPluginReposUpdated(runner, deps)("s1");
      expect(runner.emitMessage).toHaveBeenCalledWith({ type: "plugin_repos_updated", sessionId: "s1" });
      expect(deps.resolvePluginServices).not.toHaveBeenCalled();
    });
  });

  /**
   * docs/262 req 20 — a collision the project's OWN compose file gains after the
   * last activation round.
   *
   * The plugin service set is derived from three inputs: the declaration, each
   * repository's live generation, and the project's own service names
   * (`collectPluginFragments` seeds its name domain with them). Only the first
   * two used to re-resolve it. So a user who added a service under a name an
   * imported plugin already surfaces got both definitions handed to Compose as
   * one service — the plugin's overlaying theirs — with the collision computed
   * only when some later activation round happened to settle, which for a
   * repository that has to be fetched is a network round-trip away.
   */
  describe("plugin services on a project config change (docs/262 req 20)", () => {
    /** A manager that records the ORDER the applier drives it in. */
    function makeRecordingManager(surfacedLastRound: unknown[]) {
      const calls: string[] = [];
      const mgr = {
        ...makeFakeManager(),
        reconcile: vi.fn(async () => { calls.push("reconcile"); }),
        setPluginServices: vi.fn((next: unknown[]) => {
          calls.push("setPluginServices");
          return JSON.stringify(next) !== JSON.stringify(surfacedLastRound);
        }),
      };
      return { mgr, calls };
    }

    it("re-resolves the plugin services before the reconcile runs the new file", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      // Last round surfaced the plugin's `probe`; the project's compose file has
      // just taken that name, so this round withholds it.
      const { mgr, calls } = makeRecordingManager([{ name: "probe" }]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      expect(deps.resolvePluginServices).toHaveBeenCalledWith("s1", tmpDir);
      // BEFORE, not after: `reconcile()` regenerates the override and runs
      // `compose up`, so a set resolved afterwards is one the ambiguous service
      // has already been started against.
      expect(calls).toEqual(["setPluginServices", "reconcile"]);
    });

    it("tells viewers to refetch when the re-resolution changed the set", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([{ name: "probe" }]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      // The withholding alone would make the plugin's service vanish with no
      // reason attached. The card recomputes the collision on every snapshot, so
      // the push is what makes the reason arrive with the change.
      expect(runner.emitMessage).toHaveBeenCalledWith({
        type: "plugin_repos_updated",
        sessionId: "s1",
      });
    });

    it("says nothing extra when the set is unchanged, and still reconciles", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      // An ordinary compose edit that collides with nothing must not light the
      // Plugins tab up — the reconcile is the whole of its effect.
      expect(runner.emitMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "plugin_repos_updated" }),
      );
    });

    // The last-resort path. The resolver's own contract is that it never fails a
    // session — its one daemon round-trip degrades to a per-repository reason on
    // the card (`plugin-services.ts`) — so reaching this catch at all means an
    // unattributable fault. Then: reconcile the project's file anyway on the
    // previous plugin set. Refusing the project's own reconcile over a plugin
    // fault inverts req 14, and dropping every repository's services over a
    // fault none of them can be blamed for takes working siblings away.
    it("reconciles anyway when the resolution itself fails", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([]);
      const deps = {
        ...makeLiveDeps(mgr),
        resolvePluginServices: vi.fn(async () => { throw new Error("docker is away"); }),
      };

      applyShipitConfigChange(runner, deps);

      // req 13 — the project's own stack comes up regardless, on the previous
      // plugin set rather than on none.
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());
      expect(mgr.setPluginServices).not.toHaveBeenCalled();
    });
  });

  it("reconciles when only the compose file's contents changed", async () => {
    writeConfig("compose: docker-compose.yml\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));
    await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

    // docs/262 — the second argument says whether the project HAS a compose file
    // of its own, which it does not only when its stack is its declared plugins
    // alone.
    expect(mgr.updateComposeConfig).toHaveBeenCalledWith(
      { file: "docker-compose.yml", dockerSocket: false },
      { noProjectCompose: false },
    );
    expect(mgr.composeFile).toBe("docker-compose.yml");
  });

  it("adopts a new compose path from shipit.yaml before reconciling", async () => {
    writeConfig("compose:\n  file: deploy/compose.yml\n  docker-socket: true\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));
    await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

    // Without this the reconcile would re-parse the ORIGINAL compose file and
    // the services declared in the new one would never appear.
    expect(mgr.composeFile).toBe("deploy/compose.yml");
    expect(mgr.dockerSocket).toBe(true);
  });

  it("tears the stack down when the compose block is removed", () => {
    writeConfig("agent:\n  install: npm ci\n");
    const runner = makeRunner();
    const deps = makeLiveDeps(makeFakeManager());

    applyShipitConfigChange(runner, deps);

    expect(deps.serviceManagers.has("s1")).toBe(false);
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
  });

  it("keeps the running stack when the incoming shipit.yaml is invalid", () => {
    writeConfig("compose: [not, a, path]\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));

    expect(mgr.reconcile).not.toHaveBeenCalled();
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compose_error",
        message: expect.stringContaining("keeping the previous configuration") as unknown as string,
      }),
    );
  });

  it("falls back to full setup when no ServiceManager exists yet", () => {
    // Compose was never configured for this session — the delta path can't
    // diff anything, so it must delegate to the full setup.
    writeConfig("agent:\n  install: npm ci\n");
    const runner = makeRunner();
    const deps = makeDeps("");

    applyShipitConfigChange(runner, deps);

    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("re-runs agent.install when the command list changes", () => {
    writeConfig("compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npx prisma generate\n");
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    runner.setDepReinstallInputs(["npm ci"], ["package-lock.json"]);
    const requestDepReinstall = vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });

    applyShipitConfigChange(runner, makeLiveDeps(makeFakeManager()));

    expect(runner.appliedInstallCommands).toEqual(["npm ci", "npx prisma generate"]);
    expect(requestDepReinstall).toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("does not re-run agent.install when the command list is unchanged", () => {
    writeConfig("compose: docker-compose.yml\nagent:\n  install: npm ci\n");
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    runner.setDepReinstallInputs(["npm ci"], ["package-lock.json"]);
    const requestDepReinstall = vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });

    applyShipitConfigChange(runner, makeLiveDeps(makeFakeManager()));

    expect(requestDepReinstall).not.toHaveBeenCalled();
    runner.dispose({ force: true });
  });
});

/**
 * `resolveShipitConfig` falls back to defaults — which carry `compose:
 * undefined` — for a file that is MISSING *or* merely unreadable. The mid-
 * session applier reads `compose: undefined` as "tear the stack down", so it
 * has to tell those two apart: a transient read failure while git rewrites the
 * working tree must not kill a running preview.
 */
describe("applyShipitConfigChange — compose-removal is gated on a trustworthy read", () => {
  function makeFakeManager() {
    return {
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null as string | null,
      updateComposeConfig: vi.fn(() => false),
    };
  }

  it("tears down when shipit.yaml is genuinely absent", () => {
    const runner = makeRunner();
    const deps = makeDeps("");
    deps.serviceManagers.set("s1", makeFakeManager() as unknown as ServiceManager);
    // No shipit.yaml written at all — ENOENT is a real "no compose declared".

    applyShipitConfigChange(runner, deps);

    expect(deps.serviceManagers.has("s1")).toBe(false);
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("keeps the stack when shipit.yaml exists but cannot be read", () => {
    const runner = makeRunner();
    const deps = makeDeps("");
    const mgr = makeFakeManager();
    deps.serviceManagers.set("s1", mgr as unknown as ServiceManager);

    const yamlPath = path.join(tmpDir, "shipit.yaml");
    fs.writeFileSync(yamlPath, "compose: docker-compose.yml\n");
    const realReadFileSync = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === "string" && p === yamlPath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realReadFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as unknown as typeof fs.readFileSync);

    try {
      applyShipitConfigChange(runner, deps);
    } finally {
      spy.mockRestore();
    }

    // Unreadable ≠ removed: the running stack survives untouched.
    expect(deps.serviceManagers.has("s1")).toBe(true);
    expect(deps.composeNotConfigured.has("s1")).toBe(false);
    expect(mgr.stop).not.toHaveBeenCalled();
    expect(mgr.reconcile).not.toHaveBeenCalled();
  });
});

/**
 * planning#292 — `serviceEnvDir` is required, and the wiring hop that supplies it is
 * `ServiceSetupDeps → ServiceManagerOptions → ServiceSecretsResolver`.
 *
 * The `ServiceManager` tests construct a manager directly with an explicit root,
 * so they prove the resolver honours whatever root it is handed but not that
 * `setupServiceManager` hands it the deps' one. That gap matters because the
 * failure mode is a *type-correct* mistake: pass a clone-derived root and the
 * compiler is satisfied while `assertServiceEnvRootOutsideWorkspace` fails the
 * whole stack at start. This test closes it by asserting the effect — where the
 * env file actually lands — through the real construction path.
 */
describe("setupServiceManager threads serviceEnvDir to the secrets resolver (planning#292)", () => {
  it("writes service env files under the deps' root, never into the clone", async () => {
    // A real session layout: the clone at `<sessionDir>/workspace`, which is what
    // `ServiceManager` resolves its state dir from.
    const sessionDir = path.join(tmpDir, "session");
    const clone = path.join(sessionDir, "workspace");
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(
      path.join(clone, "docker-compose.yml"),
      "services:\n  api:\n    image: node:20\n    x-shipit-secrets:\n      - DATABASE_URL\n",
    );
    fs.writeFileSync(path.join(clone, "shipit.yaml"), "compose: docker-compose.yml\n");
    const serviceEnvDir = path.join(tmpDir, "service-env");

    const runner = makeRunner();
    const deps = {
      ...makeDeps(""), // no remote → trusted, so the gate lets it through
      sessionManager: {
        get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
      } as unknown as SessionManager,
      serviceEnvDir,
    };

    setupServiceManager(runner, deps);

    const mgr = deps.serviceManagers.get("s1");
    expect(mgr).toBeDefined();
    // `refreshSecrets()` runs the resolver and returns early when the stack
    // isn't started, so this needs no Docker.
    await mgr!.refreshSecrets();

    expect(fs.existsSync(path.join(serviceEnvDir, "s1", ".env.api"))).toBe(true);
    expect(fs.existsSync(path.join(clone, ".shipit"))).toBe(false);
  });
});

/**
 * Follow-up to nikzlabs/shipit#2429 — the condition is detected where the
 * dependency-input set is resolved, so the user learns from the diagnostics
 * panel that content-keying is off *before* the failure it eventually causes.
 *
 * Driven through `applyShipitConfigChange` because that is the path a user's
 * `shipit.yaml` edit takes, and it is where the record can go stale: the
 * remedy (`agent.install-inputs`) leaves `agent.install` untouched, so a check
 * living inside the command-list delta would never see it.
 */
describe("content-key reporting (install-content-key.ts)", () => {
  /** A production-shaped clone — the state dir derives from `<sessionDir>/workspace`. */
  function makeClone(): string {
    const clone = path.join(tmpDir, "session", "workspace");
    fs.mkdirSync(clone, { recursive: true });
    return clone;
  }

  function makeContainerRunner(clone: string): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: clone,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });
    return runner;
  }

  function makeCloneDeps(clone: string) {
    const deps = makeDeps("");
    deps.sessionManager = {
      get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
    } as unknown as SessionManager;
    deps.serviceManagers.set("s1", {
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null,
      updateComposeConfig: vi.fn(() => false),
    } as unknown as ServiceManager);
    return deps;
  }

  it("records a non-content-keyable install so diagnostics can report it", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npm run build\n",
    );
    const runner = makeContainerRunner(clone);

    applyShipitConfigChange(runner, makeCloneDeps(clone));

    expect(installContentKeyDiagnostic(clone)?.commands).toEqual(["npm ci", "npm run build"]);
    runner.dispose({ force: true });
  });

  it("stops reporting when install-inputs is added, though agent.install is unchanged", () => {
    const clone = makeClone();
    const install = "compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npx prisma generate\n";
    fs.writeFileSync(path.join(clone, "shipit.yaml"), install);
    const runner = makeContainerRunner(clone);
    const deps = makeCloneDeps(clone);

    applyShipitConfigChange(runner, deps);
    expect(installContentKeyDiagnostic(clone)).not.toBeNull();

    // The remedy the notice names. The command list does not move, so this is
    // exactly what a check inside the `sameCommands` delta would miss.
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      `${install}  install-inputs: [package.json, package-lock.json, prisma/schema.prisma]\n`,
    );
    applyShipitConfigChange(runner, deps);

    expect(installContentKeyDiagnostic(clone)).toBeNull();
    runner.dispose({ force: true });
  });

  // The other tests here drive `applyShipitConfigChange`. This one drives the
  // INITIAL setup, which is where the spec puts the detection: the two paths
  // are separate call sites, so an early return added to one would otherwise
  // diverge silently from the other.
  it("detects at first setup, not only on a later config change", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "agent:\n  install:\n    - npm ci\n    - npm run build\n",
    );
    const runner = makeContainerRunner(clone);
    // The install itself needs a worker; the detection sits beside it and does not.
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    const deps = makeDeps("");
    deps.sessionManager = {
      get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
    } as unknown as SessionManager;

    setupServiceManager(runner, deps);

    expect(installContentKeyDiagnostic(clone)?.commands).toEqual(["npm ci", "npm run build"]);
    runner.dispose({ force: true });
  });

  it("says nothing for a pure dependency install", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "compose: docker-compose.yml\nagent:\n  install: npm ci\n",
    );
    const runner = makeContainerRunner(clone);

    applyShipitConfigChange(runner, makeCloneDeps(clone));

    expect(installContentKeyDiagnostic(clone)).toBeNull();
    runner.dispose({ force: true });
  });
});
