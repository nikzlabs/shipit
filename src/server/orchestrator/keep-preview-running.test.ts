import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createKeepPreviewRestartSupervisor,
  restoreReservedPreviews,
} from "./keep-preview-running.js";
import type { SessionInfo } from "../shared/types.js";

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1", title: "Preview", createdAt: "2024-01-01", lastUsedAt: "2024-01-01",
  remoteUrl: "", workspaceDir: "/workspace/s1", keepPreviewRunning: true, ...overrides,
});

function deps(current = session(), runners: Record<string, object> = {}) {
  const emitter = new EventEmitter();
  const containers = new Map<string, { status: string }>();
  const getOrCreate = vi.fn();
  return {
    emitter,
    containers,
    getOrCreate,
    value: {
      sessionManager: { listAll: () => [current], get: () => current },
      runnerRegistry: { getOrCreate, get: (id: string) => runners[id] },
      containerManager: Object.assign(emitter, { get: (id: string) => containers.get(id) }),
      defaultAgentId: "claude" as const,
      broadcastLog: vi.fn(),
    } as any,
  };
}

describe("keep-preview-running lifecycle", () => {
  it("restores a reserved session without a running container at startup", () => {
    const d = deps();
    expect(restoreReservedPreviews(d.value)).toEqual(["s1"]);
    expect(d.getOrCreate).toHaveBeenCalledWith("s1", "/workspace/s1", "claude");
  });

  it("skips an archived session whose reservation flag was never cleared", () => {
    // An archived session has no workspace left (archive evicts it), so a stale
    // flag must not resurrect its container at every startup.
    const d = deps(session({ userArchived: true, archived: true }));
    expect(restoreReservedPreviews(d.value)).toEqual([]);
    expect(d.getOrCreate).not.toHaveBeenCalled();
  });

  it("does not duplicate a session that already has a runner", () => {
    const d = deps(session(), { s1: {} });
    d.containers.set("s1", { status: "running" });
    expect(restoreReservedPreviews(d.value)).toEqual([]);
    expect(d.getOrCreate).not.toHaveBeenCalled();
  });

  // docs/290 — a surviving agent container is NOT a live preview. The routing
  // lives in `serviceManagers`, which is process-local and empty at boot, so a
  // reserved session skipped on "its container is running" was left unroutable
  // with the reservation quietly broken. `getOrCreate` adopts the rediscovered
  // container (the same call the docs/240 turn-adoption sweep makes) rather than
  // creating a second one.
  it("restores routing for a reserved session whose container survived the restart", () => {
    const d = deps();
    d.containers.set("s1", { status: "running" });
    expect(restoreReservedPreviews(d.value)).toEqual(["s1"]);
    expect(d.getOrCreate).toHaveBeenCalledWith("s1", "/workspace/s1", "claude");
  });

  it("bounds unexpected-exit recovery and reports exhaustion", () => {
    vi.useFakeTimers();
    const d = deps();
    const supervisor = createKeepPreviewRestartSupervisor({ ...d.value, delaysMs: [10, 20, 30] });
    supervisor.handleUnexpectedExit("s1");
    vi.advanceTimersByTime(30);
    expect(d.getOrCreate).toHaveBeenCalledTimes(3);
    expect(d.value.broadcastLog).toHaveBeenCalledWith(
      "s1", "server", expect.stringContaining("could not be restored"),
    );
    supervisor.dispose();
    vi.useRealTimers();
  });

  it("cancels remaining retries after a successful container start", () => {
    vi.useFakeTimers();
    const d = deps();
    const supervisor = createKeepPreviewRestartSupervisor({ ...d.value, delaysMs: [10, 20, 30] });
    supervisor.handleUnexpectedExit("s1");
    vi.advanceTimersByTime(10);
    d.emitter.emit("container_started", "s1");
    vi.advanceTimersByTime(100);
    expect(d.getOrCreate).toHaveBeenCalledTimes(1);
    supervisor.dispose();
    vi.useRealTimers();
  });
});
