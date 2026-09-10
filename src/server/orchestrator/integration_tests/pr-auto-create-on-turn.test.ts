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
import { RepoStore } from "../repo-store.js";
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let sessionManager: SessionManager;
let credentialStore: CredentialStore;
let repoStore: RepoStore;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;
let reArmProgressed = false;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-auto-pr-on-turn-test-");
  latestClaude = null;
  reArmProgressed = false;

  githubAuth = new StubGitHubAuthManager();
  githubAuth.setPrData(null);

  sessionManager = new SessionManager(dbManager);
  repoStore = new RepoStore(dbManager);
  credentialStore = createTestCredentialStore(tmpDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    // Stub remote operations; local Git operations use the temporary repository.
    createGitManager: (dir: string) => {
      const real = new GitManager(dir);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "push") return async () => {};
          if (prop === "forcePush") return async () => {};
          if (prop === "listRemoteBranches") return async () => ["main"];
          if (prop === "advancedBeyondMergedBase") return async () => reArmProgressed;
          if (prop === "mergedBaseProgress") {
            return async () => (reArmProgressed ? "progressed" : "base-not-contained");
          }
          if (prop === "fetch") return async () => {};
          if (prop === "fetchBranch") return async () => {};
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
    repoStore,
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
  await client.receive();
});

afterEach(async () => {
  dbManager.close();
  client.close();
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupPrimedSession(): Promise<{ sessionId: string; sessionDir: string }> {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.emit("event", {
    type: "system",
    subtype: "init",
    session_id: "agent-session-1",
  });
  claude.finish("agent-session-1");

  await client.drain({ quietMs: 150 });

  const sessionsDir = path.join(tmpDir, "sessions");
  const sessionId = fs.readdirSync(sessionsDir)[0];
  const sessionDir = path.join(sessionsDir, sessionId, "workspace");

  execSync("git remote add origin https://github.com/test-user/test-repo.git", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });
  execSync("git checkout -b shipit/test-feature", {
    cwd: sessionDir,
    env: { ...process.env, HOME: tmpDir },
  });

  sessionManager.setRemoteUrl(
    sessionId,
    "https://github.com/test-user/test-repo.git",
  );
  repoStore.add("https://github.com/test-user/test-repo.git");
  repoStore.setTrusted("https://github.com/test-user/test-repo.git", true);
  sessionManager.setBranch(sessionId, "shipit/test-feature");
  sessionManager.setBranchRenamed(sessionId, true);

  return { sessionId, sessionDir };
}

describe("auto-create PR after meaningful turn", () => {
  it(
    "auto-creates a PR on a non-new (resumed) session when files change",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const x = 1;\n");
      client.send({ type: "send_message", text: "make a feature", sessionId });

      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Added a feature" }] },
      });
      claude2.finish("agent-session-1");

      const openEvent = (await client.receiveType(
        "pr_lifecycle_update",
        5000,
      )) as WsServerMessage & { phase: string; pr?: { number: number } };
      let resolvedOpen = openEvent;
      const phases = [resolvedOpen.phase];
      while (resolvedOpen.phase !== "open") {
        resolvedOpen = (await client.receiveType(
          "pr_lifecycle_update",
          5000,
        )) as WsServerMessage & { phase: string; pr?: { number: number } };
        phases.push(resolvedOpen.phase);
      }
      expect(phases).toContain("creating");
      expect(phases).toContain("open");
      expect(resolvedOpen.pr?.number).toBe(1);
    },
  );

  it(
    "re-arms a merged session whose branch was rebased + progressed (docs/202, WS post-turn)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      const mergedSummary = {
        sessionId,
        prNumber: 999,
        prUrl: "https://github.com/test-user/test-repo/pull/999",
        prTitle: "Old shipped PR",
        prBody: "",
        prState: "merged" as const,
        baseBranch: "main",
        headBranch: "shipit/test-feature",
        insertions: 1,
        deletions: 0,
        checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: "unknown" as const,
        reviewDecision: "none" as const,
        autoMergeEnabled: false,
      };
      sessionManager.markMerged(sessionId);
      sessionManager.setPrStatus(sessionId, mergedSummary);
      app.prStatusPoller!.loadPersisted();
      reArmProgressed = true;

      fs.writeFileSync(path.join(sessionDir, "next.ts"), "export const y = 2;\n");
      client.send({ type: "send_message", text: "more work", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "did more" }] },
      });
      claude2.finish("agent-session-1");

      let evt = (await client.receiveType("pr_lifecycle_update", 5000)) as WsServerMessage & {
        phase: string;
        previousMergedPr?: { number: number };
      };
      const phases = [evt.phase];
      while (evt.phase !== "open" && phases.length < 6) {
        evt = (await client.receiveType("pr_lifecycle_update", 5000)) as typeof evt;
        phases.push(evt.phase);
      }
      expect(phases).toContain("open");
      expect(evt.previousMergedPr?.number).toBe(999);

      const after = sessionManager.get(sessionId);
      expect(after?.mergedAt).toBeFalsy();
      expect(after?.previousMergedPr?.number).toBe(999);
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

      // A quiet period alone can end before the PR flow starts.
      const messages = await client.collectUntil(
        (m) => m.type === "pr_lifecycle_update" && (m as { phase?: string }).phase === "ready",
        { quietMs: 250 },
      );
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

      client.send({ type: "send_message", text: "tell me a joke", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "haha" }] },
      });
      claude2.finish("agent-session-1");

      const messages = await client.drain({ quietMs: 250 });
      const phases = messages
        .filter((m) => m.type === "pr_lifecycle_update")
        .map((m) => (m as { phase: string }).phase);
      expect(phases).not.toContain("creating");
      expect(phases).not.toContain("ready");
    },
  );

  it(
    "does not auto-create when GitHub is not authenticated",
    { timeout: 15_000 },
    async () => {
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "x");
      client.send({ type: "send_message", text: "make a feature", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.finish("agent-session-1");

      const messages = await client.drain({ quietMs: 250 });
      const phases = messages
        .filter((m) => m.type === "pr_lifecycle_update")
        .map((m) => (m as { phase: string }).phase);
      expect(phases).not.toContain("creating");
    },
  );
});
