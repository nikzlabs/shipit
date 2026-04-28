/**
 * Integration tests for auto-create PR after a meaningful agent turn.
 *
 * The setting `credentialStore.autoCreatePr` (off by default) gates the
 * behavior. When on, every turn that produces a non-empty commit AND has no
 * existing PR for the branch should trigger `quickCreatePr` and emit the
 * "creating" → "open" lifecycle phases.
 *
 * Previously this only fired for the first turn of a brand-new session
 * (`isNewSession === true`). Doc 099 widens it to fire for any meaningful turn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { UsageManager } from "../usage.js";
import { CredentialStore } from "../credential-store.js";
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let sessionManager: SessionManager;
let credentialStore: CredentialStore;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-auto-pr-on-turn-test-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();
  githubAuth.setPrData(null); // No pre-existing PR

  sessionManager = new SessionManager(dbManager);
  credentialStore = createTestCredentialStore(tmpDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    // Stub push + listRemoteBranches so quickCreatePr can run without a real
    // remote. Other GitManager calls (commit, addRemote, getCurrentBranch,
    // diffStatVsBranch) hit the real git binary on the temp repo.
    createGitManager: (dir: string) => {
      const real = new GitManager(dir);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "push") return async () => {};
          if (prop === "listRemoteBranches") return async () => ["main"];
          return (target as never)[prop as never];
        },
      });
    },
    agentFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as any;
    },
    authManager: new StubAuthManager() as any,
    githubAuthManager: githubAuth as any,
    sessionManager,
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    generateText: async () =>
      "## Summary\nTest changes.\n\n## Changes\n- Added feature",
    autoPushDebounceMs: 100,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  client = await TestClient.connect(port);
  await client.receive(); // initial preview_status
});

afterEach(async () => {
  dbManager.close();
  client.close();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the first turn to bring the session into existence on disk, then
 * configure the session so subsequent turns will satisfy all auto-create
 * preconditions (remote URL, renamed branch, GitHub URL on git origin,
 * checked out feature branch).
 */
async function setupPrimedSession(): Promise<{ sessionId: string; sessionDir: string }> {
  // First turn — creates the session directory + initial commit
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.emit("event", {
    type: "system",
    subtype: "init",
    session_id: "agent-session-1",
  });
  claude.finish("agent-session-1");

  // Drain the first turn's messages
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await client.receive(500);
    } catch {
      break;
    }
  }

  const sessionsDir = path.join(tmpDir, "sessions");
  const sessionId = fs.readdirSync(sessionsDir)[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");

  // Configure remote on the actual git repo and on session metadata
  execSync("git remote add origin https://github.com/test-user/test-repo.git", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });
  // Switch to a feature branch so quickCreatePr's head !== base
  execSync("git checkout -b shipit/test-feature", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager.setRemoteUrl(
    sessionId,
    "https://github.com/test-user/test-repo.git",
  );
  sessionManager.setBranch(sessionId, "shipit/test-feature");
  sessionManager.setBranchRenamed(sessionId, true);

  return { sessionId, sessionDir };
}

async function drainMessages(timeoutMs = 2500): Promise<WsServerMessage[]> {
  const messages: WsServerMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msg = await client.receive(Math.max(100, deadline - Date.now()));
      messages.push(msg);
    } catch {
      break;
    }
  }
  return messages;
}

describe("auto-create PR after meaningful turn", () => {
  it(
    "auto-creates a PR on a non-new (resumed) session when files change",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      // Second turn — isNewSession=false because msg.sessionId is set
      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const x = 1;\n");
      client.send({ type: "send_message", text: "make a feature", sessionId });

      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Added a feature" }] },
      });
      claude2.finish("agent-session-1");

      const messages = await drainMessages(5000);
      const lifecycleEvents = messages.filter(
        (m) => m.type === "pr_lifecycle_update",
      ) as (WsServerMessage & { phase: string; pr?: { number: number } })[];

      const phases = lifecycleEvents.map((e) => e.phase);
      expect(phases).toContain("creating");
      expect(phases).toContain("open");

      const openEvent = lifecycleEvents.find((e) => e.phase === "open");
      expect(openEvent?.pr?.number).toBe(1);
    },
  );

  it(
    "emits 'ready' (not 'creating') when the auto-create setting is off",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(false);
      const { sessionId, sessionDir } = await setupPrimedSession();

      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "x");
      client.send({ type: "send_message", text: "make a feature", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "did it" }] },
      });
      claude2.finish("agent-session-1");

      const messages = await drainMessages();
      const phases = messages
        .filter((m) => m.type === "pr_lifecycle_update")
        .map((m) => (m as { phase: string }).phase);
      expect(phases).toContain("ready");
      expect(phases).not.toContain("creating");
    },
  );

  it(
    "does not auto-create when the turn produced no commit",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId } = await setupPrimedSession();

      // Second turn — DO NOT write any file, so autoCommit returns null
      client.send({ type: "send_message", text: "tell me a joke", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "haha" }] },
      });
      claude2.finish("agent-session-1");

      const messages = await drainMessages();
      const phases = messages
        .filter((m) => m.type === "pr_lifecycle_update")
        .map((m) => (m as { phase: string }).phase);
      // Neither a "creating" nor a "ready" card — the post-commit block is
      // entirely skipped because there is no commit.
      expect(phases).not.toContain("creating");
      expect(phases).not.toContain("ready");
    },
  );

  it(
    "does not auto-create when GitHub is not authenticated",
    { timeout: 15_000 },
    async () => {
      // Note: no setToken() call
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "x");
      client.send({ type: "send_message", text: "make a feature", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.finish("agent-session-1");

      const messages = await drainMessages();
      const phases = messages
        .filter((m) => m.type === "pr_lifecycle_update")
        .map((m) => (m as { phase: string }).phase);
      expect(phases).not.toContain("creating");
    },
  );
});
