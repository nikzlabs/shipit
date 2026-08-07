import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { wireAgentListeners, buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
import { AGENT_NOT_AUTHENTICATED_MESSAGE } from "./agent-auth-handler.js";
import type { ChatMessageGroup, RecordedChatCard } from "../session-runner.js";
import { routeVoiceNote } from "../voice/voice-note-router.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
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
      append: vi.fn(),
      finalizeInProgress: vi.fn(),
      updateLastMessage: vi.fn(() => null),
      indexOfMessageId: vi.fn(() => -1),
    } as any,
    usageManager: {
      record: vi.fn(),
      getSessionUsage: vi.fn(() => null),
      getSessionTokenTotals: vi.fn(() => null),
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

  // docs/150 req 13 — a turn blocked because no connected account can serve it
  // reaches the same `error` listener as a crashed process (env-prep throws,
  // `executeAgentTurn` re-emits). It must inherit the terminal-turn cleanup but
  // NOT the "Agent process error" framing: nothing crashed, and the message
  // already tells the user what to do.
  // docs/150 req 7 — a turn the provider killed for quota is the most reliable
  // exhaustion signal there is: the account itself refusing work, not telemetry
  // describing it. Stamping it is what makes the NEXT turn fail over.
  describe("hard-exhaustion detection on agent_result (docs/150 req 7)", () => {
    function wireForResult() {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      const d = deps();
      const marked: { sessionId: string; until: number }[] = [];
      d.markSessionAccountExhausted = (sessionId, until) => { marked.push({ sessionId, until }); };
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner, marked };
    }

    it("benches the session's account until the reset the provider named", () => {
      const { agent, runner, marked } = wireForResult();
      const resetAt = new Date(Date.now() + 3_600_000).toISOString();

      agent.emit("event", {
        type: "agent_result",
        error: `You've hit Codex's 5h usage limit. It resets at ${resetAt}.`,
      } as AgentEvent);

      expect(marked).toEqual([{ sessionId: "session-1", until: Date.parse(resetAt) }]);
      runner.dispose({ force: true });
    });

    it("leaves the account alone for an ordinary turn failure", () => {
      const { agent, runner, marked } = wireForResult();

      agent.emit("event", { type: "agent_result", error: "API Error: 500" } as AgentEvent);

      expect(marked).toEqual([]);
      runner.dispose({ force: true });
    });

    it("does not bench anything on a clean result", () => {
      const { agent, runner, marked } = wireForResult();

      agent.emit("event", { type: "agent_result" } as AgentEvent);

      expect(marked).toEqual([]);
      runner.dispose({ force: true });
    });

    // The shape production actually hit: the Claude CLI reported the limit as an
    // ordinary assistant message and ended the turn `subtype: "success"`, so the
    // adapter left `error` undefined and this stamp — gated on it — never ran.
    // The turn retired as a success and the notice became the commit subject.
    it("benches the account when the limit arrives as assistant text on a success turn", () => {
      const { agent, runner, marked } = wireForResult();
      const now = Date.now();

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text: "You've hit your session limit · resets 5:10pm (UTC)" }],
      } as AgentEvent);
      agent.emit("event", { type: "agent_result" } as AgentEvent);

      expect(marked).toHaveLength(1);
      expect(marked[0]!.sessionId).toBe("session-1");
      expect(marked[0]!.until).toBeGreaterThan(now);
      runner.dispose({ force: true });
    });

    // A turn the provider refused for quota is a failed turn even when the CLI
    // dressed it up as a successful one. Without the promotion, an exhaustion
    // with no account left to fail over to (the retry is bounded to one hop)
    // still retires as a success — the original incident, one account along.
    it("promotes a text-detected exhaustion to a failed turn", () => {
      const { agent, runner } = wireForResult();
      runner.running = true;

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text: "You've hit your session limit · resets 5:10pm (UTC)" }],
      } as AgentEvent);
      agent.emit("event", { type: "agent_result", status: "success" } as AgentEvent);

      expect(runner.lastTurnErrored).toBe(true);
      runner.dispose({ force: true });
    });

    it("leaves an ordinary success turn marked as a success", () => {
      const { agent, runner } = wireForResult();
      runner.running = true;

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text: "Done — all tests pass." }],
      } as AgentEvent);
      agent.emit("event", { type: "agent_result", status: "success" } as AgentEvent);

      expect(runner.lastTurnErrored).toBe(false);
      runner.dispose({ force: true });
    });

    it("leaves the account alone when a success turn's text is ordinary", () => {
      const { agent, runner, marked } = wireForResult();

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text: "Done — all tests pass." }],
      } as AgentEvent);
      agent.emit("event", { type: "agent_result" } as AgentEvent);

      expect(marked).toEqual([]);
      runner.dispose({ force: true });
    });
  });

  describe("blocked-turn errors (docs/150 req 13)", () => {
    function wireForError() {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      runner.running = true;
      const emitted: { type?: string; message?: string }[] = [];
      runner.on("message", (msg) => emitted.push(msg as { type?: string; message?: string }));
      const d = deps();
      d.chatHistoryManager.append = vi.fn() as never;
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner, emitted, d };
    }

    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    it("surfaces the routing message verbatim and persists it as the turn's error", async () => {
      const { agent, runner, emitted, d } = wireForError();
      const blocked = new ProviderRouteUnavailableError("claude", {
        reason: "all_exhausted",
        earliestResetAt: "2026-08-01T14:30:00.000Z",
      });

      agent.emit("error", blocked);
      await tick();

      const errorMsg = emitted.find((m) => m.type === "error");
      expect(errorMsg?.message).toBe(blocked.message);
      expect(errorMsg?.message).not.toContain("Agent process error");
      expect(d.chatHistoryManager.append).toHaveBeenCalledWith("session-1", {
        role: "assistant",
        text: blocked.message,
        isError: true,
      });
      // Terminal-turn cleanup still runs, so the runner is reclaimable and the
      // queue drains — a blocked turn must not wedge the session.
      expect(runner.running).toBe(false);
      expect(runner.lastTurnErrored).toBe(true);
      runner.dispose({ force: true });
    });

    it("still frames a genuine process crash as an agent process error", async () => {
      const { agent, runner, emitted, d } = wireForError();

      agent.emit("error", new Error("spawn ENOENT"));
      await tick();

      expect(emitted.find((m) => m.type === "error")?.message).toBe(
        "Agent process error: spawn ENOENT",
      );
      expect(d.chatHistoryManager.append).toHaveBeenCalledWith("session-1", {
        role: "assistant",
        text: "Error: spawn ENOENT",
        isError: true,
      });
      runner.dispose({ force: true });
    });
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
      const { agent, killSpy, runner, emitted } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth,
      });

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      expect(recoverAuth).toHaveBeenCalledTimes(1);
      // No sign-in card, no OAuth flow — the recovery re-dispatches silently.
      expect(emitted.find((m) => m.type === "auth_required")).toBeUndefined();
      // running is left set on the quiet path so the client doesn't flicker.
      expect(runner.running).toBe(true);
      runner.dispose({ force: true });
    });

    it("surfaces a re-auth error pointing to Settings (no OAuth popup) when the heal fails", async () => {
      const recoverAuth = vi.fn().mockResolvedValue(false);
      const { agent, killSpy, emitted } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth,
      });

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      expect(recoverAuth).toHaveBeenCalledTimes(1);
      // Heal failed → surface an actionable error directing the user to
      // Settings, NOT the auto-launched OAuth flow / global sign-in overlay.
      const err = emitted.find((m) => m.type === "error") as { message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.message).toContain("Settings");
      // restore mocked timers/spies via dispose handled by GC; runner local.
    });

    it("surfaces a re-auth error when no recovery hooks are wired", async () => {
      const { agent, killSpy, runner, emitted } = wireAuth({});

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      const err = emitted.find((m) => m.type === "error") as { message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.message).toContain("Settings");
      // No recovery → running cleared as before.
      expect(runner.running).toBe(false);
      runner.dispose({ force: true });
    });

    // The production incident: the sign-in notice was the user's ONLY signal
    // that the turn had died, and it was emit-only. No viewer was attached at
    // the failure instant and idle-cleanup disposed the runner five seconds
    // later — so the message reached nobody and left no trace. It must now be
    // in chat history, finalized, the moment it fires.
    it("PERSISTS the re-auth notice into chat history, finalized", async () => {
      const { agent, runner, d } = wireAuth({});

      agent.emit("auth_required");
      await tick();

      // On this path the teardown clears `running` before the notice fires, so
      // it lands as a directly-appended, already-final row. That is the whole
      // guarantee: it is in chat history, not parked in an in-progress set the
      // next turn's `replaceInProgress` would delete (docs/156).
      expect(d.chatHistoryManager.append).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          role: "assistant",
          text: `Error: ${AGENT_NOT_AUTHENTICATED_MESSAGE}`,
          isError: true,
        }),
      );
      // The turn's partial output is flushed and finalized alongside it — this
      // is the one turn ending that never reaches `onInterruptedTurn`.
      expect(d.chatHistoryManager.replaceInProgress).toHaveBeenCalledWith("session-1", expect.any(Array));
      expect(d.chatHistoryManager.finalizeInProgress).toHaveBeenCalledWith("session-1");
      runner.dispose({ force: true });
    });

    it("persists the notice on the failed-heal path too", async () => {
      const { agent, runner, d } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth: vi.fn().mockResolvedValue(false),
      });

      agent.emit("auth_required");
      await tick();

      expect(runner.recordedCards).toHaveLength(1);
      expect(d.chatHistoryManager.finalizeInProgress).toHaveBeenCalledWith("session-1");
      expect(runner.recordedCards[0]!.message).toEqual(
        expect.objectContaining({ isError: true, text: `Error: ${AGENT_NOT_AUTHENTICATED_MESSAGE}` }),
      );
      runner.dispose({ force: true });
    });

    it("records nothing extra on the quiet heal path (the turn is being retried)", async () => {
      const { agent, runner, d } = wireAuth({
        willRecoverAuth: () => true,
        recoverAuth: vi.fn().mockResolvedValue(true),
      });

      agent.emit("auth_required");
      await tick();

      expect(runner.recordedCards).toHaveLength(0);
      expect(d.chatHistoryManager.finalizeInProgress).not.toHaveBeenCalled();
      runner.dispose({ force: true });
    });
  });

  // docs/179 — the sibling of the auth notice: a rejected `--resume` that the
  // executor could not auto-recover leaves the user with a turn that produced
  // nothing, so its explanation has to be durable too.
  describe("unrecoverable stale resume", () => {
    it("persists the couldn't-resume error instead of only emitting it", async () => {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      runner.running = true; // the stderr line arrives mid-turn
      const emitted: { type?: string; message?: string }[] = [];
      runner.on("message", (m) => emitted.push(m as { type?: string; message?: string }));
      const d = deps();
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        recoverMissingConversation: () => false, // executor declined (budget spent)
      });

      agent.emit("log", "stderr", "No conversation found with session ID: abc-123");

      expect(emitted.find((m) => m.type === "error")?.message).toContain("Couldn't resume");
      expect(runner.recordedCards).toHaveLength(1);
      expect(runner.recordedCards[0]!.message).toEqual(
        expect.objectContaining({ isError: true, text: expect.stringContaining("Couldn't resume") }),
      );
      expect(d.chatHistoryManager.replaceInProgress).toHaveBeenCalled();
      runner.dispose({ force: true });
    });

    it("stays silent when the executor claims the recovery", () => {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      const emitted: { type?: string }[] = [];
      runner.on("message", (m) => emitted.push(m as { type?: string }));
      const d = deps();
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        recoverMissingConversation: () => true,
      });

      agent.emit("log", "stderr", "No conversation found with session ID: abc-123");

      expect(emitted.find((m) => m.type === "error")).toBeUndefined();
      expect(runner.recordedCards).toHaveLength(0);
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
    runner.running = true; // compaction fires mid-turn
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
            name: "mcp__shipit__voice_note",
            input: { summary: "Big finding — your call on the direction.", context: { repo: "acme/app" } },
          },
        ],
      } satisfies AgentEvent);

      expect(deliverVoiceNote).toHaveBeenCalledTimes(1);
      const [payload, , source] = deliverVoiceNote.mock.calls[0];
      expect(source).toBe("authored");
      expect(payload.summary).toBe("Big finding — your call on the direction.");
      expect(payload.context).toEqual({ repo: "acme/app" });
      runner.dispose({ force: true });
    });

    it("authored voice_note batched with AskUserQuestion: emits one card (authored) and suppresses the derived nudge", () => {
      // The reported bug's exact shape — a parallel tool call. The card must
      // ride the same fast event-stream channel as the dialog (not the slow
      // relay), and the authored headline must win over the derived one.
      const credentialStore = { getVoiceDeliveryMode: () => "native", getVoiceWebhook: () => null } as unknown as CredentialStore;
      const deliverVoiceNote = (payload: { summary: string }, r: SessionRunner, source: "authored" | "ask" | "plan") =>
        void routeVoiceNote(payload, { runner: r, sessionId: "session-1", credentialStore, source, chatHistoryManager: { replaceInProgress: () => {}, append: () => {} } });
      const { agent, runner } = wire({ deliverVoiceNote: deliverVoiceNote as unknown as AgentListenerDeps["deliverVoiceNote"] });

      const cards: { headline: string }[] = [];
      runner.on("message", (m) => { if (m.type === "voice_note") cards.push({ headline: m.headline }); });

      agent.emit("event", {
        type: "agent_assistant",
        content: [
          { type: "tool_use", id: "v1", name: "mcp__shipit__voice_note", input: { summary: "Authored headline." } },
          { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ header: "direction", question: "Which way?" }] } },
        ],
      } satisfies AgentEvent);

      expect(cards).toHaveLength(1);
      expect(cards[0].headline).toBe("Authored headline.");
      runner.dispose({ force: true });
    });

    it("persists the in-progress turn the instant the authored card is recorded (no reconnect-clobber window)", () => {
      // Regression (docs/163): the card was only written to chat history at the
      // NEXT tool-result / agent_result boundary. Between firing and that
      // boundary it lived only in the live client array + recordedCards — so a
      // mid-turn `loadSessionHistory` (any WS reconnect) replaced the transcript
      // with a DB snapshot lacking the card, and it vanished until a later
      // reload. The window widened when the agent kept replying (pure-text
      // replies hit no tool-result boundary). Fix: persist in-progress eagerly,
      // mirroring the live-steer handler, so the card is durable immediately.
      const credentialStore = { getVoiceDeliveryMode: () => "native", getVoiceWebhook: () => null } as unknown as CredentialStore;
      const replaceInProgress = vi.fn();
      const chatHistoryManager = {
        replaceInProgress,
        finalizeInProgress: vi.fn(),
        updateLastMessage: vi.fn(() => null),
        indexOfMessageId: vi.fn(() => -1),
      } as unknown as AgentListenerDeps["chatHistoryManager"];
      const deliverVoiceNote = (payload: { summary: string }, r: SessionRunner, source: "authored" | "ask" | "plan") =>
        void routeVoiceNote(payload, { runner: r, sessionId: "session-1", credentialStore, source, chatHistoryManager });
      const { agent, runner } = wire({
        deliverVoiceNote: deliverVoiceNote as unknown as AgentListenerDeps["deliverVoiceNote"],
        chatHistoryManager,
      });
      runner.running = true; // the agent authors the note mid-turn

      // ONLY the voice_note tool event — no tool_result, no trailing reply, so
      // the only thing that could persist the card is the eager persist.
      agent.emit("event", {
        type: "agent_assistant",
        content: [
          { type: "text", text: "Here's the summary." },
          { type: "tool_use", id: "v1", name: "mcp__shipit__voice_note", input: { summary: "Done — your call." } },
        ],
      } satisfies AgentEvent);

      expect(replaceInProgress).toHaveBeenCalled();
      const lastBatch = replaceInProgress.mock.calls[replaceInProgress.mock.calls.length - 1][1] as { voiceNote?: unknown }[];
      const persistedCard = lastBatch.find((m) => m.voiceNote);
      expect(persistedCard).toBeDefined();
      expect(runner.recordedCards).toHaveLength(1);
      runner.dispose({ force: true });
    });

    it("does not persist in-progress when no voice-note card is recorded this event", () => {
      // Guard against a needless replaceInProgress on every plain tool event —
      // the eager persist must be gated on a card actually being recorded.
      const replaceInProgress = vi.fn();
      const chatHistoryManager = {
        replaceInProgress,
        finalizeInProgress: vi.fn(),
        updateLastMessage: vi.fn(() => null),
        indexOfMessageId: vi.fn(() => -1),
      } as unknown as AgentListenerDeps["chatHistoryManager"];
      const { agent, runner } = wire({ deliverVoiceNote: vi.fn(), chatHistoryManager });

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x" } }],
      } satisfies AgentEvent);

      expect(replaceInProgress).not.toHaveBeenCalled();
      runner.dispose({ force: true });
    });

    it("suppresses the derived headline when an authored note already fired this turn", async () => {
      const deliverVoiceNote = vi.fn();
      const { agent, runner } = wire({ deliverVoiceNote });

      // Simulate the agent authoring a headline via the built-in tool first.
      const credentialStore = { getVoiceDeliveryMode: () => "native", getVoiceWebhook: () => null } as unknown as CredentialStore;
      await routeVoiceNote(
        { summary: "I have a question coming up." },
        { runner, sessionId: "session-1", credentialStore, source: "authored", chatHistoryManager: { replaceInProgress: () => {}, append: () => {} } },
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
        voiceNote: { id, headline: `note-${id}`, kind: "authored", createdAt: "2026-06-01T00:00:00.000Z" },
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
