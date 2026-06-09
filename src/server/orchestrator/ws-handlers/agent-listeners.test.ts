import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { wireAgentListeners, buildTurnMessages, extractToolResults, stampToolDurations, type AgentListenerDeps } from "./agent-listeners.js";
import type { ChatMessageGroup, RecordedChatCard } from "../session-runner.js";
import { routeVoiceNote } from "../voice/voice-note-router.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentCapabilities, AgentEvent, AgentMcpWriteContext, AgentMcpWriteResult, AgentProcess } from "../../shared/types.js";

const capabilities: AgentCapabilities = {
  supportsResume: true,
  supportsImages: false,
  supportsSystemPrompt: true,
  supportsPermissionModes: false,
  supportedPermissionModes: [],
  toolNames: [],
  models: ["gpt-test"],
  supportsReview: false,
  supportsSteering: true,
  supportsCompaction: true,
  skillsDirName: ".codex",
  skillInvocationPrefix: "$",
};

class FakeAgent extends EventEmitter {
  readonly agentId = "codex" as const;
  readonly capabilities = capabilities;
  readonly isStreaming = true;

  run(): void {}
  writeStdin(): void {}
  sendUserMessage(): void {}
  interrupt(): void {}
  kill(): void {}
  writeMcpConfig(_ctx: AgentMcpWriteContext): AgentMcpWriteResult { return {}; }
}

function deps(): AgentListenerDeps {
  return {
    sessionManager: {
      setAgentSessionId: vi.fn(),
      setLastTurnErrored: vi.fn(),
      setModel: vi.fn(),
      get: vi.fn(() => null),
      track: vi.fn(),
      list: vi.fn(() => []),
    } as any,
    chatHistoryManager: {
      replaceInProgress: vi.fn(),
      finalizeInProgress: vi.fn(),
      updateLastMessage: vi.fn(() => null),
      indexOfMessageId: vi.fn(() => -1),
    } as any,
    usageManager: {
      record: vi.fn(),
      getSessionUsage: vi.fn(() => null),
      getSessionTokenTotals: vi.fn(() => null),
    } as any,
    authManager: {
      startOAuthFlow: vi.fn(),
    } as any,
    sseBroadcast: vi.fn(),
    broadcastLog: vi.fn(),
    getSelectedModel: vi.fn(() => "gpt-test"),
  };
}

