import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";
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
      setMuted: vi.fn(),
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
  it("attributes quota telemetry to the credential route captured for the turn", () => {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-1",
      sessionDir: "/tmp/session-1",
      defaultAgentId: "codex",
    });
    const d = deps();
    const session = { providerRouteId: "acct-old" };
    d.sessionManager.get = vi.fn(() => session) as never;
    d.recordAgentRateLimits = vi.fn();

    wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
      capturedSessionId: "session-1",
      getCapturedRouteId: () => "acct-old",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });

    session.providerRouteId = "acct-new";
    const event = {
      type: "agent_rate_limits",
      session: { usedPct: 100, resetAt: "2026-08-10T13:00:00Z" },
      weekly: { usedPct: 52, resetAt: "2026-08-15T00:00:00Z" },
    } satisfies AgentEvent;
    agent.emit("event", event);

    expect(d.recordAgentRateLimits).toHaveBeenCalledWith(
      "codex",
      event.session,
      event.weekly,
      "session-1",
      "acct-old",
    );
    runner.dispose({ force: true });
  });

  it("records the turn's credential route even when the result carries no usage telemetry (docs/260-turn-level-account-routing req 10)", () => {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-1",
      sessionDir: "/tmp/session-1",
      defaultAgentId: "codex",
    });
    const d = deps();

    wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
      capturedSessionId: "session-1",
      getCapturedRouteId: () => "acct-a",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });

    agent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "session-1",
    } satisfies AgentEvent);

    expect(d.usageManager.record).toHaveBeenCalledWith(
      "session-1", 0, 0, undefined, undefined,
      expect.objectContaining({ credentialRouteId: "acct-a" }),
    );
    runner.dispose({ force: true });
  });

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

  describe("marking a supplied secret auth_failed on the surface path (planning#358)", () => {
    function wireForAuthFailure(routeKind: "reserved" | "account") {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "claude",
      });
      const d = deps();
      d.sessionManager.get = vi.fn(() => ({ agentId: "claude" })) as never;
      const marked: string[] = [];
      d.markCredentialRouteAuthFailed = (id) => { marked.push(id); };
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        getCapturedRouteId: () => "cred_a",
        getCapturedRouteKind: () => routeKind,
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner, marked };
    }

    it("marks a metered key route, which `recoverAuth` can never reach", () => {
      const { agent, runner, marked } = wireForAuthFailure("reserved");
      agent.emit("auth_required");
      expect(marked).toEqual(["cred_a"]);
      runner.dispose({ force: true });
    });

    it("leaves an account route to its own sign-in flow", () => {
      const { agent, runner, marked } = wireForAuthFailure("account");
      agent.emit("auth_required");
      expect(marked).toEqual([]);
      runner.dispose({ force: true });
    });
  });

  describe("clearing a credential's auth_failed on a real result (planning#358)", () => {
    function wireForResult(routeId: string | undefined) {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      const d = deps();
      d.sessionManager.get = vi.fn(() => ({})) as never;
      const cleared: string[] = [];
      d.clearCredentialRouteAuthFailed = (id) => { cleared.push(id); };
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        ...(routeId ? { getCapturedRouteId: () => routeId } : {}),
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner, cleared };
    }

    it("clears the route the turn authenticated with — proof by use", () => {
      const { agent, runner, cleared } = wireForResult("cred_a");
      agent.emit("event", { type: "agent_result" } as AgentEvent);
      expect(cleared).toEqual(["cred_a"]);
      runner.dispose({ force: true });
    });

    it("clears even when the result carries an error", () => {
      const { agent, runner, cleared } = wireForResult("cred_a");
      agent.emit("event", { type: "agent_result", error: "API Error: 500" } as AgentEvent);
      expect(cleared).toEqual(["cred_a"]);
      runner.dispose({ force: true });
    });

    it("does not clear when the same turn already failed authentication", () => {
      const { agent, runner, cleared } = wireForResult("cred_a");
      agent.emit("auth_required");
      agent.emit("event", { type: "agent_result", error: "401" } as AgentEvent);
      expect(cleared).toEqual([]);
      runner.dispose({ force: true });
    });

    it("clears nothing when the turn captured no route", () => {
      const { agent, runner, cleared } = wireForResult(undefined);
      agent.emit("event", { type: "agent_result" } as AgentEvent);
      expect(cleared).toEqual([]);
      runner.dispose({ force: true });
    });
  });

  describe("hard-exhaustion detection on agent_result (docs/150-multiple-provider-subscriptions req 7)", () => {
    function wireForResult() {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      const d = deps();
      const session = { providerRouteId: "acct-old" };
      d.sessionManager.get = vi.fn(() => session) as never;
      const marked: { sessionId: string; until: number; routeId?: string }[] = [];
      d.markSessionAccountExhausted = (sessionId, until, routeId) => {
        marked.push({ sessionId, until, routeId });
      };
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        getCapturedRouteId: () => "acct-old",
        isNewSession: false,
        persistUserMessage: vi.fn(),
      });
      return { agent, runner, marked, session };
    }

    it("benches the session's account until the reset the provider named", () => {
      const { agent, runner, marked, session } = wireForResult();
      const resetAt = new Date(Date.now() + 3_600_000).toISOString();

      session.providerRouteId = "acct-new";

      agent.emit("event", {
        type: "agent_result",
        error: `You've hit Codex's 5h usage limit. It resets at ${resetAt}.`,
      } as AgentEvent);

      expect(marked).toEqual([{
        sessionId: "session-1",
        until: Date.parse(resetAt),
        routeId: "acct-old",
      }]);
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

  describe("errored result with no streamed content persists an error row (planning#438)", () => {
    const startupDeath = {
      type: "agent_result",
      status: "error",
      sessionId: "cli-session",
      error: "Grok exited with code 1 before producing a result",
    } as AgentEvent;
    const errorRow = {
      role: "assistant",
      text: "Error: Grok exited with code 1 before producing a result",
      isError: true,
    };

    function wire(
      d = deps(),
      extraOpts: Partial<Parameters<typeof wireAgentListeners>[3]> = {},
    ) {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      runner.running = true;
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        ...extraOpts,
      });
      return { agent, runner, d };
    }

    it("records a persisted, finalized error row for a CLI startup death", () => {
      const { agent, runner, d } = wire();

      agent.emit("event", startupDeath);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const finalRows = calls[calls.length - 1][1] as unknown[];
      expect(finalRows).toContainEqual(expect.objectContaining(errorRow));
      expect(d.chatHistoryManager.finalizeInProgress).toHaveBeenCalledWith("session-1");
      runner.dispose({ force: true });
    });

    it("the error row survives a reload — real history round-trip", () => {
      const d = deps();
      d.chatHistoryManager = new ChatHistoryManager(new DatabaseManager(":memory:")) as never;
      const { agent, runner } = wire(d);

      agent.emit("event", startupDeath);

      const loaded = (d.chatHistoryManager as unknown as ChatHistoryManager).load("session-1");
      const row = loaded.find((m) => m.isError);
      expect(row).toMatchObject(errorRow);
      expect(row?.inProgress).toBeUndefined();
      runner.dispose({ force: true });
    });

    it("adds no row when the turn streamed visible content", () => {
      const { agent, runner, d } = wire();

      agent.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text: "Partial progress before the crash." }],
      } as AgentEvent);
      agent.emit("event", {
        type: "agent_result",
        status: "error",
        sessionId: "cli-session",
        error: "API Error: 500",
      } as AgentEvent);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const finalRows = calls[calls.length - 1][1] as { isError?: boolean }[];
      expect(finalRows.some((m) => m.isError)).toBe(false);
      expect(d.chatHistoryManager.append).not.toHaveBeenCalled();
      runner.dispose({ force: true });
    });

    it("adds no row when the same turn already failed authentication", () => {
      const { agent, runner, d } = wire();

      agent.emit("auth_required");
      agent.emit("event", startupDeath);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const rows = calls.flatMap((c) => c[1] as { isError?: boolean; text?: string }[]);
      expect(rows.filter((m) => m.isError && m.text === errorRow.text)).toHaveLength(0);
      runner.dispose({ force: true });
    });

    it("adds no row for a quota refusal — the failover owns that turn's outcome", () => {
      const { agent, runner, d } = wire();

      agent.emit("event", {
        type: "agent_result",
        status: "error",
        sessionId: "cli-session",
        error: "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.",
      } as AgentEvent);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const rows = calls.flatMap((c) => c[1] as { isError?: boolean }[]);
      expect(rows.some((m) => m.isError)).toBe(false);
      expect(d.chatHistoryManager.append).not.toHaveBeenCalled();
      runner.dispose({ force: true });
    });

    it("DOES add a row for a quota refusal on a metered key, which never fails over", () => {
      const d = deps();
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "grok",
      });
      runner.running = true;
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        getCapturedRoutePolicy: () => ({
          billingMode: "key",
          serviceId: "xai",
          stopsOnFailure: true,
          vendorOwnedRecovery: true,
        }),
      });

      // Grok CLI capture against a local recorder returning 429.
      const refusal =
        "Out of credits: Your team has either used all available credits or "
        + "reached its monthly spending limit.";
      agent.emit("event", {
        type: "agent_result",
        status: "error",
        sessionId: "cli-session",
        error: refusal,
      } as AgentEvent);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const rows = calls.flatMap((c) => c[1] as { isError?: boolean; text?: string }[]);
      expect(rows.some((m) => m.isError && m.text === `Error: ${refusal}`)).toBe(true);
      runner.dispose({ force: true });
    });

    it("DOES add a row for a quota refusal on a CLI-started turn, which never re-dispatches", () => {
      const { agent, runner, d } = wire(undefined, {
        isServingAdoptedTurn: () => true,
      });

      const refusal = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";
      agent.emit("event", {
        type: "agent_result",
        status: "error",
        sessionId: "cli-session",
        error: refusal,
      } as AgentEvent);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const rows = calls.flatMap((c) => c[1] as { isError?: boolean; text?: string }[]);
      expect(rows.some((m) => m.isError && m.text === `Error: ${refusal}`)).toBe(true);
      runner.dispose({ force: true });
    });

    it("adds no row for a user-interrupted turn", () => {
      const { agent, runner, d } = wire();
      runner.wasInterrupted = true;

      agent.emit("event", startupDeath);

      const calls = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls;
      const rows = calls.flatMap((c) => c[1] as { isError?: boolean }[]);
      expect(rows.some((m) => m.isError)).toBe(false);
      runner.dispose({ force: true });
    });

    describe("only the first writer records a terminal error row", () => {
      const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

      function errorTexts(d: AgentListenerDeps): string[] {
        const appended = (d.chatHistoryManager.append as ReturnType<typeof vi.fn>).mock.calls
          .map((c) => c[1] as { isError?: boolean; text?: string });
        const replaced = (d.chatHistoryManager.replaceInProgress as ReturnType<typeof vi.fn>).mock.calls
          .flatMap((c) => c[1] as { isError?: boolean; text?: string }[]);
        return [...new Set([...appended, ...replaced].filter((m) => m.isError).map((m) => m.text!))];
      }

      it("the `error` event wins when it fires first, and the synthesized result stands down", async () => {
        const d = deps();
        const history = new ChatHistoryManager(new DatabaseManager(":memory:"));
        d.chatHistoryManager = history as never;
        const { agent, runner } = wire(d);

        agent.emit("error", new Error("spawn ENOENT"));
        await tick();
        agent.emit("event", startupDeath);

        const rows = history.load("session-1").filter((m) => m.isError);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.text).toBe("Error: spawn ENOENT");
        runner.dispose({ force: true });
      });

      it("the result row wins when it lands first, and a late `error` stands down", async () => {
        const { agent, runner, d } = wire();

        agent.emit("event", startupDeath);
        agent.emit("error", new Error("spawn ENOENT"));
        await tick();

        expect(errorTexts(d)).toEqual([errorRow.text]);
        runner.dispose({ force: true });
      });
    });
  });

  describe("blocked-turn errors (docs/150-multiple-provider-subscriptions req 13)", () => {
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
      onAgentAuthRequired?: (agentId: string) => void;
      markSessionAccountExhausted?: (sessionId: string, until: number, routeId?: string) => void;
      session?: Record<string, unknown>;
      getCapturedRouteId?: () => string | undefined;
      getCapturedRouteKind?: () => "account" | "reserved" | "string" | undefined;
    }) {
      const { session, onAgentAuthRequired, markSessionAccountExhausted, ...opts } = extra;
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
      if (onAgentAuthRequired) d.onAgentAuthRequired = onAgentAuthRequired as never;
      if (markSessionAccountExhausted) d.markSessionAccountExhausted = markSessionAccountExhausted;
      d.sessionManager.get = vi.fn(() => ({ agentId: "codex", ...session })) as never;
      const extraOpts = opts;
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        ...extraOpts,
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
      expect(emitted.find((m) => m.type === "auth_required")).toBeUndefined();
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
      const err = emitted.find((m) => m.type === "error") as { message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.message).toContain("Settings");
    });

    it("surfaces a re-auth error when no recovery hooks are wired", async () => {
      const { agent, killSpy, runner, emitted } = wireAuth({});

      agent.emit("auth_required");
      await tick();

      expect(killSpy).toHaveBeenCalled();
      const err = emitted.find((m) => m.type === "error") as { message?: string } | undefined;
      expect(err).toBeDefined();
      expect(err?.message).toContain("Settings");
      expect(runner.running).toBe(false);
      runner.dispose({ force: true });
    });

    it("PERSISTS the re-auth notice into chat history, finalized", async () => {
      const { agent, runner, d } = wireAuth({});

      agent.emit("auth_required");
      await tick();

      expect(d.chatHistoryManager.append).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          role: "assistant",
          text: `Error: ${AGENT_NOT_AUTHENTICATED_MESSAGE}`,
          isError: true,
        }),
      );
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

    describe("a key-authenticated service never enters re-auth (docs/252 req 12)", () => {
      const keySession = {
        serviceId: "deepseek",
        billingMode: "key",
        providerRouteServiceId: "deepseek",
        providerRouteBillingMode: "key",
      };

      it("does not heal or re-dispatch, even with a healer wired", async () => {
        const willRecoverAuth = vi.fn(() => true);
        const recoverAuth = vi.fn().mockResolvedValue(true);
        const { agent, runner } = wireAuth({
          willRecoverAuth,
          recoverAuth,
          session: keySession,
        });

        agent.emit("auth_required");
        await tick();

        expect(willRecoverAuth).not.toHaveBeenCalled();
        expect(recoverAuth).not.toHaveBeenCalled();
        expect(runner.running).toBe(false);
        runner.dispose({ force: true });
      });

      it("does not nudge the vendor's OAuth refresher", async () => {
        const onAgentAuthRequired = vi.fn();
        const { agent, runner } = wireAuth({ onAgentAuthRequired, session: keySession });

        agent.emit("auth_required");
        await tick();

        expect(onAgentAuthRequired).not.toHaveBeenCalled();
        runner.dispose({ force: true });
      });

      it("stops and says so — naming the service, not a sign-in", async () => {
        const { agent, runner, d } = wireAuth({ session: keySession });

        agent.emit("auth_required");
        await tick();

        const appended = (d.chatHistoryManager.append as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
          | { text?: string }
          | undefined;
        expect(appended?.text).toContain("DeepSeek");
        expect(appended?.text).toContain("Settings → Services");
        expect(appended?.text).not.toContain("sign in");
        runner.dispose({ force: true });
      });

      it("still nudges the refresher for the harness vendor's OWN subscription", async () => {
        const onAgentAuthRequired = vi.fn();
        const { agent, runner } = wireAuth({
          onAgentAuthRequired,
          session: {
            serviceId: "openai",
            billingMode: "sub",
            providerRouteServiceId: "openai",
            providerRouteBillingMode: "sub",
            providerRouteKind: "account",
            providerRouteId: "acct_1",
          },
        });

        agent.emit("auth_required");
        await tick();

        expect(onAgentAuthRequired).toHaveBeenCalledWith("codex");
        runner.dispose({ force: true });
      });
    });

    describe("a non-vendor subscription credential is set aside (docs/252 req 12)", () => {
      const glmSession = {
        serviceId: "zai",
        billingMode: "sub",
        providerRouteServiceId: "zai",
        providerRouteBillingMode: "sub",
        providerRouteKind: "reserved",
        providerRouteId: "cred_a",
      };

      it("benches the credential so the next turn fails over", async () => {
        const markSessionAccountExhausted = vi.fn();
        const { agent, runner } = wireAuth({
          markSessionAccountExhausted,
          session: glmSession,
          getCapturedRouteId: () => "cred_a",
          getCapturedRouteKind: () => "reserved",
        });

        agent.emit("auth_required");
        await tick();

        expect(markSessionAccountExhausted).toHaveBeenCalledWith("session-1", expect.any(Number), "cred_a");
        runner.dispose({ force: true });
      });

      it("never benches a metered key", async () => {
        const markSessionAccountExhausted = vi.fn();
        const { agent, runner } = wireAuth({
          markSessionAccountExhausted,
          session: {
            serviceId: "deepseek",
            billingMode: "key",
            providerRouteServiceId: "deepseek",
            providerRouteBillingMode: "key",
            providerRouteKind: "reserved",
            providerRouteId: "cred_k",
          },
        });

        agent.emit("auth_required");
        await tick();

        expect(markSessionAccountExhausted).not.toHaveBeenCalled();
        runner.dispose({ force: true });
      });

      it("neither heals nor nudges the harness vendor", async () => {
        const willRecoverAuth = vi.fn(() => true);
        const onAgentAuthRequired = vi.fn();
        const { agent, runner } = wireAuth({
          willRecoverAuth,
          recoverAuth: vi.fn().mockResolvedValue(true),
          onAgentAuthRequired,
          session: glmSession,
        });

        agent.emit("auth_required");
        await tick();

        expect(willRecoverAuth).not.toHaveBeenCalled();
        expect(onAgentAuthRequired).not.toHaveBeenCalled();
        runner.dispose({ force: true });
      });

      it("says the credential was set aside, not that you should sign in", async () => {
        const { agent, runner, d } = wireAuth({
          session: glmSession,
          getCapturedRouteId: () => "cred_a",
          getCapturedRouteKind: () => "reserved",
        });

        agent.emit("auth_required");
        await tick();

        const appended = (d.chatHistoryManager.append as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
          | { text?: string }
          | undefined;
        expect(appended?.text).toContain("set that credential aside");
        expect(appended?.text).not.toContain("Settings → Agents");
        runner.dispose({ force: true });
      });
    });
  });

  describe("unrecoverable stale resume", () => {
    it("persists the couldn't-resume error instead of only emitting it", async () => {
      const agent = new FakeAgent();
      const runner = new SessionRunner({
        sessionId: "session-1",
        sessionDir: "/tmp/session-1",
        defaultAgentId: "codex",
      });
      runner.running = true;
      const emitted: { type?: string; message?: string }[] = [];
      runner.on("message", (m) => emitted.push(m as { type?: string; message?: string }));
      const d = deps();
      wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
        capturedSessionId: "session-1",
        isNewSession: false,
        persistUserMessage: vi.fn(),
        recoverMissingConversation: () => false,
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
    runner.running = true;
    const emitted: any[] = [];
    runner.on("message", (m) => emitted.push(m));

    wireAgentListeners(agent as unknown as AgentProcess, runner, deps(), {
      capturedSessionId: "session-1",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });

    agent.emit("event", { type: "agent_compaction_started", trigger: "manual" } satisfies AgentEvent);
    expect(emitted).toEqual([
      { type: "compaction_status", sessionId: "session-1", active: true, trigger: "manual" },
    ]);
    expect(runner.recordedCards).toHaveLength(0);

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
      runner.running = true;

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

describe("wireAgentListeners — background-work marker", () => {
  function wireForBackgroundTasks() {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-bg",
      sessionDir: "/tmp/session-bg",
      defaultAgentId: "codex",
    });
    runner.isStreamingActive = true;
    runner.setAgent(agent as unknown as AgentProcess);
    const announced: string[][] = [];
    runner.on("background_work", () => announced.push(runner.backgroundWorkDescriptions));
    wireAgentListeners(agent as unknown as AgentProcess, runner, deps(), {
      capturedSessionId: "session-bg",
      isNewSession: false,
      persistUserMessage: vi.fn(),
    });
    return { agent, runner, announced };
  }

  it("announces the descriptions when a background task starts", () => {
    const { agent, announced } = wireForBackgroundTasks();

    agent.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "shipit agent run --agent codex" }],
    } satisfies AgentEvent);

    expect(announced).toEqual([["shipit agent run --agent codex"]]);
  });

  it("announces the drain when the tasks drain", () => {
    const { agent, announced } = wireForBackgroundTasks();

    agent.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "npm test" }],
    } satisfies AgentEvent);
    agent.emit("event", { type: "agent_background_tasks", tasks: [] } satisfies AgentEvent);

    expect(announced.at(-1)).toEqual([]);
  });

  it("announces the drain when the agent process errors out", () => {
    const { agent, runner, announced } = wireForBackgroundTasks();

    agent.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "npm test" }],
    } satisfies AgentEvent);
    agent.emit("error", new Error("process died"));

    expect(announced.at(-1)).toEqual([]);
    expect(runner.backgroundWorkDescriptions).toEqual([]);
  });

  it("stays silent when nothing actually changed", () => {
    const { agent, runner, announced } = wireForBackgroundTasks();

    agent.emit("event", { type: "agent_background_tasks", tasks: [] } satisfies AgentEvent);
    runner.clearBackgroundTasks();
    runner.isStreamingActive = true;

    expect(announced).toEqual([]);
  });
});

