import { describe, it, expect, vi } from "vitest";
import { ResolvedChildMessageError, sendChildMessage } from "./child-sessions.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { AgentId, SessionInfo } from "../../shared/types.js";

function stubSessionManager(child: Partial<SessionInfo>): SessionManager {
  return {
    get: (id: string) => (id === "child-1" ? (child as SessionInfo) : undefined),
    findChildren: () => [],
  } as unknown as SessionManager;
}

function stubRunner(agentId: AgentId, running = false) {
  return {
    agentId,
    running,
    disposed: false,
    sessionId: "child-1",
    dispatch: vi.fn(),
  };
}

function stubRegistry(runner: ReturnType<typeof stubRunner>) {
  return {
    // Like the registry, return existing runners without applying the agentId argument.
    getOrCreate: vi.fn(() => runner),
    get: vi.fn(() => runner),
    dispose: vi.fn(),
  } as unknown as SessionRunnerRegistry;
}

const CHILD: Partial<SessionInfo> = {
  id: "child-1",
  parentSessionId: "parent-1",
  workspaceDir: "/tmp/child-1",
  agentId: "codex",
  archived: false,
  title: "Child one",
  lastUsedAt: "2026-08-14T10:00:00.000Z",
};

describe("sendChildMessage — agent reconciliation (req 18)", () => {
  it("rejects a resolved child before it creates or dispatches a runner", async () => {
    const runner = stubRunner("claude");
    const registry = stubRegistry(runner);

    await expect(sendChildMessage(
      stubSessionManager({ ...CHILD, mergedAt: "2026-08-14 11:00:00" }),
      registry,
      "parent-1",
      "child-1",
      "keep going",
      "claude",
      undefined,
      undefined,
    )).rejects.toBeInstanceOf(ResolvedChildMessageError);

    expect(registry.getOrCreate).not.toHaveBeenCalled();
    expect(runner.dispatch).not.toHaveBeenCalled();
  });

  it("delivers to a child that started a turn after its PR resolved", async () => {
    const runner = stubRunner("codex");
    const registry = stubRegistry(runner);

    await sendChildMessage(
      stubSessionManager({
        ...CHILD,
        mergedAt: "2026-08-14 11:00:00",
        lastUsedAt: "2026-08-14T12:00:00.000Z",
      }),
      registry,
      "parent-1",
      "child-1",
      "keep going",
      "claude",
      undefined,
      undefined,
    );

    expect(runner.dispatch).toHaveBeenCalledTimes(1);
  });

  it("runs the child's persisted agent when the registry hands back a stale runner", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runner = stubRunner("claude");
    const registry = stubRegistry(runner);

    await sendChildMessage(
      stubSessionManager(CHILD),
      registry,
      "parent-1",
      "child-1",
      "keep going",
      "claude",
      undefined,
      undefined,
    );

    expect(runner.agentId).toBe("codex");
    expect(runner.dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves a running turn's agent alone", async () => {
    const runner = stubRunner("claude", true);
    const registry = stubRegistry(runner);

    await sendChildMessage(
      stubSessionManager(CHILD),
      registry,
      "parent-1",
      "child-1",
      "keep going",
      "claude",
      undefined,
      undefined,
    );

    expect(runner.agentId).toBe("claude");
  });

  it("falls back to the orchestrator default for a child that has never run", async () => {
    const runner = stubRunner("claude");
    const registry = stubRegistry(runner);

    await sendChildMessage(
      stubSessionManager({ ...CHILD, agentId: undefined }),
      registry,
      "parent-1",
      "child-1",
      "first message",
      "claude",
      undefined,
      undefined,
    );

    expect(runner.agentId).toBe("claude");
    expect(runner.dispatch).toHaveBeenCalledTimes(1);
  });
});
