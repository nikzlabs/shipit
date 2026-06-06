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
import { setupServiceManager } from "./service-manager-setup.js";
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
