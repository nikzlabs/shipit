import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { writeSessionAccountMarker, syncProviderAccountTokenBack } from "../session-credentials.js";

describe("Integration: Claude auth (OAuth & API key)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let authManager: StubAuthManager;
  let credentialsDir: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-auth-"));
    credentialsDir = path.join(tmpDir, "credentials");

    sessionManager = new SessionManager(dbManager);
    authManager = new StubAuthManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    credentialStore = createTestCredentialStore(tmpDir);
    const now = Date.now();
    credentialStore.upsertCredentialRoute({
      id: "acct-added-claude",
      serviceId: "anthropic", billingMode: "sub", via: "account",
      label: "Added Claude subscription",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });

    app = await buildApp({
      credentialStore,
      credentialsDir,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: authManager as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  it("runs a WS turn from an added Claude account when legacy singleton auth is false", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = Number(new URL(address).port);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "continue on the added subscription" });
    const deadline = Date.now() + 2_000;
    while (!lastClaude?.lastPrompt && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(lastClaude?.lastPrompt).toBe("continue on the added subscription");
    client.close();
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("send_message when unauthenticated returns an error pointing to Settings (no OAuth popup)", async () => {
    const unauthStub = new StubAuthManager() as unknown as AuthManager;
    (unauthStub as any).authenticated = false;
    (unauthStub as any).checkCredentials = () => false;

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-unauth-"));
    const unauthSessions = new SessionManager(dbManager);

    const unauthApp = await buildApp({
      credentialStore: createTestCredentialStore(unauthTmpDir),
      credentialsDir: path.join(unauthTmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
    });
    const addr = await unauthApp.listen({ port: 0, host: "127.0.0.1" });
    const unauthPort = parseInt(new URL(addr).port);

    try {
      const client = await TestClient.connect(unauthPort);
      await client.receive();

      client.send({ type: "send_message", text: "hello" });
      const msg = await client.receiveType("error");

      expect(msg).toMatchObject({ type: "error" });
      expect((msg as any).message).toContain("Settings");
      expect((msg as any).message).toContain("not authenticated");

      client.close();
    } finally {
      await unauthApp.close();
      fs.rmSync(unauthTmpDir, { recursive: true, force: true });
    }
  });

  it("set_api_key authenticates and broadcasts agent_auth_complete", async () => {
    const unauthStub = new StubAuthManager() as unknown as AuthManager;
    (unauthStub as any).authenticated = false;
    (unauthStub as any).checkCredentials = () => {
      const ok = !!process.env.ANTHROPIC_API_KEY;
      (unauthStub as any).authenticated = ok;
      return ok;
    };

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-apikey-"));
    const unauthSessions = new SessionManager(dbManager);

    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const unauthApp = await buildApp({
      credentialStore: createTestCredentialStore(unauthTmpDir),
      credentialsDir: path.join(unauthTmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: unauthSessions,
      authManager: unauthStub,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: unauthTmpDir,
      serveStatic: false,
    });
    const addr = await unauthApp.listen({ port: 0, host: "127.0.0.1" });
    const unauthPort = parseInt(new URL(addr).port);

    try {
      const client = await TestClient.connect(unauthPort);
      await client.receive();

      const res = await unauthApp.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test-key-123" },
      });
      expect(res.statusCode).toBe(200);

      expect(unauthStub.authenticated).toBe(true);
      client.close();
    } finally {
      if (origKey) {
        process.env.ANTHROPIC_API_KEY = origKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      await unauthApp.close();
      fs.rmSync(unauthTmpDir, { recursive: true, force: true });
    }
  });

  it("set_api_key rejects invalid format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-key",
      payload: { key: "bad-key" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Invalid API key format" });
  });

  it("set_api_key rejects empty key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/api-key",
      payload: { key: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "API key cannot be empty" });
  });

  it("does not expose an account-less paste-code endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/code",
      payload: { code: "test-auth-code-123" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("re-pushes a refreshed token only into sessions whose credential subtree is marked with that account", async () => {
    const accountRoot = (accountId: string): string =>
      path.join(credentialsDir, "provider-accounts", "claude", accountId);
    const sessionRoot = (sessionId: string): string =>
      path.join(credentialsDir, "sessions", sessionId);
    const tokenFile = (root: string): string => path.join(root, ".claude", ".credentials.json");
    const writeToken = (root: string, token: string): void => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(
        tokenFile(root),
        JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken: token } }),
      );
    };
    const readToken = (root: string): string =>
      (JSON.parse(fs.readFileSync(tokenFile(root), "utf-8")) as {
        claudeAiOauth: { accessToken: string };
      }).claudeAiOauth.accessToken;

    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const x = accounts.create("anthropic", "Account X");
    const y = accounts.create("anthropic", "Account Y");
    writeToken(accountRoot(x.id), "fresh-x");
    writeToken(accountRoot(y.id), "source-y");

    for (const [sessionId, accountId] of [["sess-x", x.id], ["sess-y", y.id]] as const) {
      sessionManager.track(sessionId, "Claude session");
      sessionManager.setAgentId(sessionId, "claude");
      sessionManager.setAgentPinned(sessionId);
      writeToken(sessionRoot(sessionId), `stale-${sessionId}`);
      writeSessionAccountMarker(credentialsDir, sessionId, "claude", accountId);
    }

    sessionManager.track("sess-unmarked", "Pre-260 session");
    sessionManager.setAgentId("sess-unmarked", "claude");
    sessionManager.setAgentPinned("sess-unmarked");
    writeToken(sessionRoot("sess-unmarked"), "stale-sess-unmarked");

    authManager.start({ accountId: x.id });
    authManager.emit("complete");

    expect(readToken(sessionRoot("sess-x"))).toBe("fresh-x");
    expect(readToken(sessionRoot("sess-y"))).toBe("stale-sess-y");
    expect(readToken(sessionRoot("sess-unmarked"))).toBe("stale-sess-unmarked");
    expect(accounts.get("anthropic", x.id)?.status).toBe("ready");
  });

  it("re-pushes nothing when a completed sign-in names no account", async () => {
    const sessionRoot = (sessionId: string): string =>
      path.join(credentialsDir, "sessions", sessionId);
    const tokenFile = (root: string): string => path.join(root, ".claude", ".credentials.json");
    const writeToken = (root: string, token: string): void => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(
        tokenFile(root),
        JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3_600_000, accessToken: token } }),
      );
    };
    const readToken = (root: string): string =>
      (JSON.parse(fs.readFileSync(tokenFile(root), "utf-8")) as {
        claudeAiOauth: { accessToken: string };
      }).claudeAiOauth.accessToken;

    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const y = accounts.create("anthropic", "Account Y");

    writeToken(credentialsDir, "flat-root-token");

    sessionManager.track("sess-marked", "Marked session");
    sessionManager.setAgentId("sess-marked", "claude");
    sessionManager.setAgentPinned("sess-marked");
    writeToken(sessionRoot("sess-marked"), "own-y");
    writeSessionAccountMarker(credentialsDir, "sess-marked", "claude", y.id);

    sessionManager.track("sess-unmarked", "Pre-260 session");
    sessionManager.setAgentId("sess-unmarked", "claude");
    sessionManager.setAgentPinned("sess-unmarked");
    writeToken(sessionRoot("sess-unmarked"), "own-unmarked");

    authManager.emit("complete");

    expect(readToken(sessionRoot("sess-marked"))).toBe("own-y");
    expect(readToken(sessionRoot("sess-unmarked"))).toBe("own-unmarked");
  });

  it("keeps a foreign flat-root token out of an account root even when it is the fresher of the two", async () => {
    const accountRoot = (accountId: string): string =>
      path.join(credentialsDir, "provider-accounts", "claude", accountId);
    const sessionRoot = (sessionId: string): string =>
      path.join(credentialsDir, "sessions", sessionId);
    const tokenFile = (root: string): string => path.join(root, ".claude", ".credentials.json");
    const writeToken = (root: string, token: string, expiresAt: number): void => {
      fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
      fs.writeFileSync(tokenFile(root), JSON.stringify({ claudeAiOauth: { expiresAt, accessToken: token } }));
    };
    const readToken = (root: string): string =>
      (JSON.parse(fs.readFileSync(tokenFile(root), "utf-8")) as {
        claudeAiOauth: { accessToken: string };
      }).claudeAiOauth.accessToken;

    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const y = accounts.create("anthropic", "Account Y");
    const soon = Date.now() + 3_600_000;
    const later = Date.now() + 36_000_000;

    writeToken(accountRoot(y.id), "own-y", soon);
    writeToken(credentialsDir, "flat-root-token", later);

    sessionManager.track("sess-marked", "Marked session");
    sessionManager.setAgentId("sess-marked", "claude");
    sessionManager.setAgentPinned("sess-marked");
    writeToken(sessionRoot("sess-marked"), "own-y", soon);
    writeSessionAccountMarker(credentialsDir, "sess-marked", "claude", y.id);

    authManager.emit("complete");

    // A matching marker cannot detect a foreign token copied into the session.
    syncProviderAccountTokenBack(credentialsDir, "sess-marked", "claude", y.id);

    expect(readToken(accountRoot(y.id))).toBe("own-y");
    expect(readToken(sessionRoot("sess-marked"))).toBe("own-y");
  });
});
