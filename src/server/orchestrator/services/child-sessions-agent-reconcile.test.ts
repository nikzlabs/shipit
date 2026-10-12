import { describe, it, expect, vi } from "vitest";
import { ResolvedChildMessageError, sendChildMessage } from "./child-sessions.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo } from "../../shared/types.js";
import type { SessionInbox } from "./session-inbox.js";

function stubSessionManager(child: Partial<SessionInfo>): SessionManager {
  return {
    get: (id: string) => (id === "child-1" ? (child as SessionInfo) : undefined),
    findChildren: () => [],
  } as unknown as SessionManager;
}

function stubInbox() {
  const post = vi.fn<SessionInbox["post"]>(async () => ({ told: "started" }));
  return {
    post,
    deps: {
      sessionInbox: { post },
      runnerRegistry: { get: () => undefined } as unknown as SessionRunnerRegistry,
      chatHistoryManager: { append: vi.fn(), replaceInProgress: vi.fn() },
    },
  };
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

// The runner's agent is reconciled on the wake path now: `wake-session.test.ts`.
describe("sendChildMessage — which child may get a message (docs/233-child-session-report)", () => {
  it("rejects a resolved child before it stores a message for it", async () => {
    const inbox = stubInbox();

    await expect(sendChildMessage(
      { ...inbox.deps, sessionManager: stubSessionManager({ ...CHILD, mergedAt: "2026-08-14 11:00:00" }) },
      "parent-1",
      "child-1",
      "keep going",
    )).rejects.toBeInstanceOf(ResolvedChildMessageError);

    expect(inbox.post).not.toHaveBeenCalled();
  });

  it("delivers to a child that started a turn after its PR resolved", async () => {
    const inbox = stubInbox();

    await sendChildMessage(
      { ...inbox.deps, sessionManager: stubSessionManager({
        ...CHILD,
        mergedAt: "2026-08-14 11:00:00",
        lastUsedAt: "2026-08-14T12:00:00.000Z",
      }) },
      "parent-1",
      "child-1",
      "keep going",
    );

    expect(inbox.post).toHaveBeenCalledTimes(1);
  });

  // docs/298 — a blocked checkout is unfinished work, and instructing the child
  // to repair it is the repair path. The same predicate undemotes it in the sidebar.
  it("delivers to a merged child whose workspace is blocked", async () => {
    const inbox = stubInbox();

    await sendChildMessage(
      { ...inbox.deps, sessionManager: stubSessionManager({ ...CHILD, mergedAt: "2026-08-14 11:00:00", workspaceBlock: "conflict" }) },
      "parent-1",
      "child-1",
      "abort the rebase",
    );

    expect(inbox.post).toHaveBeenCalledWith(
      expect.objectContaining({ id: "child-1" }),
      { origin: { sessionId: "parent-1", sessionTitle: "Parent session", relation: "parent" }, body: "abort the rebase" },
    );
  });
});
