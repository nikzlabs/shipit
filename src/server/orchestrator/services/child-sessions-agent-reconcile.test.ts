/**
 * docs/150 req 18 — a child session's follow-up turn must run on the child's
 * OWN agent, not on the orchestrator's global default.
 *
 * The bug this guards: `SessionRunnerRegistry.getOrCreate` applies its
 * `defaultAgentId` argument only when it CONSTRUCTS a runner. `sendChildMessage`
 * correctly passes `child.agentId ?? defaultAgentId`, but when a runner already
 * exists in the registry — seeded with the global default by container rescue
 * (`services/recovery.ts`) or the warm pool — that argument is ignored and the
 * stale runner comes back. Everything downstream then reads `runner.agentId`:
 * `prepareSessionAgentEnvironment` provisions THAT agent's credentials, and
 * `runDispatchedTurn` is handed `runner._agentId` as the agent to run. So a
 * Codex child ran Claude, with Claude's credentials provisioned to match, which
 * is what made it look intentional rather than broken.
 */

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
    // The heart of the bug: an existing runner is returned as-is and the
    // agentId argument is discarded. Modelled faithfully rather than stubbed
    // away, so this test fails if the production call stops reconciling.
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
    const runner = stubRunner("claude"); // seeded by container rescue
    const registry = stubRegistry(runner);

    await sendChildMessage(
      stubSessionManager(CHILD),
      registry,
      "parent-1",
      "child-1",
      "keep going",
      "claude", // orchestrator default — deliberately NOT the child's agent
      undefined, // no credentialsDir: skip env-prep, isolate the agent decision
      undefined,
    );

    // The runner is what `runDispatchedTurn` reads its agent id from, so this
    // is the assertion that the TURN runs on Codex — not merely that a local
    // variable was computed correctly.
    expect(runner.agentId).toBe("codex");
    expect(runner.dispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves a running turn's agent alone", async () => {
    // The agent process is already spawned under the old id; reassigning would
    // desynchronize the runner from its own live process. The message queues
    // and the NEXT turn picks up the reconciled id.
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
    // A never-run child has no persisted agent yet, so the seed is all there
    // is and must not be overwritten with nothing.
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
