import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import { CodexAuthManager } from "../agents/codex/auth-manager.js";
import { ProviderAccountManager } from "../provider-account-manager.js";
import { listConfiguredCredentials } from "../service-routing.js";
import type { CredentialStore } from "../credential-store.js";
import { StubAuthManager, createTestCredentialStore, createTestDatabaseManager } from "./test-helpers.js";

describe("a sign-in that an orchestrator restart interrupted (docs/150)", () => {
  let tmpDir: string;
  let store: CredentialStore;
  let accounts: ProviderAccountManager;
  let app: FastifyInstance | null = null;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-interrupted-sign-in-"));
    store = createTestCredentialStore(tmpDir);
    accounts = new ProviderAccountManager({ credentialsDir: tmpDir, credentialStore: store });
    savedSessionId = process.env.SHIPIT_SESSION_ID;
    delete process.env.SHIPIT_SESSION_ID;
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedSessionId === undefined) delete process.env.SHIPIT_SESSION_ID;
    else process.env.SHIPIT_SESSION_ID = savedSessionId;
  });

  async function start(agentRegistry?: AgentRegistry): Promise<void> {
    const dbManager = createTestDatabaseManager();
    app = await buildApp({
      credentialStore: store,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      codexAuthManager: new CodexAuthManager({
        spawn: () => { throw new Error("no login process may start in this test"); },
      }),
      ...(agentRegistry ? { agentRegistry } : {}),
      credentialsDir: tmpDir,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  }

  it("is ended at start-up as a cancel would end it", async () => {
    const kept = accounts.create("openai", "Kept");
    const lost = accounts.create("openai", "Lost");
    const failed = accounts.create("openai", "Failed");
    for (const id of [kept.id, lost.id]) accounts.setAccountStatus("openai", id, "authenticating");
    accounts.setAccountStatus("openai", failed.id, "auth_failed");
    const authFile = path.join(accounts.resolveCredentialRoot("codex", kept.id), ".codex", "auth.json");
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, "{}");

    await start();

    expect(accounts.get("openai", kept.id)?.status).toBe("ready");
    expect(accounts.get("openai", lost.id)?.status).toBe("unavailable");
    expect(accounts.get("openai", failed.id)?.status).toBe("auth_failed");
  });

  it("is ended before agent detection, which counts a row signing in as a credential", async () => {
    const lost = accounts.create("openai", "Lost");
    accounts.setAccountStatus("openai", lost.id, "authenticating");
    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "codex",
      listCredentials: () => listConfiguredCredentials(store),
    });
    const codexRunnable = () => registry.list().find((agent) => agent.id === "codex")?.hasRunnableModels;
    await registry.detect();
    expect(codexRunnable()).toBe(true);

    await start(registry);

    expect(codexRunnable()).toBe(false);
  });
});
