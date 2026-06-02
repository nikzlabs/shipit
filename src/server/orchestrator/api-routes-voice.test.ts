/**
 * Tests for the Voice API routes (docs/144).
 *
 * Builds a real Fastify instance and registers ONLY the voice routes with fake
 * deps (credentialStore, authManager) and a stubbed global fetch so no real
 * OpenAI/Anthropic calls happen. Uses app.inject() — no network port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerVoiceRoutes } from "./api-routes-voice.js";
import type { ApiDeps } from "./api-routes.js";

/** Minimal in-memory credential store covering just the voice methods. */
function makeCredentialStore() {
  const keys = new Map<string, string>();
  let deliveryMode: "native" | "external" | "both" = "native";
  let webhook: { url: string; token: string } | null = null;
  return {
    getVoiceProviderKey: vi.fn((id: string): string | null => keys.get(id) ?? null),
    setVoiceProviderKey: vi.fn((id: string, k: string) => {
      keys.set(id, k);
    }),
    clearVoiceProviderKey: vi.fn((id: string) => {
      keys.delete(id);
    }),
    getConfiguredVoiceProviders: vi.fn((): string[] =>
      [...keys.entries()].filter(([, v]) => v.trim()).map(([id]) => id),
    ),
    // docs/163
    getVoiceDeliveryMode: vi.fn(() => deliveryMode),
    setVoiceDeliveryMode: vi.fn((m: "native" | "external" | "both") => {
      deliveryMode = m;
    }),
    getVoiceWebhook: vi.fn(() => webhook),
    setVoiceWebhook: vi.fn((url: string, token: string) => {
      webhook = { url, token };
    }),
    clearVoiceWebhook: vi.fn(() => {
      webhook = null;
    }),
  };
}

/** Fake runner registry capturing emitted WS messages for one session. */
function makeRunnerRegistry(sessionId: string) {
  const emitted: { type: string; [k: string]: unknown }[] = [];
  // The native sink records the card on the runner (docs/163): `recordVoiceNote`
  // reads chatMessageGroups for the anchor and pushes onto voiceNotes.
  const runner = {
    emitMessage: (m: { type: string }) => emitted.push(m),
    chatMessageGroups: [] as { text: string; toolUse: unknown[] }[],
    voiceNotes: [] as unknown[],
  };
  return {
    emitted,
    runner,
    registry: { get: (id: string) => (id === sessionId ? runner : undefined) },
  };
}

/** Auth manager whose getAccessToken returns no bearer by default. */
function makeAuthManager(token: string | null = null) {
  return {
    getAccessToken: vi.fn(async () => ({ token })),
  };
}

