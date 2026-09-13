import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdleEnforcer } from "./idle-enforcer.js";
import { SessionRunnerRegistry } from "./session-runner.js";
import { CLEANUP_CONTAINER_SESSION_ID } from "./cleanup-container.js";
import { runSteadyStateReclaim } from "./steady-state-reclaim.js";
import type { SessionContainerManager } from "./session-container.js";
import type { DockerMemoryStats } from "../shared/types.js";
import type { RepoStore } from "./repo-store.js";

const ORDINARY = "11111111-1111-4111-8111-111111111111";

/**
 * The shortfall is exactly the cleanup container's measured bytes, so the two
 * assertions move together: without the exemption the pass takes the cleanup
 * container, `need` reaches zero, and the ordinary session survives instead.
 */
function overBudget(): DockerMemoryStats {
  return {
    usedBytes: 150,
    totalBytes: 100,
    budgetBytes: 100,
    bySession: {
      [CLEANUP_CONTAINER_SESSION_ID]: { agentBytes: 50, serviceBytes: 0 },
      [ORDINARY]: { agentBytes: 50, serviceBytes: 0 },
    },
  };
}

describe("docs/299 req 8 — the cleanup container is never reclaimed", () => {
  let registry: SessionRunnerRegistry;

  beforeEach(() => { registry = new SessionRunnerRegistry(); });
  afterEach(() => { registry.disposeAll(); });

  it("a memory-pressure pass takes the ordinary session and leaves the cleanup container", () => {
    const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
    // No runner and no viewer for either: the cleanup container would otherwise
    // sort first, since docs/284 orders by lastViewerDetachAt and it has none.
    const containerManager = {
      getAll: () => [{ sessionId: CLEANUP_CONTAINER_SESSION_ID }, { sessionId: ORDINARY }],
      isStandby: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
      destroyAgentContainer,
    } as unknown as SessionContainerManager;

    createIdleEnforcer({
      containerManager,
      runnerRegistry: registry,
      getMemoryStats: () => overBudget(),
    })();

    expect(destroyAgentContainer).toHaveBeenCalledWith(ORDINARY);
    expect(destroyAgentContainer).not.toHaveBeenCalledWith(CLEANUP_CONTAINER_SESSION_ID);
  });

  it("stays exempt even when it is the only reclaimable container left", () => {
    const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
    const containerManager = {
      getAll: () => [{ sessionId: CLEANUP_CONTAINER_SESSION_ID }],
      isStandby: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
      destroyAgentContainer,
    } as unknown as SessionContainerManager;

    createIdleEnforcer({
      containerManager,
      runnerRegistry: registry,
      getMemoryStats: () => overBudget(),
    })();

    expect(destroyAgentContainer).not.toHaveBeenCalled();
  });

  it("an ordinary session with the same shape is still reclaimed", () => {
    const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
    const containerManager = {
      getAll: () => [{ sessionId: ORDINARY }],
      isStandby: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
      destroyAgentContainer,
    } as unknown as SessionContainerManager;

    createIdleEnforcer({
      containerManager,
      runnerRegistry: registry,
      getMemoryStats: () => overBudget(),
    })();

    expect(destroyAgentContainer).toHaveBeenCalledWith(ORDINARY);
  });

  it("a disk reclaim pass leaves the cleanup container's workspace and credentials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-reclaim-"));
    const workspace = path.join(root, "state", "sessions", CLEANUP_CONTAINER_SESSION_ID, "workspace");
    const credentials = path.join(root, "credentials", "sessions", CLEANUP_CONTAINER_SESSION_ID);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(credentials, { recursive: true });
    fs.writeFileSync(path.join(credentials, ".claude.json"), "{}");

    try {
      await runSteadyStateReclaim({
        stateDir: path.join(root, "state"),
        credentialsDir: path.join(root, "credentials"),
        repoStore: { list: () => [] } as unknown as RepoStore,
        runDocker: async () => "",
        liveOverlayScopeHashes: () => new Set<string>(),
        pnpmStoreRuntimeHash: () => null,
      });

      expect(fs.existsSync(workspace)).toBe(true);
      expect(fs.existsSync(path.join(credentials, ".claude.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Guards the reserved id's shape: paths, labels and credential subtrees all key
// on it as if it were an ordinary session id.
it("the reserved session id is UUID-shaped", () => {
  expect(CLEANUP_CONTAINER_SESSION_ID).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