describe("wireAgentListeners — a CLI-started turn announces itself cross-session (docs/267)", () => {
  function wireForAdoption(opts: { useStreaming?: boolean } = {}) {
    const agent = new FakeAgent();
    const runner = new SessionRunner({
      sessionId: "session-wake",
      sessionDir: "/tmp/session-wake",
      defaultAgentId: "codex",
    });
    runner.setAgent(agent as unknown as AgentProcess);
    const d = deps();
    wireAgentListeners(agent as unknown as AgentProcess, runner, d, {
      capturedSessionId: "session-wake",
      isNewSession: false,
      persistUserMessage: vi.fn(),
      adoptsCliStartedTurns: true,
      ...(opts.useStreaming !== undefined ? { useStreaming: opts.useStreaming } : {}),
    });
    const started = (): unknown[] =>
      (d.sseBroadcast as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]) => event === "session_agent_started")
        .map(([, payload]) => payload);
    return { agent, runner, started };
  }

  function runAndEndATurn(agent: FakeAgent, runner: SessionRunner): void {
    runner.running = true;
    agent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "session-wake",
    } satisfies AgentEvent);
  }

  it("broadcasts session_agent_started when a background job wakes the CLI", () => {
    const { agent, runner, started } = wireForAdoption({ useStreaming: true });
    runAndEndATurn(agent, runner);

    agent.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      status: "completed",
    } satisfies AgentEvent);

    expect(runner.running).toBe(true);
    expect(started()).toEqual([{ sessionId: "session-wake" }]);
  });

  it("broadcasts on the assistant edge too, for a steer the CLI ran as its own turn", () => {
    const { agent, runner, started } = wireForAdoption({ useStreaming: true });
    runAndEndATurn(agent, runner);

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "on it" }],
    } satisfies AgentEvent);

    expect(started()).toEqual([{ sessionId: "session-wake" }]);
  });

  it("broadcasts exactly once however many notifications one adopted turn produces", () => {
    const { agent, runner, started } = wireForAdoption({ useStreaming: true });
    runAndEndATurn(agent, runner);

    const wake = {
      type: "agent_self_wake",
      taskId: "bg-1",
      status: "completed",
    } satisfies AgentEvent;
    agent.emit("event", wake);
    agent.emit("event", wake);
    agent.emit("event", wake);
    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "text", text: "working" }],
    } satisfies AgentEvent);

    expect(started()).toHaveLength(1);
  });

  it("stays silent for a notification that lands mid-turn", () => {
    const { agent, runner, started } = wireForAdoption({ useStreaming: true });
    runner.running = true;

    agent.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      status: "completed",
    } satisfies AgentEvent);

    expect(started()).toEqual([]);
  });

  it("stays silent on a one-shot turn, where nothing would broadcast the matching finish", () => {
    const { agent, runner, started } = wireForAdoption();
    runAndEndATurn(agent, runner);

    agent.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      status: "completed",
    } satisfies AgentEvent);

    expect(runner.running).toBe(true);
    expect(started()).toEqual([]);
  });
});
