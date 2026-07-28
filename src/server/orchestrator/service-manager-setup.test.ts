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
import { applyShipitConfigChange, setupServiceManager } from "./service-manager-setup.js";
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

  it("reconciles when only the compose file's contents changed", async () => {
    writeConfig("compose: docker-compose.yml\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));
    await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

    expect(mgr.updateComposeConfig).toHaveBeenCalledWith({ file: "docker-compose.yml", dockerSocket: false });
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
