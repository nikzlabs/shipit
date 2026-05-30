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
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { registerVoiceRoutes } from "./api-routes-voice.js";
import type { ApiDeps } from "./api-routes.js";

/** Minimal in-memory credential store covering just the voice methods. */
function makeCredentialStore() {
  let key: string | null = null;
  let provider: "openai" | null = null;
  return {
    getVoiceProviderApiKey: vi.fn((): string | null => key),
    getVoiceProvider: vi.fn((): "openai" | null => provider),
    setVoiceProviderApiKey: vi.fn((k: string, p: "openai" = "openai") => {
      key = k;
      provider = p;
    }),
    clearVoiceProviderApiKey: vi.fn(() => {
      key = null;
      provider = null;
    }),
  };
}

/** Auth manager whose getAccessToken returns no bearer by default. */
function makeAuthManager(token: string | null = null) {
  return {
    getAccessToken: vi.fn(async () => ({ token })),
  };
}

let tmpDir: string;

async function buildApp(overrides?: {
  credentialStore?: ReturnType<typeof makeCredentialStore>;
  authManager?: ReturnType<typeof makeAuthManager>;
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
  it("reports not configured and leaks no key when none set", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ configured: false });
    await app.close();
  });

  it("reports configured but never leaks the key when set", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderApiKey("sk-super-secret-123", "openai");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.provider).toBe("openai");
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
    expect(credentialStore.setVoiceProviderApiKey).toHaveBeenCalledWith("sk-abc", "openai");
    expect(credentialStore.getVoiceProviderApiKey()).toBe("sk-abc");
    await app.close();
  });

  it("rejects an empty key with 400", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { apiKey: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/API key is required/i);
    await app.close();
  });

  it("clears the key on DELETE", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderApiKey("sk-abc", "openai");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "DELETE", url: "/api/voice/credentials" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(credentialStore.clearVoiceProviderApiKey).toHaveBeenCalled();
    expect(credentialStore.getVoiceProviderApiKey()).toBeNull();
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

  it("returns audio bytes when a key is set and the TTS provider yields audio", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderApiKey("sk-abc", "openai");

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
});

describe("SECURITY: no GET route returns the raw key", () => {
  it("GET /api/voice/credentials is not a route (404)", async () => {
    const credentialStore = makeCredentialStore();
    credentialStore.setVoiceProviderApiKey("sk-super-secret-123", "openai");
    const { app } = await buildApp({ credentialStore });
    const res = await app.inject({ method: "GET", url: "/api/voice/credentials" });
    expect(res.statusCode).toBe(404);
    // And even the 404 body must not echo the secret.
    expect(res.payload).not.toContain("sk-super-secret-123");
    await app.close();
  });
});