function buildMultipartBody(parts: {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}[]): { payload: Buffer; boundary: string } {
  const boundary = `----VoiceFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const buffers: Buffer[] = [];

  for (const part of parts) {
    const disposition = `Content-Disposition: form-data; name="${part.name}"${
      part.filename ? `; filename="${part.filename}"` : ""
    }\r\n`;
    buffers.push(Buffer.from(`--${boundary}\r\n${disposition}`));
    if (part.contentType) {
      buffers.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    buffers.push(Buffer.from("\r\n"));
    buffers.push(typeof part.value === "string" ? Buffer.from(part.value) : part.value);
    buffers.push(Buffer.from("\r\n"));
  }

  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(buffers), boundary };
}

let tmpDir: string;

async function buildApp(overrides?: {
  credentialStore?: ReturnType<typeof makeCredentialStore>;
  authManager?: ReturnType<typeof makeAuthManager>;
  runnerRegistry?: { get: (id: string) => unknown };
}): Promise<{
  app: FastifyInstance;
  credentialStore: ReturnType<typeof makeCredentialStore>;
  authManager: ReturnType<typeof makeAuthManager>;
}> {
  const credentialStore = overrides?.credentialStore ?? makeCredentialStore();
  const authManager = overrides?.authManager ?? makeAuthManager();
  const app = Fastify();
  await app.register(fastifyMultipart);
  await registerVoiceRoutes(app, {
    credentialStore,
    authManager,
    workspaceDir: tmpDir,
    stateDir: tmpDir,
    runnerRegistry: overrides?.runnerRegistry ?? { get: () => undefined },
  } as unknown as ApiDeps);
  await app.ready();
  return { app, credentialStore, authManager };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-routes-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("GET /api/voice/credentials/status", () => {
  it("reports an empty list and leaks no key when none set", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ configured: [] });
    await app.close();
  });

  it("lists configured provider ids but never leaks the key when set", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-super-secret-123");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toEqual(["openai"]);
    // Security: status must NEVER carry the raw key under any field name.
    expect(JSON.stringify(body)).not.toContain("sk-super-secret-123");
    expect(body.apiKey).toBeUndefined();
    expect(body.key).toBeUndefined();
    await app.close();
  });
});

describe("POST/DELETE /api/voice/credentials", () => {
  it("stores the key on POST and returns ok", async () => {
    const { app, credentialStore } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { apiKey: "sk-abc", provider: "openai" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(credentialStore.setVoiceProviderKey).toHaveBeenCalledWith("openai", "sk-abc");
    expect(credentialStore.getVoiceProviderKey("openai")).toBe("sk-abc");
    await app.close();
  });

  it("stores a per-provider key (deepgram) under its own id", async () => {
    const { app, credentialStore } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { apiKey: "dg-xyz", provider: "deepgram" },
    });
    expect(res.statusCode).toBe(200);
    expect(credentialStore.setVoiceProviderKey).toHaveBeenCalledWith("deepgram", "dg-xyz");
    expect(credentialStore.getVoiceProviderKey("deepgram")).toBe("dg-xyz");
    expect(credentialStore.getVoiceProviderKey("openai")).toBeNull();
    await app.close();
  });

  it("rejects an unknown provider with 400", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { apiKey: "sk-abc", provider: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown voice provider/i);
    await app.close();
  });

  it("rejects an empty key with 400", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { apiKey: "   ", provider: "openai" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/API key is required/i);
    await app.close();
  });

  it("clears the key on DELETE", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-abc");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/voice/credentials",
      payload: { provider: "openai" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(credentialStore.clearVoiceProviderKey).toHaveBeenCalledWith("openai");
    expect(credentialStore.getVoiceProviderKey("openai")).toBeNull();
    await app.close();
  });
});

describe("GET /api/voice/cleanup/status", () => {
  it("returns null provider when no OAuth bearer and no key", async () => {
    // authManager returns no token and key is null → no provider available.
    const { app } = await buildApp({ authManager: makeAuthManager(null) });
    const res = await app.inject({ method: "GET", url: "/api/voice/cleanup/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: null });
    await app.close();
  });

  it("indicates the claude cleanup provider when an OAuth bearer is present", async () => {
    const { app } = await buildApp({ authManager: makeAuthManager("oauth-bearer-token") });
    const res = await app.inject({ method: "GET", url: "/api/voice/cleanup/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBeTruthy();
    await app.close();
  });
});

describe("POST /api/voice/speak", () => {
  it("returns 400 when text is missing", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/voice/speak", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text is required/i);
    await app.close();
  });

  it("returns 400 when text is only whitespace", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/speak",
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 for a TTS provider with no key configured", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/speak",
      payload: { text: "Hello", voice: "21m00Tcm4TlvDq8ikWAM", speed: 1, provider: "elevenlabs" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No API key configured/i);
    await app.close();
  });

  it("returns 400 for a voice that doesn't belong to the provider", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-abc");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/speak",
      // "21m00..." is an ElevenLabs voice id, invalid for OpenAI.
      payload: { text: "Hello", voice: "21m00Tcm4TlvDq8ikWAM", speed: 1, provider: "openai" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unknown voice/i);
    await app.close();
  });

  it("returns audio bytes when a key is set and the TTS provider yields audio", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-abc");

    // Stub global fetch so the OpenAI TTS provider returns a streamed body.
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(audioBytes);
            controller.close();
          },
        }),
        arrayBuffer: async () => audioBytes.buffer,
      })),
    );

    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/speak",
      payload: { text: "Hello world", voice: "alloy", speed: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.rawPayload.length).toBeGreaterThan(0);
    await app.close();
  });

  it("does not send the configured key back to the browser when synthesizing speech", async () => {
    const secret = "sk-route-speak-secret";
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", secret);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([9, 8, 7]));
            controller.close();
          },
        }),
      })),
    );

    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/speak",
      payload: { text: "Hello world", voice: "alloy", speed: 1, provider: "openai" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(secret);
    expect(JSON.stringify(res.headers)).not.toContain(secret);
    await app.close();
  });
});

describe("POST /api/voice/transcribe", () => {
  it("returns 400 when the request is not multipart", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload: { not: "multipart" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Expected multipart/i);
    await app.close();
  });

  it("does not send the configured key back to the browser when transcribing audio", async () => {
    const secret = "sk-route-transcribe-secret";
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", secret);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ text: "  recognized text  " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { payload, boundary } = buildMultipartBody([
      { name: "audio", filename: "audio.webm", contentType: "audio/webm", value: Buffer.from("audio-bytes") },
      { name: "cleanup", value: "false" },
      { name: "sttProvider", value: "openai" },
    ]);
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "recognized text", rawText: "recognized text" });
    expect(res.payload).not.toContain(secret);
    expect(JSON.stringify(res.headers)).not.toContain(secret);
    await app.close();
  });

  it("returns provider transcription details when upstream transcription fails", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-route-transcribe-secret");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "audio format is unsupported" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { payload, boundary } = buildMultipartBody([
      { name: "audio", filename: "audio.webm", contentType: "audio/webm", value: Buffer.from("audio-bytes") },
      { name: "cleanup", value: "false" },
      { name: "sttProvider", value: "openai" },
    ]);
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Couldn't transcribe: Whisper returned 400");
    expect(res.json().error).toContain("audio format is unsupported");
    await app.close();
  });
});

describe("Voice-note webhook config (docs/163)", () => {
  it("stores the webhook on POST and reports configured status without the token", async () => {
    const { app, credentialStore } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/webhook",
      payload: { url: "https://hook.example/notes", token: "super-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(credentialStore.setVoiceWebhook).toHaveBeenCalledWith("https://hook.example/notes", "super-secret");

    const status = await app.inject({ method: "GET", url: "/api/voice/webhook/status" });
    const body = status.json();
    expect(body.configured).toBe(true);
    expect(body.url).toBe("https://hook.example/notes");
    // The token must never be returned.
    expect(JSON.stringify(body)).not.toContain("super-secret");
    await app.close();
  });

  it("rejects a non-http URL with 400", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/webhook",
      payload: { url: "ftp://nope", token: "t" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("clears the webhook on DELETE", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceWebhook("https://hook.example/notes", "t");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "DELETE", url: "/api/voice/webhook" });
    expect(res.statusCode).toBe(200);
    expect(credentialStore.clearVoiceWebhook).toHaveBeenCalled();
    expect(credentialStore.getVoiceWebhook()).toBeNull();
    await app.close();
  });
});

describe("POST /api/sessions/:sessionId/voice-note (docs/163)", () => {
  it("routes an authored note to the native sink and emits voice_note", async () => {
    const { emitted, runner, registry } = makeRunnerRegistry("sess-1");
    const { app } = await buildApp({ runnerRegistry: registry });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/voice-note",
      payload: { summary: "Done — want me to open a PR?", needsAttention: true, context: { repo: "shipit" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "voice_note",
      sessionId: "sess-1",
      headline: "Done — want me to open a PR?",
      needsAttention: true,
      kind: "authored",
    });
    // docs/163 — the card is recorded on the runner for in-band persistence so
    // it reloads where the tool was issued, not above the turn.
    expect(runner.voiceNotes).toHaveLength(1);
    await app.close();
  });

  it("returns 400 when summary is missing", async () => {
    const { registry } = makeRunnerRegistry("sess-1");
    const { app } = await buildApp({ runnerRegistry: registry });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/voice-note",
      payload: { needsAttention: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("acknowledges with delivered:false when no runner is active", async () => {
    const { app } = await buildApp({ runnerRegistry: { get: () => undefined } });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/gone/voice-note",
      payload: { summary: "hi", needsAttention: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: false });
    await app.close();
  });
});

describe("SECURITY: no GET route returns the raw key", () => {
  it("GET /api/voice/credentials is not a route (404)", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderKey("openai", "sk-super-secret-123");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials" });
    expect(res.statusCode).toBe(404);
    // And even the 404 body must not echo the secret.
    expect(res.payload).not.toContain("sk-super-secret-123");
    await app.close();
  });
});
