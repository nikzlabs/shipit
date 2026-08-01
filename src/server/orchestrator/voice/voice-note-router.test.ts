import { describe, it, expect, beforeEach } from "vitest";
import {
  routeVoiceNote,
  resetVoiceNoteTurnState,
  hasAuthoredVoiceNoteThisTurn,
} from "./voice-note-router.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { CredentialStore } from "../credential-store.js";

// Minimal fake runner: emitMessage + the turn-accumulation fields the native
// sink records onto (`emitChatCard` reads chatMessageGroups for the anchor and
// pushes onto recordedCards). Identity is what the WeakMap keys on, so a fresh
// object per test is an isolated "turn".
function fakeRunner(
  groups: { text: string; toolUse: unknown[] }[] = [],
): { runner: SessionRunnerInterface; emitted: WsServerMessage[] } {
  const emitted: WsServerMessage[] = [];
  const runner = {
    emitMessage: (m: WsServerMessage) => emitted.push(m),
    chatMessageGroups: groups,
    recordedCards: [],
    steeredMessages: [],
  } as unknown as SessionRunnerInterface;
  return { runner, emitted };
}

// `emitChatCard` now persists the in-progress turn (docs/191), so every
// `routeVoiceNote` call needs a chat-history sink. A no-op satisfies the
// contract for cases that don't assert on persistence; `route` injects it so
// each test case's deps stay terse.
const noopHistory = { replaceInProgress: () => {} };
const route = (
  payload: Parameters<typeof routeVoiceNote>[0],
  deps: Omit<Parameters<typeof routeVoiceNote>[1], "chatHistoryManager">,
) => routeVoiceNote(payload, { ...deps, chatHistoryManager: noopHistory });

function fakeCredentialStore(opts: {
  mode: VoiceDeliveryMode;
  webhook?: { url: string; token: string } | null;
}): CredentialStore {
  return {
    getVoiceDeliveryMode: () => opts.mode,
    getVoiceWebhook: () => opts.webhook ?? null,
  } as unknown as CredentialStore;
}

const base = (over: Partial<{ summary: string }> = {}) => ({
  summary: over.summary ?? "Done — one test is still red, want me to dig in?",
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
    const res = await route(base(), {
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
      kind: "authored",
    });
  });

  it("records the native card on the runner, anchored after the current groups, so it survives a reload", async () => {
    // Two persistable assistant groups already accumulated this turn — the card
    // must anchor after them so `buildTurnMessages` re-interleaves it at the end
    // of the turn (where the tool was issued), not above it.
    const { runner } = fakeRunner([
      { text: "working…", toolUse: [] },
      { text: "", toolUse: [{ name: "Edit" }] },
    ]);
    const credentialStore = fakeCredentialStore({ mode: "native" });
    await route(base(), {
      runner,
      sessionId: "s1",
      credentialStore,
      source: "authored",
      idFactory: deterministicId,
      now: fixedNow,
    });
    expect(runner.recordedCards).toHaveLength(1);
    expect(runner.recordedCards[0]).toMatchObject({
      afterGroupIndex: 2,
      message: {
        role: "assistant",
        text: "",
        voiceNote: {
          id: "voice-test-1",
          headline: base().summary,
          kind: "authored",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      },
    });
  });

  it("does NOT record a card when delivery is external-only (no native bubble)", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "external",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await route(base(), {
      runner, sessionId: "s1", credentialStore,
      source: "authored", fetchImpl, idFactory: deterministicId, now: fixedNow,
    });
    expect(runner.recordedCards).toHaveLength(0);
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

    const res = await route(base(), {
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
    const res = await route(base(), {
      runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl,
      idFactory: deterministicId, now: fixedNow,
    });
    expect(res.native).toBe(true);
    expect(res.webhook).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it("deduplicates event observation against the bridge fallback", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "both",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    let webhookCalls = 0;
    const fetchImpl = (async () => {
      webhookCalls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const observed = await route(base(), {
      runner, sessionId: "s1", credentialStore, source: "authored",
      authoredPath: "observation", fetchImpl, idFactory: deterministicId,
    });
    const bridged = await route(base(), {
      runner, sessionId: "s1", credentialStore, source: "authored",
      authoredPath: "bridge", fetchImpl, idFactory: deterministicId,
    });

    expect(observed.duplicate).toBe(false);
    expect(bridged).toMatchObject({
      id: observed.id,
      duplicate: true,
      native: false,
      webhook: false,
    });
    expect(emitted).toHaveLength(1);
    expect(webhookCalls).toBe(1);
  });

  // The silent (`needsAttention: false`) note was removed — every note is
  // attention-worthy. The webhook body keeps a constant `needsAttention: true`
  // so existing `v: 1` receivers that branch on it keep working.
  it("posts a constant needsAttention: true in the v1 webhook body", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({
      mode: "external",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await route(base(), {
      runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl,
      idFactory: deterministicId, now: fixedNow,
    });
    expect(body).toMatchObject({ v: 1, needsAttention: true });
  });

  it("authored source sets the per-turn authored flag", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(false);
    await route(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(true);
    // A derived note must NOT set the authored flag.
    const { runner: r2 } = fakeRunner();
    await route(base(), { runner: r2, sessionId: "s1", credentialStore, source: "ask", idFactory: deterministicId });
    expect(hasAuthoredVoiceNoteThisTurn(r2)).toBe(false);
  });

  // The per-turn attention cap was removed (docs/163): it was redundant with the
  // client's 20s chime debounce and inverted against latest-wins playback —
  // silencing the NEWEST note while stale speech kept playing. Every note in a
  // turn now delivers in full.
  it("does not cap or downgrade repeated notes within a turn", async () => {
    const { runner, emitted } = fakeRunner();
    let webhookPosts = 0;
    const fetchImpl = (async () => {
      webhookPosts++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const credentialStore = fakeCredentialStore({
      mode: "both",
      webhook: { url: "https://hook.example/notes", token: "t" },
    });
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await route(base({ summary: `Note ${i} — your call.` }), {
          runner,
          sessionId: "s1",
          credentialStore,
          source: "authored",
          idFactory: deterministicId,
          fetchImpl,
        }),
      );
    }
    expect(results.every((r) => r.native)).toBe(true);
    expect(results.every((r) => r.webhook)).toBe(true);
    expect(emitted).toHaveLength(6);
    expect(webhookPosts).toBe(6);
  });

  it("resetVoiceNoteTurnState clears the authored flag", async () => {
    const { runner } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "native" });
    await route(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(true);
    resetVoiceNoteTurnState(runner);
    expect(hasAuthoredVoiceNoteThisTurn(runner)).toBe(false);
    const res = await route(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
    expect(res.native).toBe(true);
  });

  it("external mode with no webhook configured does not post", async () => {
    const { runner, emitted } = fakeRunner();
    const credentialStore = fakeCredentialStore({ mode: "external", webhook: null });
    const res = await route(base(), { runner, sessionId: "s1", credentialStore, source: "authored", idFactory: deterministicId });
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
    const res = await route(base(), { runner, sessionId: "s1", credentialStore, source: "authored", fetchImpl, idFactory: deterministicId });
    expect(res.webhook).toBe(true);
    expect(res.webhookError).toContain("network down");
  });
});
