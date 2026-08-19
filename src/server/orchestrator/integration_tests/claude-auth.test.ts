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
import { writeSessionAccountMarker } from "../session-credentials.js";

describe("Integration: Claude auth (OAuth & API key)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  /** The auth manager `buildApp` wired its event handlers to. */
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
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("send_message when unauthenticated returns an error pointing to Settings (no OAuth popup)", async () => {
    // Override the auth manager to be unauthenticated
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
      await client.receive(); // connection_established

      client.send({ type: "send_message", text: "hello" });
      const msg = await client.receiveType("error");

      // We no longer auto-launch the OAuth flow / pop the global sign-in
      // overlay. The turn is blocked with an actionable error that directs the
      // user to authenticate in Settings → Agents.
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
      // Simulate: after setting the env var, checkCredentials succeeds
      const ok = !!process.env.ANTHROPIC_API_KEY;
      (unauthStub as any).authenticated = ok;
      return ok;
    };

    const unauthTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-apikey-"));
    const unauthSessions = new SessionManager(dbManager);

    // Clear any existing API key
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
      await client.receive(); // connection_established

      // Use HTTP endpoint to set API key
      const res = await unauthApp.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test-key-123" },
      });
      expect(res.statusCode).toBe(200);

      // agent_auth_complete is broadcast via SSE (docs/155 Phase 2b), not WS
      // — verify the stub auth state changed.
      expect(unauthStub.authenticated).toBe(true);
      client.close();
    } finally {
      // Restore env
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

  // docs/150-multiple-provider-subscriptions reqs 16, 19 — the account-less `POST /api/auth/code` is gone.
  // Pasting an authorization code now names the account it authenticates, so
  // the credentials land in that account's root rather than in a provider-wide
  // one no row can manage. Covered in http-mutations.test.ts.
  it("does not expose an account-less paste-code endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/code",
      payload: { code: "test-auth-code-123" },
    });
    expect(res.statusCode).toBe(404);
  });

  // docs/142 A3, rescoped by docs/260 §5 — a completed sign-in force-pushes the
  // fresh source token into the sessions whose credential subtree currently
  // holds that account's copy. With session→account pinning gone (docs/260
  // reqs 1–2), "whose copy a session holds" is the subtree's own recorded
  // identity — the account MARKER written by the provisioning writer
  // (`writeSessionAccountMarker`) — never a session row. The half that needs
  // asserting is the SCOPE: re-authenticating account X must not write X's
  // token over a subtree marked as holding account Y's copy, or that session's
  // next resident process would run a different subscription than the one its
  // turn selected (and audited as).
  //
  // Driven through `buildApp`'s own `wireEventHandlers` by emitting the real
  // `complete` event, rather than calling the re-push helper directly: the
  // scoping lives in that handler (`repushTokenToPinnedSessions` in
  // app-lifecycle.ts), so calling the helper would assert nothing.
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

    // Two connected Claude accounts, each with a session whose credential
    // subtree holds (and is MARKED as holding) that account's copy. The
    // accounts are created through the same store `buildApp` was handed, so the
    // app's own `ProviderAccountManager` sees them.
    const accounts = new ProviderAccountManager({ credentialsDir, credentialStore });
    const x = accounts.create("anthropic", "Account X");
    const y = accounts.create("anthropic", "Account Y");
    writeToken(accountRoot(x.id), "fresh-x");
    writeToken(accountRoot(y.id), "source-y");

    for (const [sessionId, accountId] of [["sess-x", x.id], ["sess-y", y.id]] as const) {
      sessionManager.track(sessionId, "Claude session");
      sessionManager.setAgentId(sessionId, "claude");
      sessionManager.setAgentPinned(sessionId);
      // Each already holds its own copy — the one the CLI in the container
      // actually reads, and the only thing a re-push can repair. The marker is
      // the subtree's recorded identity: docs/260 §5 makes it, not any session
      // row, the authority on whose token the copy is.
      writeToken(sessionRoot(sessionId), `stale-${sessionId}`);
      writeSessionAccountMarker(credentialsDir, sessionId, "claude", accountId);
    }

    // And one pre-260 session holding a token with NO marker at all — its
    // identity is unknown, so an account-scoped re-push must leave it alone.
    // (It may be running on Y; force-pushing X's token there is the poisoning
    // class the marker scoping exists to close. Its next turn's env-prep
    // provisions and marks it properly.)
    sessionManager.track("sess-unmarked", "Pre-260 session");
    sessionManager.setAgentId("sess-unmarked", "claude");
    sessionManager.setAgentPinned("sess-unmarked");
    writeToken(sessionRoot("sess-unmarked"), "stale-sess-unmarked");

    // Account X finishes signing in again.
    authManager.start({ accountId: x.id });
    authManager.emit("complete");

    expect(readToken(sessionRoot("sess-x"))).toBe("fresh-x");
    // The session pinned to Y is untouched in BOTH directions: it did not get
    // X's token, and Y's own source was not pushed on X's event either.
    expect(readToken(sessionRoot("sess-y"))).toBe("stale-sess-y");
    // The unmarked subtree did not receive X's account token.
    expect(readToken(sessionRoot("sess-unmarked"))).toBe("stale-sess-unmarked");
    expect(accounts.get("anthropic", x.id)?.status).toBe("ready");
  });

  // The mirror of the test above: a `complete` that names NO account writes
  // nothing at all. It used to fall through to the flat re-push for every
  // pinned session — no marker check, source `<credentialsRoot>/.claude/…`,
  // which no account-scoped path ever refreshes — so one duplicate emission
  // (the Claude auth manager's poll+exit double `complete`, fixed in
  // `auth-manager.ts`) copied an unrelated, ageing token over the per-session
  // copy of every pinned session, including sessions marked for another
  // account and the session whose fresh token had just been delivered.
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

    // What the flat re-push would have copied: a token at the credentials root
    // belonging to nobody the router knows about.
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

    // No `start()` — the manager reports a completion with no active scope.
    authManager.emit("complete");

    expect(readToken(sessionRoot("sess-marked"))).toBe("own-y");
    expect(readToken(sessionRoot("sess-unmarked"))).toBe("own-unmarked");
  });
});