describe("wireAgentListeners", () => {
  it("keeps Codex stream-completion events internal so live text is not duplicated", () => {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-1",
      sessionDir: "/tmp/session-1",
      defaultAgentId: "codex",
    });
    const emitted: unknown[] = [];
    runner.on("message", (msg) => emitted.push(msg));

    wireAgentListeners(agent as unknown as AgentProcess, runner, deps(), {
      capturedSessionId: "session-1",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Hello" }],
    } satisfies AgentEvent);
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "Hello world" }],
      isStreamCompletion: true,
    } satisfies AgentEvent);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "agent_event",
      event: {
        type: "agent_assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
    expect(runner.turnSummary).toBe("Hello world");
    expect(runner.accumulatedText).toBe("Hello");
    expect(runner.getTurnEventBuffer()).toHaveLength(1);

    runner.dispose({ force: true });
  });

  describe("auth_required auto-recovery (docs/179)", () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    function wireAuth(extra: {
      willRecoverAuth?: () => boolean;
      recoverAuth?: () => Promise<boolean>;
    }) {
      const agent = new FakeAgent();
      const killSpy = vi.spyOn(agent, "kill");
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      runner.running = true;
      const emitted: { type?: string }[] = [];
      runner.on("message", (msg) => emitted.push(msg as { type?: string }));
      const d = deps();
      d.sessionManager.get = vi.fn(() => ({ agentId: "codex" })) as never;
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        ...extra,
      });
      return { agent, killSpy, runner, emitted, d };
    }

    it("stays quiet (no card, no OAuth) when recovery heals the token", async () => {
      const recoverAuth = vi.fn().mockResolvedValue(true);
      const { agent, killSpy, runner, emitted, d } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth,
      });

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      expect(recoverAuth).toHaveBeenCalledTimes(1);
      // No sign-in card, no OAuth flow — the recovery re-dispatches silently.
      expect(emitted.find((m) => m.type === "auth_required")).toBeUndefined();
      expect(d.authManager.startOAuthFlow).not.toHaveBeenCalled();
      // running is left set on the quiet path so the client doesn't flicker.
      expect(runner.running).toBe(true);
      runner.dispose({ force: true });
    });

    it("falls back to the visible re-auth flow when the heal fails", async () => {
      const recoverAuth = vi.fn().mockResolvedValue(false);
      const { agent, killSpy, emitted, d } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth,
      });

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      expect(recoverAuth).toHaveBeenCalledTimes(1);
      // Heal failed → surface the sign-in card + start OAuth.
      expect(emitted.find((m) => m.type === "auth_required")).toBeDefined();
      expect(d.authManager.startOAuthFlow).toHaveBeenCalled();
      // restore mocked timers/spies via dispose handled by GC; runner local.
    });

    it("uses the legacy visible flow when no recovery hooks are wired", async () => {
      const { agent, killSpy, runner, emitted, d } = wireAuth({});

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      expect(emitted.find((m) => m.type === "auth_required")).toBeDefined();
      expect(d.authManager.startOAuthFlow).toHaveBeenCalled();
      // No recovery → running cleared as before.
      expect(runner.running).toBe(false);
      runner.dispose({ force: true });
    });
  });

  it("emits a transient indicator on compaction start and persists a card on completion (docs/178)", () => {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-1",
      sessionDir: "/tmp/session-1",
      defaultAgentId: "codex",
    });
    const emitted: any[] = [];
    runner.on("message", (m) => emitted.push(m));

    wireAgentListeners(agent as unknown as AgentProcess, runner, deps(), {
      capturedSessionId: "session-1",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });

    // Start → emit-only transient indicator, NOT recorded for persistence.
    agent.emit("event", { type: "agent_compaction_started", trigger: "manual" } satisfies AgentEvent);
    expect(emitted).toEqual([
      { type: "compaction_status", sessionId: "session-1", active: true, trigger: "manual" },
    ]);
    expect(runner.recordedCards).toHaveLength(0);

    // Completion → clear the indicator AND persist a transcript card.
    agent.emit("event", {
      type: "agent_compacted",
      trigger: "manual",
      preTokens: 100,
      postTokens: 20,
    } satisfies AgentEvent);

    expect(emitted.some((m) => m.type === "compaction_status" && m.active === false)).toBe(true);
    const cardMsg = emitted.find((m) => m.type === "compaction_card");
    expect(cardMsg).toBeDefined();
    expect(cardMsg.card).toMatchObject({ trigger: "manual", preTokens: 100, postTokens: 20 });
    expect(typeof cardMsg.card.id).toBe("string");

    // Recorded in-band so buildTurnMessages folds it into the persisted turn.
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0].message.compaction).toMatchObject({
      trigger: "manual",
      preTokens: 100,
      postTokens: 20,
    });

    runner.dispose({ force: true });
  });

  describe("voice-note source observation (docs/163)", () => {
    function wire(extra: Partial<AgentListenerDeps>) {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      wireAgentListeners(agent as unknown as AgentProcess, runner, { ...deps(), ...extra }, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner };
    }

    it("derives an 'ask' headline from a top-level AskUserQuestion", () => {
      const deliverVoiceNote = vi.fn();
      const { agent, runner } = wire({ deliverVoiceNote });
      agent.emit("event", {
        type: "agent_assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "AskUserQuestion",
            input: { questions: [{ header: "delivery", question: "How should delivery work?" }] },
          },
        ],
      } satisfies AgentEvent);

      expect(deliverVoiceNote).toHaveBeenCalledTimes(1);
      const [payload, , source] = deliverVoiceNote.mock.calls[0];
      expect(source).toBe("ask");
      expect(payload.needsAttention).toBe(true);
      expect(payload.summary).toContain("delivery");
      runner.dispose({ force: true });
    });

    it("derives a 'plan' headline from a top-level ExitPlanMode", () => {
      const deliverVoiceNote = vi.fn();
      const { agent, runner } = wire({ deliverVoiceNote });
      agent.emit("event", {
        type: "agent_assistant",
        content: [
          { type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "# Add voice notes\nStep one..." } },
        ],
      } satisfies AgentEvent);

      expect(deliverVoiceNote).toHaveBeenCalledTimes(1);
      const [payload, , source] = deliverVoiceNote.mock.calls[0];
      expect(source).toBe("plan");
      expect(payload.summary).toContain("Add voice notes");
      runner.dispose({ force: true });
    });

    it("delivers the authored card the instant the voice_note tool call is observed", () => {
      const deliverVoiceNote = vi.fn();
      const { agent, runner } = wire({ deliverVoiceNote });
      agent.emit("event", {
        type: "agent_assistant",
        content: [
          {
            type: "tool_use",
            id: "v1",
            name: "mcp__shipit-voice__voice_note",
            input: { summary: "Big finding — your call on the direction.", needsAttention: true, context: { repo: "acme/app" } },
          },
        ],
      } satisfies AgentEvent);

      expect(deliverVoiceNote).toHaveBeenCalledTimes(1);
      const [payload, , source] = deliverVoiceNote.mock.calls[0];
      expect(source).toBe("authored");
      expect(payload.summary).toBe("Big finding — your call on the direction.");
      expect(payload.needsAttention).toBe(true);
      expect(payload.context).toEqual({ repo: "acme/app" });
      runner.dispose({ force: true });
    });

    it("authored voice_note batched with AskUserQuestion: emits one card (authored) and suppresses the derived nudge", () => {
      // The reported bug's exact shape — a parallel tool call. The card must
      // ride the same fast event-stream channel as the dialog (not the slow
      // relay), and the authored headline must win over the derived one.
      const credentialStore = { getVoiceDeliveryMode: () => "native", getVoiceWebhook: () => null } as unknown as CredentialStore;
      const deliverVoiceNote = (payload: { summary: string; needsAttention: boolean }, r: SessionRunner, source: "authored" | "ask" | "plan") =>
        void routeVoiceNote(payload, { runner: r, sessionId: "session-1", credentialStore, source });
      const { agent, runner } = wire({ deliverVoiceNote: deliverVoiceNote as unknown as AgentListenerDeps["deliverVoiceNote"] });

      const cards: { headline: string }[] = [];
      runner.on("message", (m) => { if (m.type === "voice_note") cards.push({ headline: m.headline }); });

      agent.emit("event", {
        type: "agent_assistant",
        content: [
          { type: "tool_use", id: "v1", name: "mcp__shipit-voice__voice_note", input: { summary: "Authored headline.", needsAttention: true } },
          { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ header: "direction", question: "Which way?" }] } },
        ],
      } satisfies AgentEvent);

      expect(cards).toHaveLength(1);
      expect(cards[0].headline).toBe("Authored headline.");
      runner.dispose({ force: true });
    });

    it("suppresses the derived headline when an authored note already fired this turn", async () => {
      const deliverVoiceNote = vi.fn();
      const { agent, runner } = wire({ deliverVoiceNote });

      // Simulate the agent authoring a headline via the built-in tool first.
      const credentialStore = { getVoiceDeliveryMode: () => "native", getVoiceWebhook: () => null } as unknown as CredentialStore;
      await routeVoiceNote(
        { summary: "I have a question coming up.", needsAttention: true },
        { runner, sessionId: "session-1", credentialStore, source: "authored" },
      );

      agent.emit("event", {
        type: "agent_assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "AskUserQuestion",
            input: { questions: [{ header: "delivery", question: "How?" }] },
          },
        ],
      } satisfies AgentEvent);

      expect(deliverVoiceNote).not.toHaveBeenCalled();
      runner.dispose({ force: true });
    });
  });

  describe("buildTurnMessages chat-card interleaving (docs/163, docs/164)", () => {
    const group = (text: string): ChatMessageGroup => ({ text, toolUse: [] });
    const voiceCard = (id: string, afterGroupIndex: number): RecordedChatCard => ({
      afterGroupIndex,
      message: {
        role: "assistant",
        text: "",
        voiceNote: { id, headline: `note-${id}`, needsAttention: true, kind: "authored", createdAt: "2026-06-01T00:00:00.000Z" },
      },
    });
    const bugCard = (id: string, afterGroupIndex: number): RecordedChatCard => ({
      afterGroupIndex,
      message: {
        role: "assistant",
        text: "",
        bugReport: { cardId: id, phase: "draft", title: `bug-${id}`, body: "redacted body", stage2Ran: false, producer: "session" },
      },
    });

    it("places an end-of-turn card AFTER the assistant content, not above the turn", () => {
      // Anchored at 2 == the two persistable groups produced so far, so the card
      // lands last — exactly where the tool was issued. This is the regression:
      // an out-of-band append kept an early id and floated the card to the top.
      const out = buildTurnMessages(
        [group("doing work"), group("almost done")],
        [],
        [voiceCard("v1", 2)],
        { inProgress: false },
      );
      expect(out.map((m) => m.text || (m.voiceNote ? `card:${m.voiceNote.id}` : ""))).toEqual([
        "doing work",
        "almost done",
        "card:v1",
      ]);
      // The card carries the in-band voiceNote payload, finalized (no inProgress).
      expect(out[2]).toMatchObject({ role: "assistant", text: "", voiceNote: { id: "v1" } });
      expect(out[2].inProgress).toBeUndefined();
    });

    it("interleaves a mid-turn card between the groups it sits between", () => {
      const out = buildTurnMessages(
        [group("first"), group("second")],
        [],
        [voiceCard("mid", 1)],
        { inProgress: true },
      );
      expect(out.map((m) => m.text || (m.voiceNote ? `card:${m.voiceNote.id}` : ""))).toEqual([
        "first",
        "card:mid",
        "second",
      ]);
      // In-progress rebuild flags every row so the next replaceInProgress cycle
      // deletes and reinserts them together — the card included.
      expect(out.every((m) => m.inProgress)).toBe(true);
    });

    it("interleaves bug-report and voice cards generically via recordedCards", () => {
      const out = buildTurnMessages(
        [group("looking into it"), group("here is a card")],
        [],
        [bugCard("b1", 2), voiceCard("v1", 2)],
        { inProgress: false },
      );
      expect(out.map((m) => m.text || (m.bugReport ? `bug:${m.bugReport.cardId}` : m.voiceNote ? `voice:${m.voiceNote.id}` : ""))).toEqual([
        "looking into it",
        "here is a card",
        "bug:b1",
        "voice:v1",
      ]);
      expect(out[2]).toMatchObject({ role: "assistant", text: "", bugReport: { cardId: "b1", phase: "draft" } });
      expect(out[2].inProgress).toBeUndefined();
    });
  });
});

