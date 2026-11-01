import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { discardSpawnedChild } from "./session.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

let tmpDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let workspaceDir: string;
const childId = "child-1";

function registry(runner?: object): SessionRunnerRegistry {
  return { get: () => runner, dispose: vi.fn() } as unknown as SessionRunnerRegistry;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-discard-child-test-");
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  workspaceDir = path.join(tmpDir, childId, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  sessionManager.track(childId, "Child", workspaceDir);
  sessionManager.track("other", "Other", path.join(tmpDir, "other", "workspace"));
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("discardSpawnedChild", () => {
  it("removes the runner, the container, the checkout and the row, and only for that session", async () => {
    const runnerRegistry = registry();
    const sseBroadcast = vi.fn();
    const containerManager = {
      destroy: vi.fn(async () => {
        // The bind mount must be released while the directory still exists.
        expect(fs.existsSync(workspaceDir)).toBe(true);
      }),
    };

    await discardSpawnedChild({ sessionManager, runnerRegistry, sseBroadcast, containerManager }, childId);

    expect(runnerRegistry.dispose).toHaveBeenCalledWith(childId, { force: true });
    expect(containerManager.destroy).toHaveBeenCalledWith(childId);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(sessionManager.get(childId)).toBeUndefined();
    expect(sessionManager.get("other")).toBeDefined();
    expect(sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: sessionManager.list() });
  });

  it("removes the volumes with the runner that owns the Compose stack", async () => {
    const runner = { removeVolumesOnDispose: false };
    const pruneSessionVolumes = vi.fn(async () => {});

    await discardSpawnedChild(
      { sessionManager, runnerRegistry: registry(runner), sseBroadcast: vi.fn(), pruneSessionVolumes },
      childId,
    );

    expect(runner.removeVolumesOnDispose).toBe(true);
    expect(pruneSessionVolumes).not.toHaveBeenCalled();
  });

  it("prunes the volumes itself when no runner exists to do it", async () => {
    const pruneSessionVolumes = vi.fn(async () => {});

    await discardSpawnedChild(
      { sessionManager, runnerRegistry: registry(), sseBroadcast: vi.fn(), pruneSessionVolumes },
      childId,
    );

    expect(pruneSessionVolumes).toHaveBeenCalledWith(childId);
  });

  it("keeps the session when its container cannot be destroyed, so the leftover stays visible", async () => {
    const containerManager = { destroy: vi.fn().mockRejectedValue(new Error("docker is down")) };

    await expect(
      discardSpawnedChild(
        { sessionManager, runnerRegistry: registry(), sseBroadcast: vi.fn(), containerManager },
        childId,
      ),
    ).rejects.toThrow(/docker is down/);

    expect(sessionManager.get(childId)).toBeDefined();
    expect(fs.existsSync(workspaceDir)).toBe(true);
  });

  it.each([
    ["a running turn", { running: true, queueLength: 0 }],
    ["a queued message", { running: false, queueLength: 1 }],
  ])("keeps a session that already has %s", async (_what, runner) => {
    const runnerRegistry = registry(runner);
    const containerManager = { destroy: vi.fn() };

    await expect(
      discardSpawnedChild({ sessionManager, runnerRegistry, sseBroadcast: vi.fn(), containerManager }, childId),
    ).rejects.toThrow(/a turn has started/);

    expect(runnerRegistry.dispose).not.toHaveBeenCalled();
    expect(containerManager.destroy).not.toHaveBeenCalled();
    expect(sessionManager.get(childId)).toBeDefined();
    expect(fs.existsSync(workspaceDir)).toBe(true);
  });

  it("throws when the record is still present, so the caller can report its id", async () => {
    vi.spyOn(sessionManager, "delete").mockReturnValue(false);

    await expect(
      discardSpawnedChild({ sessionManager, runnerRegistry: registry(), sseBroadcast: vi.fn() }, childId),
    ).rejects.toThrow(/record could not be deleted/);
  });
});
