import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { wireAgentListeners, buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
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
