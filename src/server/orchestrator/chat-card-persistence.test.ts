import { describe, it, expect } from "vitest";
import { emitChatCard, recordChatCard, updateRecordedCard, persistCardTransition, persistTurnInProgress, emitNoticeInTurn, emitNoticePostTurn } from "./chat-card-persistence.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { PersistedMessage } from "./chat-history.js";
import type { WsServerMessage } from "../shared/types.js";
import { createCommittedBodyIds } from "./transcript-projection.js";

function fakeRunner(groups: { text: string; toolUse: unknown[] }[] = []): {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
  persisted: { sessionId: string; messages: PersistedMessage[] }[];
  appended: { sessionId: string; message: PersistedMessage }[];
  chatHistoryManager: {
    replaceInProgress(sessionId: string, messages: PersistedMessage[]): void;
    append(sessionId: string, message: PersistedMessage): void;
    hasInProgress(sessionId: string): boolean;
    inProgressRows: boolean;
  };
} {
  const emitted: WsServerMessage[] = [];
  const persisted: { sessionId: string; messages: PersistedMessage[] }[] = [];
  const appended: { sessionId: string; message: PersistedMessage }[] = [];
  const chatHistoryManager = {
    replaceInProgress: (sessionId: string, messages: PersistedMessage[]) =>
      persisted.push({ sessionId, messages }),
    append: (sessionId: string, message: PersistedMessage) => appended.push({ sessionId, message }),
    inProgressRows: true,
    hasInProgress(): boolean { return this.inProgressRows; },
  };
  const turnEventBuffer: WsServerMessage[] = [];
  const runner = {
    emitMessage: (m: WsServerMessage) => { emitted.push(m); turnEventBuffer.push(m); },
    running: true,
    chatMessageGroups: groups,
    recordedCards: [],
    steeredMessages: [],
    getTurnEventBuffer: () => [...turnEventBuffer],
    lastPersistedBufferIndex: 0,
    committedBodyIds: createCommittedBodyIds(),
  } as unknown as SessionRunnerInterface;
  return { runner, emitted, persisted, appended, chatHistoryManager };
}

