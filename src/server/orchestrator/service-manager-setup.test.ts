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
