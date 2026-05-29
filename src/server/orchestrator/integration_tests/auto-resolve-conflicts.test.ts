/**
 * Integration tests for docs/146 auto-resolve-conflicts-on-idle.
 *
 * These bypass the GraphQL polling layer and drive
 * `prStatusPoller.autoConflictResolveManager.handleTransition` directly so we
 * exercise the manager → rebase wrapper → rebase-driver → runner → fake agent
 * wiring end-to-end. The polling layer is covered by `pr-status.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildApp } from "../index.js";
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
import { MAX_AUTO_RESOLVE_ATTEMPTS } from "../auto-conflict-resolve-manager.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let credentialStore: CredentialStore;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;
let port: number;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-auto-resolve-test-");
  latestClaude = null;
  process.env.GIT_EDITOR = "true";

  githubAuth = new StubGitHubAuthManager();
  credentialStore = createTestCredentialStore(tmpDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    agentFactory: () => {
      const c = new FakeClaudeProcess();
      latestClaude = c;
      return c as unknown as never;
    },
    authManager: new StubAuthManager() as unknown as never,
    githubAuthManager: githubAuth as unknown as never,
    sessionManager: new SessionManager(dbManager),
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    autoPushDebounceMs: 100,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  client = await TestClient.connect(port);
  await client.receive(); // initial preview_status
});

afterEach(async () => {
  dbManager.close();
  client.close();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createSession(): Promise<{ sessionId: string; sessionDir: string }> {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.emit("event", { type: "system", subtype: "init", session_id: "test-session-1" });
  claude.finish("test-session-1");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await client.receive(500); } catch { break; }
  }
  const sessionsDir = path.join(tmpDir, "sessions");
  const sessionId = fs.readdirSync(sessionsDir)[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");
  return { sessionId, sessionDir };
}

function setupConflictingDivergence(sessionDir: string): string {
  const env = { ...process.env, HOME: tmpDir };
  const bareDir = path.join(tmpDir, "bare-remote.git");
  fs.mkdirSync(bareDir, { recursive: true });
  execSync("git init --bare -b main", { cwd: bareDir, env });
  execSync(`git remote add origin ${bareDir}`, { cwd: sessionDir, env });
  fs.writeFileSync(path.join(sessionDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m 'Add shared'", { cwd: sessionDir, env });
  execSync("git push -u origin main", { cwd: sessionDir, env });
  execSync("git checkout -b feature", { cwd: sessionDir, env });
  fs.writeFileSync(path.join(sessionDir, "shared.txt"), "feature edit\n");
  execSync("git add -A && git commit -m 'Feature commit'", { cwd: sessionDir, env });
  execSync("git push -u origin feature", { cwd: sessionDir, env });
  const tempClone = path.join(tmpDir, "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, env });
  execSync("git checkout main", { cwd: tempClone, env });
  fs.writeFileSync(path.join(tempClone, "shared.txt"), "upstream edit\n");
  execSync("git add -A && git commit -m 'Upstream commit'", { cwd: tempClone, env });
  execSync("git push", { cwd: tempClone, env });
  fs.rmSync(tempClone, { recursive: true, force: true });
  return bareDir;
}

function makeConflictingSummary(sessionId: string): PrStatusSummary {
  return {
    sessionId,
    prNumber: 1,
    prUrl: "https://github.com/test-user/test-repo/pull/1",
    prTitle: "Test PR",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "feature",
    insertions: 0,
    deletions: 0,
    checks: { state: "success", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "conflicting",
    autoMergeEnabled: false,
  };
}

async function collectMessages(timeoutMs = 3000): Promise<WsServerMessage[]> {
  const messages: WsServerMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      messages.push(await client.receive(Math.max(50, deadline - Date.now())));
    } catch { break; }
  }
  return messages;
}

async function waitForMessage(type: string, timeoutMs = 5000): Promise<WsServerMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.receive(Math.max(100, deadline - Date.now()));
    if (msg.type === type) return msg;
  }
  throw new Error(`Timed out waiting for "${type}" message`);
}

describe("auto-resolve-conflicts integration", () => {
  it("1. happy path: conflicting transition with idle agent → fires the rebase + emits success", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);

    const claudeBefore = latestClaude;
    const manager = app.prStatusPoller?.autoConflictResolveManager;
    expect(manager).toBeDefined();
    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

    await waitForMessage("auto_resolve_started");
    await waitForMessage("rebase_started");
    await waitForMessage("rebase_conflicts");

    const conflictAgent = await waitForClaude(() => latestClaude, claudeBefore);
    fs.writeFileSync(path.join(sessionDir, "shared.txt"), "merged\n");
    conflictAgent.finish("test-session-1");

    await waitForMessage("rebase_complete", 10_000);
    const result = await waitForMessage("auto_resolve_result", 5_000);
    expect(result).toMatchObject({ type: "auto_resolve_result", outcome: "success", attempt: 1 });
  });

  it("2. setting off → no rebase invocation", { timeout: 10_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(false);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);

    const claudeBefore = latestClaude;
    const manager = app.prStatusPoller?.autoConflictResolveManager;
    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

    const messages = await collectMessages(1500);
    expect(messages.find((m) => m.type === "auto_resolve_started")).toBeUndefined();
    expect(messages.find((m) => m.type === "rebase_started")).toBeUndefined();
    // No new agent was created beyond the setup one.
    expect(latestClaude).toBe(claudeBefore);
  });

  it("3. no GitHub auth → wrapper short-circuits deferred; agent NOT spawned, no budget burn", { timeout: 10_000 }, async () => {
    // No setToken() — wrapper sees authenticated=false.
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);

    const claudeBefore = latestClaude;
    const manager = app.prStatusPoller?.autoConflictResolveManager;
    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

    // Give the wrapper microtasks time to land.
    await new Promise((r) => setTimeout(r, 200));
    expect(latestClaude).toBe(claudeBefore);
    expect(manager!.get(sessionId)?.attemptCount).toBe(0);
    expect(manager!.get(sessionId)?.status).toBe("deferred");
    expect(manager!.get(sessionId)?.lastError).toBe("no_github_auth");
  });

  it("4. three failed attempts in a row → exhausted; envelope carries lastError", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);

    const manager = app.prStatusPoller?.autoConflictResolveManager;
    // Drive three errored attempts. We simulate "agent errors" by having the
    // FakeClaudeProcess emit an error event right after spawn — that lands as
    // a real-work error (didSpawn=true).
    for (let i = 0; i < MAX_AUTO_RESOLVE_ATTEMPTS; i++) {
      const claudeBefore = latestClaude;
      // Bypass cooldown between attempts so the test runs fast.
      const state = manager!.get(sessionId);
      if (state) delete state.nextEligibleAt;
      await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

      // Wait for the agent to be spawned, then crash it.
      const agent = await waitForClaude(() => latestClaude, claudeBefore);
      // Force-error by emitting error event directly. The rebase-driver
      // surfaces this to the wrapper as a post-spawn throw.
      agent.emit("error", new Error("boom"));
      // Give writeBack time to land.
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(manager!.get(sessionId)?.status).toBe("exhausted");
    expect(manager!.get(sessionId)?.attemptCount).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
    // Snapshot should reflect exhausted.
    const summary = app.prStatusPoller!.getAllStatuses().find((s) => s.sessionId === sessionId);
    // Snapshot might be undefined if status was never set via lastKnown — in that
    // case the manager state is the source of truth (the snapshot path requires
    // the GraphQL poll to have run, which we skip here).
    if (summary?.autoResolve) {
      expect(summary.autoResolve.status).toBe("exhausted");
      expect(summary.autoResolve.attemptCount).toBe(MAX_AUTO_RESOLVE_ATTEMPTS);
    }
  });

  it("5. timeout: agent never finishes → wrapper tears down + records error", { timeout: 10_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);

    // Override the wrapper's timeout via a per-call deps shim. We do this by
    // replacing the manager's rebaseAndResolveCb with one that wraps the real
    // attempt at a 1s timeout for this test.
    const manager = app.prStatusPoller?.autoConflictResolveManager;
    const { runAutoResolveAttempt } = await import("../services/rebase-driver.js");
    const claudeBefore = latestClaude;

    manager!.setRebaseAndResolveCb(async (sid, base) => {
      const runner = app.runnerRegistry.get(sid)!;
      const { GitManager } = await import("../../shared/git.js");
      const git = new GitManager(runner.sessionDir);
      return await runAutoResolveAttempt(
        {
          git,
          githubAuthManager: githubAuth as unknown as never,
          runner,
          sessionManager: app.sessionManager,
          chatHistoryManager: app.chatHistoryManager,
          usageManager: app.usageManager,
          authManager: new StubAuthManager() as unknown as never,
          sseBroadcast: () => { /* noop */ },
          // Match the production wrapper closure: in-process runners need
          // the fallback factory because they don't supply `createAgent`.
          agentFactory: () => {
            const c = new FakeClaudeProcess();
            latestClaude = c;
            return c as unknown as never;
          },
          timeoutMs: 800,
        },
        base,
      );
    });

    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

    // Wait for the agent to spawn, but never finish it — the timeout fires.
    await waitForClaude(() => latestClaude, claudeBefore);
    // The wrapper's timeout will fire after 800ms.
    await new Promise((r) => setTimeout(r, 1500));

    const state = manager!.get(sessionId);
    expect(state?.lastError).toBe("timeout");
    // Runner state is reset by the teardown.
    const runner = app.runnerRegistry.get(sessionId);
    expect(runner?.running).toBe(false);
    expect(runner?.systemTurnInProgress).toBe(false);
    expect(runner?.getAgent()).toBeNull();
  });

  it("6. dirty tree pre-flight → deferred with no agent spawn, no budget burn", { timeout: 10_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);
    // Make the tree dirty so the pre-flight defers.
    fs.writeFileSync(path.join(sessionDir, "uncommitted.txt"), "uncommitted\n");

    const claudeBefore = latestClaude;
    const manager = app.prStatusPoller?.autoConflictResolveManager;
    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");

    await new Promise((r) => setTimeout(r, 500));
    expect(latestClaude).toBe(claudeBefore);
    expect(manager!.get(sessionId)?.attemptCount).toBe(0);
    expect(manager!.get(sessionId)?.lastError).toBe("dirty_tree");
  });

  it("7. agent busy when conflict detected → deferred; idle event triggers attempt", { timeout: 20_000 }, async () => {
    await githubAuth.setToken("test-token");
    credentialStore.setAutoResolveConflicts(true);
    const { sessionId, sessionDir } = await createSession();
    setupConflictingDivergence(sessionDir);
    const manager = app.prStatusPoller?.autoConflictResolveManager;

    // Force runner.running = true to simulate a user turn in flight.
    const runner = app.runnerRegistry.get(sessionId)!;
    runner.running = true;

    await manager!.handleTransition(sessionId, makeConflictingSummary(sessionId), "main", "sha-1");
    expect(manager!.get(sessionId)?.status).toBe("deferred");

    // Simulate the user turn finishing — runner emits "idle".
    runner.running = false;
    runner.onAgentFinished();

    // Give onRunnerIdle time to land.
    const claudeBefore = latestClaude;
    await new Promise((r) => setTimeout(r, 300));
    // A new agent was spawned for the resolution turn.
    expect(latestClaude).not.toBe(claudeBefore);
  });
});
