/**
 * Integration tests for the agent-driven PR creation path (doc 116, Phase 2).
 *
 * Three things must hold:
 *
 * 1. When `autoCreatePr` is on and GitHub is connected, the agent's system
 *    prompt nudges it to run `gh pr create -t … -b …`. The shim path is
 *    structurally testable (this is what the agent sees on its turn).
 *
 * 2. When the agent calls `gh pr create` (which the shim brokers as an HTTP
 *    request to `POST /api/sessions/:id/pr/agent-create`), the orchestrator
 *    routes through `agentCreatePr` → `GitHubAuthManager.createPullRequest`
 *    with the agent-supplied title and body — *not* the harness-side
 *    LLM-derived description.
 *
 * 3. The dedup story holds: if the agent has already created a PR for the
 *    branch, the harness backstop's `quickCreatePr` short-circuits via
 *    `findPullRequest` and does not double-create.
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
let port: number;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-agent-driven-pr-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();
  githubAuth.setPrData(null); // No pre-existing PR

  sessionManager = new SessionManager(dbManager);
  credentialStore = createTestCredentialStore(tmpDir);

  app = await buildApp({
    credentialStore,
    workspaceDir: tmpDir,
    // Stub push + listRemoteBranches so agentCreatePr/quickCreatePr can run
    // without a real remote. Other GitManager calls (commit, addRemote,
    // getCurrentBranch, diffStatVsBranch) hit the real git binary on the temp repo.
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
      return c as never;
    },
    authManager: new StubAuthManager() as never,
    githubAuthManager: githubAuth as never,
    sessionManager,
    chatHistoryManager: new ChatHistoryManager(dbManager),
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    // The harness fallback's generateText. We deliberately make this return
    // a sentinel so we can detect when the harness path was used vs. the
    // agent-driven path.
    generateText: async () => "[harness-generated description]",
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

/**
 * Run the first turn to bring the session into existence on disk, then
 * configure the session so subsequent turns satisfy auto-create preconditions
 * (remote URL, renamed branch, GitHub URL on git origin, checked out feature
 * branch).
 *
 * Mirrors the helper in pr-auto-create-on-turn.test.ts so the two test files
 * exercise the same setup.
 */