describe("per-tool timing derivation (docs/185)", () => {
  const toolResultEvent = (
    blocks: { tool_use_id: string; content?: string; is_error?: boolean; duration_ms?: number }[],
  ): AgentEvent =>
    ({
      type: "agent_tool_result",
      content: blocks.map((b) => ({ type: "tool_result", ...b })),
    }) as unknown as AgentEvent;

  describe("stampToolDurations", () => {
    it("stamps duration_ms = now - start for results with a recorded start", () => {
      const starts = new Map<string, number>([["t1", 1000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1", content: "ok" }]), starts, 1450);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(450);
    });

    it("leaves results without a recorded start untouched (returns same reference)", () => {
      const starts = new Map<string, number>();
      const event = toolResultEvent([{ tool_use_id: "unknown", content: "ok" }]);
      const out = stampToolDurations(event, starts, 1450);
      expect(out).toBe(event);
    });

    it("does not overwrite a duration that is already present", () => {
      const starts = new Map<string, number>([["t1", 1000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1", duration_ms: 7 }]), starts, 9999);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(7);
    });

    it("clamps a negative delta (clock skew) to zero", () => {
      const starts = new Map<string, number>([["t1", 2000]]);
      const out = stampToolDurations(toolResultEvent([{ tool_use_id: "t1" }]), starts, 1000);
      const block = (out as unknown as { content: Record<string, unknown>[] }).content[0];
      expect(block.duration_ms).toBe(0);
    });

    it("is a no-op for non-tool-result events", () => {
      const event = { type: "agent_assistant", content: [{ type: "text", text: "hi" }] } as unknown as AgentEvent;
      expect(stampToolDurations(event, new Map(), 1)).toBe(event);
    });
  });

  describe("extractToolResults", () => {
    it("carries a stamped duration_ms into the entry's durationMs", () => {
      const event = toolResultEvent([{ tool_use_id: "t1", content: "ok", duration_ms: 320 }]);
      expect(extractToolResults(event)[0]).toMatchObject({ toolUseId: "t1", content: "ok", durationMs: 320 });
    });

    it("omits durationMs when no duration was stamped", () => {
      const entry = extractToolResults(toolResultEvent([{ tool_use_id: "t1", content: "ok" }]))[0];
      expect(entry.durationMs).toBeUndefined();
    });
  });
});