describe("chat-card-persistence", () => {
  it("emitChatCard emits the WS message, records it, AND persists the turn immediately", () => {
    const { runner, emitted, persisted, chatHistoryManager } = fakeRunner([{ text: "did a thing", toolUse: [] }]);

    emitChatCard(
      runner,
      { type: "voice_note", sessionId: "s1", id: "v1", headline: "hi", kind: "authored", createdAt: "t" },
      { role: "assistant", text: "", voiceNote: { id: "v1", headline: "hi", kind: "authored", createdAt: "t" } },
      { chatHistoryManager, sessionId: "s1" },
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "voice_note", id: "v1" });
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0].message).toMatchObject({ role: "assistant", voiceNote: { id: "v1" } });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].sessionId).toBe("s1");
    expect(persisted[0].messages.find((m) => (m as { voiceNote?: unknown }).voiceNote)).toMatchObject({
      voiceNote: { id: "v1" },
    });
  });

  it("advances lastPersistedBufferIndex past the buffer so a later switch/reconnect doesn't replay pre-card events onto the snapshot", () => {
    const { runner, emitted, chatHistoryManager } = fakeRunner([{ text: "I'll run a command", toolUse: [{}] }]);
    runner.emitMessage({ type: "agent_event" } as unknown as WsServerMessage);
    expect(runner.lastPersistedBufferIndex).toBe(0);

    emitChatCard(
      runner,
      { type: "permission_request_card", sessionId: "s1", requestId: "p1", toolName: "Bash" } as unknown as WsServerMessage,
      { role: "assistant", text: "", permissionPrompt: { requestId: "p1", phase: "pending", toolName: "Bash" } } as unknown as PersistedMessage,
      { chatHistoryManager, sessionId: "s1" },
    );

    expect(runner.getTurnEventBuffer()).toHaveLength(emitted.length);
    expect(runner.lastPersistedBufferIndex).toBe(runner.getTurnEventBuffer().length);
  });

  it("persistTurnInProgress records what it wrote as committed (docs/244, planning#299)", () => {
    const { runner, chatHistoryManager } = fakeRunner([
      {
        text: "writing",
        toolUse: [{ type: "tool_use", id: "w1", name: "Write", input: { content: "x" } }],
      },
    ]);
    (runner.chatMessageGroups[0] as { toolResults?: unknown[] }).toolResults = [
      { toolUseId: "w1", content: "ok" },
    ];
    runner.committedBodyIds.toolInputs.clear();

    persistTurnInProgress(chatHistoryManager, runner, "s1");

    expect(runner.committedBodyIds.toolInputs.has("w1")).toBe(true);
    expect(runner.committedBodyIds.toolResults.has("w1")).toBe(true);
  });

  describe("emitChatCard — a card that lands AFTER its turn finalized", () => {
    const card: PersistedMessage = {
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: "c1",
        spawnId: "ecb1fc11",
        subAgentId: "codex",
        status: "success",
        outputMarkdown: "## Findings\n- a real bug",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
    } as unknown as PersistedMessage;

    it("appends it as a finalized row instead of reviving the finished turn as in-progress", () => {
      const { runner, emitted, persisted, appended, chatHistoryManager } = fakeRunner([
        { text: "launching codex in the background", toolUse: [{}] },
      ]);
      runner.running = false;

      emitChatCard(
        runner,
        { type: "sub_agent_consult_card", sessionId: "s1" } as unknown as WsServerMessage,
        card,
        { chatHistoryManager, sessionId: "s1" },
      );

      expect(emitted).toHaveLength(1);
      expect(appended).toEqual([{ sessionId: "s1", message: card }]);
      expect(persisted).toHaveLength(0);
      expect(runner.recordedCards).toHaveLength(0);
    });

    it("still takes the in-progress path while a turn IS running", () => {
      const { runner, persisted, appended, chatHistoryManager } = fakeRunner([{ text: "x", toolUse: [{}] }]);
      runner.running = true;

      emitChatCard(
        runner,
        { type: "sub_agent_consult_card", sessionId: "s1" } as unknown as WsServerMessage,
        card,
        { chatHistoryManager, sessionId: "s1" },
      );

      expect(appended).toHaveLength(0);
      expect(persisted).toHaveLength(1);
      expect(runner.recordedCards).toHaveLength(1);
    });
  });

  it("anchors the card after the persistable assistant groups produced so far", () => {
    const { runner } = fakeRunner([
      { text: "one", toolUse: [] },
      { text: "", toolUse: [] },
      { text: "two", toolUse: [] },
    ]);

    recordChatCard(runner, { role: "assistant", text: "", voiceNote: { id: "v1", headline: "h", kind: "authored", createdAt: "t" } });

    expect(runner.recordedCards[0].afterGroupIndex).toBe(2);
  });

  describe("updateRecordedCard — mid-turn lifecycle transition (docs/193 permission clobber)", () => {
    interface PermMsg { permissionPrompt?: { requestId?: string; phase?: string; remembered?: boolean } }
    const findCard = (messages: PersistedMessage[], requestId: string) =>
      messages.find((m) => (m as PermMsg).permissionPrompt?.requestId === requestId) as PermMsg | undefined;

    it("patches a recorded card in place so a LATER in-turn rebuild keeps the terminal state", () => {
      const { runner, persisted, chatHistoryManager } = fakeRunner([{ text: "I'll edit .npmrc", toolUse: [{}] }]);

      recordChatCard(runner, {
        role: "assistant",
        text: "",
        permissionPrompt: { requestId: "p1", phase: "pending", toolName: "Write", path: ".npmrc" },
      } as unknown as PersistedMessage);
      persistTurnInProgress(chatHistoryManager, runner, "s1");
      expect(findCard(persisted[persisted.length - 1].messages, "p1")?.permissionPrompt?.phase).toBe("pending");

      const patched = updateRecordedCard(
        runner,
        (m) => (m as PermMsg).permissionPrompt?.requestId === "p1",
        (m) => ({
          ...m,
          permissionPrompt: { ...(m as Required<PermMsg>).permissionPrompt, phase: "approved", remembered: true },
        }) as unknown as PersistedMessage,
      );
      expect(patched).toBe(true);
      persistTurnInProgress(chatHistoryManager, runner, "s1");

      persistTurnInProgress(chatHistoryManager, runner, "s1");
      const finalCard = findCard(persisted[persisted.length - 1].messages, "p1");
      expect(finalCard?.permissionPrompt?.phase).toBe("approved");
      expect(finalCard?.permissionPrompt?.remembered).toBe(true);
    });

    it("returns false when no recorded card matches (caller falls back to the DB-row patch)", () => {
      const { runner } = fakeRunner();
      expect(updateRecordedCard(runner, () => true, (m) => m)).toBe(false);
    });
  });

  describe("persistCardTransition — running-gated recorded-vs-DB patch (docs/164/172/177)", () => {
    interface BugMsg { bugReport?: { cardId?: string; phase?: string } }
    const recordDraft = (
      runner: SessionRunnerInterface,
      chatHistoryManager: { replaceInProgress(s: string, m: PersistedMessage[]): void },
    ) => {
      recordChatCard(runner, { role: "assistant", text: "", bugReport: { cardId: "c1", phase: "draft" } } as unknown as PersistedMessage);
      persistTurnInProgress(chatHistoryManager, runner, "s1");
    };
    const findCard = (messages: PersistedMessage[]) =>
      messages.find((m) => (m as BugMsg).bugReport?.cardId === "c1") as BugMsg | undefined;
    const toFiled = (m: PersistedMessage) =>
      ({ ...m, bugReport: { ...(m as Required<BugMsg>).bugReport, phase: "filed" } }) as unknown as PersistedMessage;

    it("patches the recorded card (not the DB) while the turn is in flight, surviving a later rebuild", () => {
      const { runner, persisted, chatHistoryManager } = fakeRunner([{ text: "filing a bug", toolUse: [{}] }]);
      runner.running = true;
      recordDraft(runner, chatHistoryManager);

      let dbPatched = false;
      persistCardTransition(
        runner,
        { chatHistoryManager, sessionId: "s1" },
        (m) => (m as BugMsg).bugReport?.cardId === "c1",
        toFiled,
        () => { dbPatched = true; },
      );

      expect(dbPatched).toBe(false);
      persistTurnInProgress(chatHistoryManager, runner, "s1");
      expect(findCard(persisted[persisted.length - 1].messages)?.bugReport?.phase).toBe("filed");
    });

    it("uses the DB-row fallback when `running` is true but no turn owns the in-progress rows", () => {
      const { runner, chatHistoryManager } = fakeRunner([{ text: "a finished turn", toolUse: [{}] }]);
      runner.running = true;
      recordDraft(runner, chatHistoryManager);
      chatHistoryManager.inProgressRows = false;

      let dbPatched = false;
      persistCardTransition(
        runner,
        { chatHistoryManager, sessionId: "s1" },
        (m) => (m as BugMsg).bugReport?.cardId === "c1",
        toFiled,
        () => { dbPatched = true; },
      );

      expect(dbPatched).toBe(true);
      expect(findCard([runner.recordedCards[0].message])?.bugReport?.phase).toBe("draft");
    });

    it("uses the DB-row fallback once the proposing turn has finalized (running=false)", () => {
      const { runner, chatHistoryManager } = fakeRunner([{ text: "filing a bug", toolUse: [{}] }]);
      runner.running = false;
      recordDraft(runner, chatHistoryManager);

      let dbPatched = false;
      persistCardTransition(
        runner,
        { chatHistoryManager, sessionId: "s1" },
        (m) => (m as BugMsg).bugReport?.cardId === "c1",
        toFiled,
        () => { dbPatched = true; },
      );

      expect(dbPatched).toBe(true);
      expect((runner.recordedCards[0].message as BugMsg).bugReport?.phase).toBe("draft");
    });

    it("falls back to the DB patch when the card isn't in this turn's recorded set", () => {
      const { runner, chatHistoryManager } = fakeRunner();
      runner.running = true;
      let dbPatched = false;
      persistCardTransition(
        runner,
        { chatHistoryManager, sessionId: "s1" },
        (m) => (m as BugMsg).bugReport?.cardId === "c1",
        (m) => m,
        () => { dbPatched = true; },
      );
      expect(dbPatched).toBe(true);
    });
  });

  it("emitNoticeInTurn emits + records a notice with a shared id (docs/138)", () => {
    const { runner, emitted, persisted, chatHistoryManager } = fakeRunner([{ text: "x", toolUse: [] }]);
    emitNoticeInTurn(runner, "s1", "Guarded mode unavailable.", chatHistoryManager, "warn");
    expect(persisted).toHaveLength(1);

    expect(emitted).toHaveLength(1);
    const ws = emitted[0] as { type: string; id?: string; message?: string; level?: string };
    expect(ws).toMatchObject({ type: "system_notice", message: "Guarded mode unavailable.", level: "warn" });
    expect(ws.id).toMatch(/^notice-/);
    expect(runner.recordedCards).toHaveLength(1);
    const recorded = runner.recordedCards[0].message;
    expect(recorded).toMatchObject({ role: "assistant", notice: true, noticeLevel: "warn", noticeId: ws.id });
  });

  it("emitNoticePostTurn emits AND appends to history with a shared id", () => {
    const { runner, emitted } = fakeRunner();
    const appended: { sessionId: string; message: PersistedMessage }[] = [];
    const chatHistory = { append: (sessionId: string, message: PersistedMessage) => appended.push({ sessionId, message }) };

    emitNoticePostTurn((m) => runner.emitMessage(m), chatHistory, "s1", "Unresolved merge conflict.", "warn");

    expect(emitted).toHaveLength(1);
    const ws = emitted[0] as { type: string; id?: string };
    expect(ws).toMatchObject({ type: "system_notice", id: expect.stringMatching(/^notice-/) });
    expect(runner.recordedCards).toHaveLength(0);
    expect(appended).toHaveLength(1);
    expect(appended[0].message).toMatchObject({ notice: true, noticeLevel: "warn", noticeId: ws.id, text: "Unresolved merge conflict." });
  });
});
