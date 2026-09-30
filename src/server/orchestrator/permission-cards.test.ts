import { describe, expect, it, vi } from "vitest";
import { denyAbandonedPermissionCards, settlePermissionCard, type PermissionCardDeps } from "./permission-cards.js";
import type { RecordedChatCard } from "./session-runner.js";
import type { WsServerMessage } from "../shared/types.js";

function setup(opts: { running: boolean; inProgressRows: boolean; ids: string[] }) {
  const emitted: WsServerMessage[] = [];
  const card = (requestId: string): RecordedChatCard => ({
    afterGroupIndex: 0,
    message: {
      role: "assistant",
      text: "",
      permissionPrompt: { requestId, phase: "pending", toolName: "Bash", createdAt: "2026-09-30T10:00:00.000Z" },
    },
  });
  const runner = {
    running: opts.running,
    recordedCards: opts.ids.map(card),
    chatMessageGroups: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [],
    lastPersistedBufferIndex: 0,
    emitMessage: (m: WsServerMessage) => { emitted.push(m); },
    awaitingPermissionIds: new Set(opts.ids),
  };
  const chatHistoryManager = {
    hasInProgress: () => opts.inProgressRows,
    replaceInProgress: vi.fn(),
    updatePermissionCard: vi.fn(),
  };
  const sseBroadcast = vi.fn();
  const deps = { chatHistoryManager, sseBroadcast } as unknown as PermissionCardDeps;
  const recordedPhase = (requestId: string) =>
    runner.recordedCards.find((c) => c.message.permissionPrompt?.requestId === requestId)?.message.permissionPrompt?.phase;
  const attention = () => sseBroadcast.mock.calls.filter(([e]) => e === "session_attention").map(([, d]) => d as unknown);
  return { runner, emitted, chatHistoryManager, deps, recordedPhase, attention };
}

describe("settlePermissionCard", () => {
  it("patches the recorded card and rewrites the in-progress turn while the turn owns it", () => {
    const { runner, deps, chatHistoryManager, recordedPhase, emitted } = setup({ running: true, inProgressRows: true, ids: ["p1"] });

    settlePermissionCard(runner, "s1", deps, "p1", "approved", true);

    expect(recordedPhase("p1")).toBe("approved");
    expect(chatHistoryManager.replaceInProgress).toHaveBeenCalledTimes(1);
    expect(chatHistoryManager.updatePermissionCard).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ type: "permission_resolved", sessionId: "s1", requestId: "p1", phase: "approved", remembered: true }]);
  });

  // Rewriting a finished turn as in-progress would duplicate it (docs/236).
  it("patches only the database row once the turn is finished", () => {
    const { runner, deps, chatHistoryManager } = setup({ running: false, inProgressRows: false, ids: ["p1"] });

    settlePermissionCard(runner, "s1", deps, "p1", "denied");

    expect(chatHistoryManager.replaceInProgress).not.toHaveBeenCalled();
    expect(chatHistoryManager.updatePermissionCard).toHaveBeenCalledWith("s1", "p1", { phase: "denied" });
  });

  it("clears attention only when the session's last request settles", () => {
    const { runner, deps, attention } = setup({ running: false, inProgressRows: false, ids: ["p1", "p2"] });

    settlePermissionCard(runner, "s1", deps, "p1", "denied");
    expect(attention()).toEqual([]);

    settlePermissionCard(runner, "s1", deps, "p2", "approved");
    expect(attention()).toEqual([{ sessionId: "s1", awaitingPermission: false }]);
  });
});

describe("denyAbandonedPermissionCards", () => {
  it("denies every request still awaiting an answer, then clears attention once", () => {
    const { runner, deps, emitted, attention } = setup({ running: false, inProgressRows: false, ids: ["p1", "p2"] });

    denyAbandonedPermissionCards(runner, "s1", deps);

    expect(emitted.map((m) => m.type === "permission_resolved" && [m.requestId, m.phase])).toEqual([
      ["p1", "denied"],
      ["p2", "denied"],
    ]);
    expect(runner.awaitingPermissionIds.size).toBe(0);
    expect(attention()).toEqual([{ sessionId: "s1", awaitingPermission: false }]);
  });

  it("does nothing when no request is waiting", () => {
    const { runner, deps, emitted, attention } = setup({ running: false, inProgressRows: false, ids: [] });

    denyAbandonedPermissionCards(runner, "s1", deps);

    expect(emitted).toEqual([]);
    expect(attention()).toEqual([]);
  });
});