async function setupPrimedSession(): Promise<{ sessionId: string; sessionDir: string }> {
  client.send({ type: "send_message", text: "hello" });
  const claude = await waitForClaude(() => latestClaude);
  claude.emit("event", {
    type: "system",
    subtype: "init",
    session_id: "agent-session-1",
  });
  claude.finish("agent-session-1");

  // Drain first turn
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

describe("agent-driven PR creation (Phase 2)", () => {
  it(
    "agent system prompt nudges `gh pr create` when autoCreatePr is on and GitHub is connected",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);

      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => latestClaude);

      // The system prompt is captured synchronously when run() is called.
      expect(claude.lastSystemPrompt).toBeTruthy();
      expect(claude.lastSystemPrompt).toContain("## Pull requests");
      expect(claude.lastSystemPrompt).toContain("gh pr create");
      expect(claude.lastSystemPrompt).toContain("## Summary");
      expect(claude.lastSystemPrompt).toContain("## Test plan");

      claude.finish("agent-session-1");
    },
  );

  it(
    "agent system prompt does NOT nudge `gh pr create` when autoCreatePr is off",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(false);

      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => latestClaude);

      expect(claude.lastSystemPrompt).toBeTruthy();
      expect(claude.lastSystemPrompt).not.toContain("## Pull requests");
      expect(claude.lastSystemPrompt).not.toContain("gh pr create");

      claude.finish("agent-session-1");
    },
  );

  it(
    "agent system prompt does NOT nudge `gh pr create` when GitHub is not connected (even if autoCreatePr is on)",
    { timeout: 15_000 },
    async () => {
      // Note: no setToken() call. Without GitHub auth, the gh shim would fail
      // at runtime — so we don't ask the agent to use it.
      credentialStore.setAutoCreatePr(true);

      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => latestClaude);

      expect(claude.lastSystemPrompt).toBeTruthy();
      expect(claude.lastSystemPrompt).not.toContain("gh pr create");

      claude.finish("agent-session-1");
    },
  );

  it(
    "agent calling POST /pr/agent-create routes to GitHubAuthManager with agent-supplied title and body",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();

      // Simulate what the gh shim does: POST to the orchestrator endpoint.
      // (The shim → worker → orchestrator hops are covered by their own
      // unit tests; here we verify the orchestrator end of the chain.)
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Add the widget",
          body: "## Summary\nAdd a widget.\n\n## Changes\n- new widget\n\n## Test plan\n- click it",
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.number).toBe(1);
      expect(result.alreadyExisted).toBe(false);

      // The stub recorded exactly the title and body the agent passed —
      // not a harness-generated description.
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.title).toBe("Add the widget");
      expect(call.body).toBe(
        "## Summary\nAdd a widget.\n\n## Changes\n- new widget\n\n## Test plan\n- click it",
      );
      expect(call.body).not.toContain("[harness-generated description]");
      expect(call.head).toBe("shipit/test-feature");
      expect(call.base).toBe("main");
    },
  );

  it(
    "harness backstop short-circuits when the agent has already created a PR (dedup)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

      // 1. Agent (via shim) creates a PR mid-turn.
      const createRes = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Agent PR",
          body: "## Summary\nDone by the agent.",
        },
      });
      expect(createRes.statusCode).toBe(200);
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);

      // After the agent's create, simulate findPullRequest now returning
      // the open PR for the branch. The real Octokit-backed manager would
      // observe this naturally; the stub needs the prompt.
      githubAuth.setPrData({
        url: "https://github.com/test-user/test-repo/pull/1",
        number: 1,
        base: "main",
        title: "Agent PR",
      });

      // 2. Agent finishes the turn with a real file change. The harness
      //    post-turn block runs `quickCreatePr`, which should short-circuit
      //    because findPullRequest now returns the existing PR.
      fs.writeFileSync(path.join(sessionDir, "feature.ts"), "export const x = 1;\n");
      client.send({ type: "send_message", text: "make a feature", sessionId });
      const prev = latestClaude;
      const claude2 = await waitForClaude(() => latestClaude, prev);
      claude2.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "added a feature" }] },
      });
      claude2.finish("agent-session-1");

      await drainMessages(3000);

      // No second create — the agent's call is the only one recorded.
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      expect(githubAuth.createPullRequestCalls[0].title).toBe("Agent PR");
      // Crucially, no harness-generated body sneaks in either.
      expect(githubAuth.createPullRequestCalls[0].body).not.toContain(
        "[harness-generated description]",
      );
    },
  );

  // Regression test for the ordering bug described in CLAUDE.md note about
  // gh pr create: the agent calls `gh pr create` mid-turn, *before* the
  // end-of-turn `postTurnCommit` has fired. Without the flush, the new PR
  // would be opened against the branch's previously-committed state and the
  // agent's just-made edits would not appear on the PR.
  it(
    "/pr/agent-create commits pending working-tree changes before opening the PR",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

      // Sanity: working tree is clean after the primed session.
      const headBefore = execSync("git rev-parse HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(
        execSync("git status --porcelain", {
          cwd: sessionDir,
          env: { ...process.env, HOME: tmpDir },
        }).toString().trim(),
      ).toBe("");

      // Simulate the agent making a file edit mid-turn. At this point the
      // change is on disk but NOT yet committed — that's the bug class this
      // test guards against.
      fs.writeFileSync(path.join(sessionDir, "widget.ts"), "export const widget = 42;\n");

      // The shim's POST to /pr/agent-create. The flush should commit the
      // pending change before pushing and opening the PR.
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Add widget",
          body: "## Summary\nAdds the widget.",
        },
      });
      expect(res.statusCode).toBe(200);

      // The PR was opened (createPullRequest was called).
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);

      // Working tree is now clean — the edit was committed.
      expect(
        execSync("git status --porcelain", {
          cwd: sessionDir,
          env: { ...process.env, HOME: tmpDir },
        }).toString().trim(),
      ).toBe("");

      // HEAD advanced — a new commit exists for the flushed change.
      const headAfter = execSync("git rev-parse HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(headAfter).not.toBe(headBefore);

      // The new commit contains the widget file.
      const filesInCommit = execSync(`git show --name-only --pretty=format: ${headAfter}`, {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(filesInCommit).toContain("widget.ts");
    },
  );

});
