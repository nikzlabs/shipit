/**
 * Unit tests for `archiveSession` — specifically the container-destroy step
 * that prevents the workspace bind mount from being pinned to an
 * about-to-be-unlinked inode. See docs/154 for the empty-workspace bug
 * (session 1ab5751c-…) that motivated this.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { archiveSession } from "./session.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";
import type { SessionRunnerRegistry } from "../session-runner.js";

let tmpDir: string;
let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let runnerRegistry: SessionRunnerRegistry;
const remoteUrl = "https://github.com/test-user/test-repo.git";
const getBareCacheDir = (_url: string) => "/fake/repo-cache/abc123";

function makeSession(workspaceDir: string): string {
  // Create the workspace dir so the archive fs.rm has something to remove.
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "marker"), "x");
  const id = "sess-1";
  sessionManager.track(id, "Test session", workspaceDir);
  sessionManager.setRemoteUrl(id, remoteUrl);
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-session-archive-test-");
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  runnerRegistry = {
    get: () => undefined,
    dispose: vi.fn(() => undefined),
  } as unknown as SessionRunnerRegistry;
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("archiveSession container teardown", () => {
  it("destroys the agent container before unlinking the workspace dir", async () => {
    const workspaceDir = path.join(tmpDir, "ws");
    const sessionId = makeSession(workspaceDir);

    const events: string[] = [];
    const containerManager = {
      destroy: vi.fn(async (id: string) => {
        events.push(`destroy(${id})`);
        // The fs.rm must NOT have run yet — the bind mount is still pinned
        // until destroy() returns.
        expect(fs.existsSync(workspaceDir)).toBe(true);
      }),
    };

    // Patch fs.rm to record when it ran. Since archiveSession uses
    // node:fs/promises, we shim the module-level fs.promises.rm.
    const realRm = fs.promises.rm;
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      events.push(`fs.rm(${String(args[0])})`);
      return realRm.apply(fs.promises, args as Parameters<typeof realRm>);
    });

    await archiveSession(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined,
      containerManager,
    );

    expect(containerManager.destroy).toHaveBeenCalledWith(sessionId);
    // The workspace dir's fs.rm must come AFTER container destroy.
    const destroyIdx = events.indexOf(`destroy(${sessionId})`);
    const rmIdx = events.indexOf(`fs.rm(${workspaceDir})`);
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThan(destroyIdx);

    rmSpy.mockRestore();
  });

  it("still archives when containerManager is omitted", async () => {
    const workspaceDir = path.join(tmpDir, "ws");
    const sessionId = makeSession(workspaceDir);

    await archiveSession(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
    );

    expect(sessionManager.get(sessionId)?.archived).toBe(true);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("does not abort archive if container destroy throws", async () => {
    const workspaceDir = path.join(tmpDir, "ws");
    const sessionId = makeSession(workspaceDir);

    const containerManager = {
      destroy: vi.fn(async () => {
        throw new Error("docker socket gone");
      }),
    };

    await archiveSession(
      sessionManager,
      runnerRegistry,
      getBareCacheDir,
      sessionId,
      undefined,
      containerManager,
    );

    // Archive still happened — fs.rm cleared the dir and the DB row flipped.
    expect(containerManager.destroy).toHaveBeenCalled();
    expect(sessionManager.get(sessionId)?.archived).toBe(true);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});
