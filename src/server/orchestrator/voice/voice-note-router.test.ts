import { describe, it, expect, beforeEach } from "vitest";
import {
  routeVoiceNote,
  resetVoiceNoteTurnState,
  hasAuthoredVoiceNoteThisTurn,
  MAX_ATTENTION_NOTES_PER_TURN,
} from "./voice-note-router.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { CredentialStore } from "../credential-store.js";

// Minimal fake runner: only emitMessage matters to the router. Identity is what
// the WeakMap keys on, so a fresh object per test is an isolated "turn".
function fakeRunner(): { runner: SessionRunnerInterface; emitted: WsServerMessage[] } {
  const emitted: WsServerMessage[] = [];
  const runner = {
    emitMessage: (m: WsServerMessage) => emitted.push(m),
  } as unknown as SessionRunnerInterface;
  return { runner, emitted };
}

function fakeCredentialStore(opts: {
  mode: VoiceDeliveryMode;
  webhook?: { url: string; token: string } | null;
}): CredentialStore {
  return {
    getVoiceDeliveryMode: () => opts.mode,
    getVoiceWebhook: () => opts.webhook ?? null,
  } as unknown as CredentialStore;
}

// Captures chat-history appends so we can assert the card is persisted.
function fakeChatHistory(): { mgr: { append: (s: string, m: unknown) => number }; appended: { sessionId: string; message: Record<string, unknown> }[] } {
  const appended: { sessionId: string; message: Record<string, unknown> }[] = [];
  const mgr = {
    append: (sessionId: string, message: unknown) => {
      appended.push({ sessionId, message: message as Record<string, unknown> });
      return appended.length;
    },
  };
  return { mgr, appended };
}

const base = (over: Partial<{ summary: string; needsAttention: boolean }> = {}) => ({
  summary: over.summary ?? "Done — one test is still red, want me to dig in?",
  needsAttention: over.needsAttention ?? true,
});

let idCounter = 0;
const deterministicId = () => `voice-test-${++idCounter}`;
const fixedNow = () => "2026-06-01T00:00:00.000Z";

describe("routeVoiceNote", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it("native mode emits a voice_note WS message and no webhook", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    const res = await routeVoiceNote(base(), {
      runner,
      sessionId: "s1",
      credentialStore,
      source: "authored",
      idFactory: deterministicId,
      now: fixedNow,
    });
    expect(res.native).toBe(true);
    expect(res.webhook).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "voice_note",
      sessionId: "s1",
      headline: base().summary,
      needsAttention: true,
      kind: "authored",
    });
  });

  it("persists the native card to chat history so it survives a reload", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    const { mgr, appended } = fakeChatHistory();
    await routeVoiceNote(base(), {
      runner,
      sessionId: "s1",
      credentialStore,
      chatHistoryManager: mgr as never,
      source: "authored",
      idFactory: deterministicId,
      now: fixedNow,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].sessionId).toBe("s1");
    expect(appended[0].message).toMatchObject({
      role: "assistant",
      text: "",
      voiceNote: {
        id: "voice-test-1",
        headline: base().summary,
        needsAttention: true,
        kind: "authored",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });
  });

  it("does NOT persist a card when delivery is external-only (no native bubble)", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "external",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    const { mgr, appended } = fakeChatHistory();
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await routeVoiceNote(base(), {
      runner, sessionId: "s1", credentialStore, chatHistoryManager: mgr as never,
      source: "authored", fetchImpl, idFactory: deterministicId, now: fixedNow,
    });
    expect(appended).toHaveLength(0);
  });

  it("external mode posts to the webhook with bearer auth and v:1 body, no native note", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "external",
      webhook: { url: "https://hook.example/notes", token: "secret-token" },
    });
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = { url, init: init ?? {} };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await routeVoiceNote(base(), {
      runner,
      sessionId: "s1",
      credentialStore,
      source: "authored",
      fetchImpl,
      idFactory: deterministicId,
      now: fixedNow,
    });

    expect(res.native).toBe(false);
    expect(res.webhook).toBe(true);
    expect(res.webhookStatus).toBe(200);
    expect(emitted).toHaveLength(0);
    expect(captured!.url).toBe("https://hook.example/notes");
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body.v).toBe(1);
    expect(body.summary).toBe(base().summary);
    expect(body.needsAttention).toBe(true);
  });

  it("both mode emits native AND posts webhook", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "both",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const res = await routeVoiceNote(base(), {
      runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl,
      idFactory: deterministicId, now: fixedNow,
    });
    expect(res.native).toBe(true);
    expect(res.webhook).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it("needsAttention: false renders a silent native bubble and never webhooks", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "both",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    let webhookCalled = false;
    const fetchImpl = (async () => { webhookCalled = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const res = await routeVoiceNote(base({ needsAttention: false }), {
      runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl,
      idFactory: deterministicId, now: fixedNow,
    });
    expect(res.native).toBe(true);
    expect(res.webhook).toBe(false);
    expect(webhookCalled).toBe(false);
    expect(emitted[0]).toMatchObject({ needsAttention: false });
  });

  it("authored source sets the per-turn authored flag", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(false);
    await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(true);
    // A derived note must NOT set the authored flag.
    const { runner: r2 } = fakeRunner();
    await routeVoiceNote(base(), { runner: r2, sessionId: "s1", credentialStore, source: "ask", idFactory: deterministicId });
    expect(hasAuthoredVoiceNoteThisTurn(r2)).toBe(false);
  });

  it("caps attention-grabbing notes per turn (downgrades extras to silent)", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    const results = [];
    for (let i = 0; i < MAX_ATTENTION_NOTES_PER_TURN + 2; i++) {
      results.push(
        await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId }),
      );
    }
    const attention = results.filter((r) => r.attention).length;
    expect(attention).toBe(MAX_ATTENTION_NOTES_PER_TURN);
    expect(results.slice(MAX_ATTENTION_NOTES_PER_TURN).every((r) => r.capped)).toBe(true);
    // The capped notes still render a (silent) bubble.
    expect(emitted).toHaveLength(MAX_ATTENTION_NOTES_PER_TURN + 2);
  });

  it("resetVoiceNoteTurnState clears the per-turn cap and authored flag", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    for (let i = 0; i < MAX_ATTENTION_NOTES_PER_TURN; i++) {
      await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    }
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(true);
    resetVoiceNoteTurnState(runner);
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(false);
    const res = await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(res.attention).toBe(true);
    expect(res.capped).toBe(false);
  });

  it("external mode with no webhook configured does not post", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "external", webhook: null });
    const res = await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(res.native).toBe(false);
    expect(res.webhook).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("captures a webhook error without throwing", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "external",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const res = await routeVoiceNote(base(), { runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl, idFactory: deterministicId });
    expect(res.webhook).toBe(true);
    expect(res.webhookError).toContain("network down");
  });
});
