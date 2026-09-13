import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Stub generatePackageLock to avoid spawning npm in integration tests.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});

import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import type { CredentialRoute } from "../../shared/types.js";

/**
 * Adopting the OpenAI voice key as a model-provider credential
 * (docs/299-direct-provider-calls req 5). Phase 4b moved cleanup onto the
 * background-work choice, which cannot see a key stored for speech — so an
 * install whose only OpenAI key is the voice one had working cleanup before the
 * feature and none after it, which the requirements' preservation preamble does
 * not allow.
 */
describe("Integration: voice-key adoption over HTTP (docs/299-direct-provider-calls req 5)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    // server-test-setup.ts isolates provider credentials between tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-voice-adopt-api-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      credentialsDir: tmpDir,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function setVoiceKey(provider = "openai", apiKey = "sk-voice-only"): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/credentials",
      payload: { provider, apiKey },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function cleanupStatus(): Promise<{
    model: { modelLabel: string; execution: string } | null;
    adoptableVoiceKey: { providerId: string } | null;
  }> {
    const res = await app.inject({ method: "GET", url: "/api/voice/cleanup/status" });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function adopt(provider = "openai"): Promise<{ statusCode: number; body: string; json: () => { route?: CredentialRoute } }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/credential-routes/adopt-voice-key",
      payload: { provider },
    });
    return { statusCode: res.statusCode, body: res.body, json: () => res.json() };
  }

  async function listRoutes(): Promise<CredentialRoute[]> {
    const res = await app.inject({ method: "GET", url: "/api/credential-routes" });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().routes as CredentialRoute[];
  }

  it("turns the voice key into an ordinary credential and gives cleanup something to run on", async () => {
    await setVoiceKey();

    const before = await cleanupStatus();
    expect(before.model, "a voice key alone buys no background work").toBeNull();
    expect(before.adoptableVoiceKey).toMatchObject({ providerId: "openai" });

    const res = await adopt();
    expect(res.statusCode, res.body).toBe(200);

    // Ordinary in every way docs/252-custom-models req 20 asks for: a visible
    // row, its own generated label, and the same delete the user can reach.
    const routes = await listRoutes();
    const adopted = routes.find((r) => r.serviceId === "openai" && r.billingMode === "key");
    expect(adopted).toBeDefined();
    expect(adopted!.via).toBe("string");
    expect(adopted!.labelIsGenerated).toBe(true);
    expect(credentialStore.getCredentialSecret(adopted!.id)).toBe("sk-voice-only");

    const after = await cleanupStatus();
    expect(after.model?.execution).toBe("direct");
    expect(after.adoptableVoiceKey, "there is nothing left to offer").toBeNull();
  });

  // Speech still reads the voice key from where it was: adoption is a copy into
  // the model-provider registry, not a move out of the voice one.
  it("leaves the voice key configured for speech", async () => {
    await setVoiceKey();
    expect((await adopt()).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/api/voice/credentials/status" });
    expect(res.json().configured).toContain("openai");
    expect(credentialStore.getVoiceProviderKey("openai")).toBe("sk-voice-only");
  });

  it("seeds background work onto the adopted credential when nothing is set", async () => {
    await setVoiceKey();
    expect(credentialStore.getNonTurnModel()).toBeUndefined();

    expect((await adopt()).statusCode).toBe(200);

    expect(credentialStore.getNonTurnModel()).toMatchObject({ serviceId: "openai", billingMode: "key" });
  });

  /**
   * The whole reason this is an offer and not a silent write: choosing a model
   * for the user is what docs/252-custom-models req 9 reserves for them. A
   * choice already made is one of those, so adoption must not move it.
   */
  it("never overwrites a background-work choice the user already made", async () => {
    await setVoiceKey();
    credentialStore.stampNonTurnModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" });

    expect((await adopt()).statusCode).toBe(200);

    expect(credentialStore.getNonTurnModel()).toMatchObject({ modelId: "gpt-5.4-mini" });
  });

  it("refuses a second adoption rather than storing the key twice", async () => {
    await setVoiceKey();
    expect((await adopt()).statusCode).toBe(200);

    const again = await adopt();
    expect(again.statusCode).toBe(409);
    // Its own refusal, not the generic "already has an API key": the caller
    // acted on an offer that is gone, and the message should say that.
    expect(JSON.parse(again.body).error).toMatch(/no OpenAI voice key left/i);

    const openaiKeys = (await listRoutes()).filter((r) => r.serviceId === "openai" && r.billingMode === "key");
    expect(openaiKeys).toHaveLength(1);
  });

  it("refuses to adopt a voice provider that is no model provider", async () => {
    await setVoiceKey("deepgram", "dg-xyz");

    expect((await adopt("deepgram")).statusCode).toBe(409);
    expect(await listRoutes()).toHaveLength(0);
  });
});
