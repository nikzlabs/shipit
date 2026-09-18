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
import { AgentMergeClaimStore } from "../agent-merge-claims.js";
import type { WsServerMessage } from "../../shared/types.js";

let tmpDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let client: TestClient;
let githubAuth: StubGitHubAuthManager;
let sessionManager: SessionManager;
let chatHistoryManager: ChatHistoryManager;
let credentialStore: CredentialStore;
let repoStore: RepoStore;
let latestClaude: FakeClaudeProcess | null = null;
let dbManager: DatabaseManager;
let port: number;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync("/tmp/shipit-agent-driven-pr-");
  latestClaude = null;

  githubAuth = new StubGitHubAuthManager();
  githubAuth.setPrData(null);

  sessionManager = new SessionManager(dbManager);
  chatHistoryManager = new ChatHistoryManager(dbManager);
  credentialStore = createTestCredentialStore(tmpDir);
  repoStore = new RepoStore(dbManager);

  app = await buildApp({
    // Share the session database so internally created stores can resolve foreign keys.
    databaseManager: dbManager,
    credentialStore,
    credentialsDir: path.join(tmpDir, "credentials"),
    workspaceDir: tmpDir,
    // Use real local Git operations and stub remote operations.
    createGitManager: (dir: string) => {
      const real = new GitManager(dir);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "push") return async () => {};
          if (prop === "forcePush") return async () => {};
          if (prop === "listRemoteBranches") return async () => ["main"];
          // Tests set origin/main directly; fetching would fail before the progress gate.
          if (prop === "fetch") return async () => {};
          if (prop === "fetchBranch") return async () => {};
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
    repoStore,
    chatHistoryManager,
    usageManager: new UsageManager(dbManager),
    serveStatic: false,
    generateText: async () => "[harness-generated description]",
    autoPushDebounceMs: 100,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
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
  repoStore.add("https://github.com/test-user/test-repo.git");
  repoStore.setTrusted("https://github.com/test-user/test-repo.git", true);
  sessionManager.setBranch(sessionId, "shipit/test-feature");
  sessionManager.setBranchRenamed(sessionId, true);

  return { sessionId, sessionDir };
}

async function withLiveTurn<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = latestClaude;
  client.send({ type: "send_message", text: "merge it", sessionId });
  const claude = await waitForClaude(() => latestClaude, previous);
  try {
    return await fn();
  } finally {
    claude.finish("agent-session-1");
    await drainMessages(1500);
  }
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
    "agent system prompt unconditionally nudges `gh pr create`",
    { timeout: 15_000 },
    async () => {
      client.send({ type: "send_message", text: "hello" });
      const claude = await waitForClaude(() => latestClaude);

      expect(claude.lastSystemPrompt).toBeTruthy();
      expect(claude.lastSystemPrompt).toContain("## Pull requests");
      expect(claude.lastSystemPrompt).toContain("gh pr create");
      expect(claude.lastSystemPrompt).toContain("## Summary");
      expect(claude.lastSystemPrompt).toContain("## Test plan");

      claude.finish("agent-session-1");
    },
  );

  it(
    "agent calling POST /pr/agent-create routes to GitHubAuthManager with agent-supplied title and body",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();

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

      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.title).toBe("Add the widget");
      expect(call.body).toBe(
        "## Summary\nAdd a widget.\n\n## Changes\n- new widget\n\n## Test plan\n- click it",
      );
      expect(call.body).not.toContain("[harness-generated description]");
      expect(call.head).toBe("shipit/test-feature");
      expect(call.base).toBe("main");

      const session = sessionManager.get(sessionId);
      expect(session?.prNumber).toBe(1);
      expect(session?.prRepoId).toBe("github:test-user/test-repo");
    },
  );

  it(
    "a pull request ShipIt only DISCOVERED is never recorded as the session's",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      githubAuth.setPrData({
        url: "https://github.com/test-user/test-repo/pull/99",
        number: 99,
        base: "main",
        title: "Opened by a person",
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/quick`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ number: 99, alreadyExisted: true });
      const session = sessionManager.get(sessionId);
      expect(session?.prNumber).toBeUndefined();
      expect(session?.prRepoId).toBeUndefined();
    },
  );

  it(
    "harness backstop short-circuits when the agent has already created a PR (dedup)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      credentialStore.setAutoCreatePr(true);
      const { sessionId, sessionDir } = await setupPrimedSession();

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

      // The stub does not update its lookup result after creation.
      githubAuth.setPrData({
        url: "https://github.com/test-user/test-repo/pull/1",
        number: 1,
        base: "main",
        title: "Agent PR",
      });

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

      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      expect(githubAuth.createPullRequestCalls[0].title).toBe("Agent PR");
      expect(githubAuth.createPullRequestCalls[0].body).not.toContain(
        "[harness-generated description]",
      );
    },
  );

  it(
    "does NOT create a duplicate PR when the branch's prior PR has already merged",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

      githubAuth.setPrData(null);
      githubAuth.setFindPrAnyStateResult({
        url: "https://github.com/test-user/test-repo/pull/9",
        number: 9,
        base: "main",
        title: "Earlier (merged) PR",
        body: "",
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
        additions: 0,
        deletions: 0,
      });
      // Supply the base ref so refusal comes from an empty diff, not a missing ref.
      execSync("git update-ref refs/remotes/origin/main HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Follow-up tweak",
          body: "## Summary\nIncidental follow-up after merge.",
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.alreadyExisted).toBe(true);
      expect(result.number).toBe(9);
      expect(result.alreadyExistedReason).toBe("merged-not-progressed");
      expect(result.notProgressedBecause).toBe("no-new-work");
      expect(githubAuth.createPullRequestCalls).toHaveLength(0);
    },
  );

  it(
    "reports merged-not-progressed when the branch has new work but the base moved on",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

      githubAuth.setPrData(null);
      githubAuth.setFindPrAnyStateResult({
        url: "https://github.com/test-user/test-repo/pull/9",
        number: 9,
        base: "main",
        title: "Earlier (merged) PR",
        body: "",
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
        additions: 0,
        deletions: 0,
      });

      const gitEnv = { ...process.env, HOME: tmpDir };
      const forkPoint = execSync("git rev-parse HEAD", { cwd: sessionDir, env: gitEnv })
        .toString().trim();
      fs.writeFileSync(path.join(sessionDir, "followup.ts"), "export const y = 2;\n");
      execSync("git add -A && git commit -m 'follow-up work'", { cwd: sessionDir, env: gitEnv });
      // Give origin/main a sibling commit that this branch does not contain.
      const tree = execSync(`git rev-parse ${forkPoint}^{tree}`, { cwd: sessionDir, env: gitEnv })
        .toString().trim();
      const movedBase = execSync(
        `git commit-tree ${tree} -p ${forkPoint} -m "another session's merge"`,
        { cwd: sessionDir, env: gitEnv },
      ).toString().trim();
      execSync(`git update-ref refs/remotes/origin/main ${movedBase}`, { cwd: sessionDir, env: gitEnv });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: { title: "Follow-up slice", body: "## Summary\nUnshipped work." },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.alreadyExisted).toBe(true);
      expect(result.number).toBe(9);
      expect(result.alreadyExistedReason).toBe("merged-not-progressed");
      expect(result.notProgressedBecause).toBe("base-not-contained");
      expect(githubAuth.createPullRequestCalls).toHaveLength(0);
    },
  );

  it(
    "creates a NEW PR when the prior PR merged but the branch progressed past base (#1357)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

      githubAuth.setPrData(null);
      githubAuth.setFindPrAnyStateResult({
        url: "https://github.com/test-user/test-repo/pull/9",
        number: 9,
        base: "main",
        title: "Earlier (merged) PR",
        body: "",
        state: "closed",
        merged_at: "2026-01-01T00:00:00Z",
        additions: 0,
        deletions: 0,
      });

      const gitEnv = { ...process.env, HOME: tmpDir };
      const baseSha = execSync("git rev-parse HEAD", { cwd: sessionDir, env: gitEnv })
        .toString().trim();
      execSync(`git update-ref refs/remotes/origin/main ${baseSha}`, { cwd: sessionDir, env: gitEnv });
      fs.writeFileSync(path.join(sessionDir, "followup.ts"), "export const y = 2;\n");
      execSync("git add -A && git commit -m 'follow-up work'", { cwd: sessionDir, env: gitEnv });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Follow-up slice",
          body: "## Summary\nNew work after the prior PR merged.",
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.alreadyExisted).toBe(false);
      expect(result.number).toBe(1);
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.title).toBe("Follow-up slice");
      expect(call.base).toBe("main");
      expect(call.head).toBe("shipit/test-feature");
    },
  );

  it(
    "applies agent-supplied labels to the new PR",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Add the widget",
          body: "## Summary\nAdd a widget.",
          labels: ["feature", "enhancement"],
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.number).toBe(1);
      expect(githubAuth.addLabelsCalls).toHaveLength(1);
      expect(githubAuth.addLabelsCalls[0]).toMatchObject({
        pullNumber: 1,
        labels: ["feature", "enhancement"],
      });
      expect(result.labelWarning).toBeUndefined();
    },
  );

  it(
    "a label that can't be applied is non-fatal — the PR is still created and a warning is surfaced",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      githubAuth.setAddLabelsResult({ success: false, message: "Label does not exist" });
      const { sessionId } = await setupPrimedSession();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Add the widget",
          body: "## Summary\nAdd a widget.",
          labels: ["nonexistent-label"],
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.number).toBe(1);
      expect(result.url).toContain("/pull/1");
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      expect(result.labelWarning).toContain("could not apply label(s) nonexistent-label");
    },
  );

  it(
    "PATCH /pr/:number adds and removes labels best-effort (gh pr edit --add-label/--remove-label)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${sessionId}/pr/12`,
        payload: { addLabels: ["enhancement"], removeLabels: ["documentation"] },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.number).toBe(12);
      expect(githubAuth.addLabelsCalls).toHaveLength(1);
      expect(githubAuth.addLabelsCalls[0]).toMatchObject({
        pullNumber: 12,
        labels: ["enhancement"],
      });
      expect(githubAuth.removeLabelCalls).toHaveLength(1);
      expect(githubAuth.removeLabelCalls[0]).toMatchObject({
        pullNumber: 12,
        label: "documentation",
      });
      expect(result.labelWarning).toBeUndefined();
    },
  );

  it(
    "PATCH /pr/:number — a label that can't be removed is non-fatal and surfaces a warning",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      githubAuth.setRemoveLabelResult({ success: false, message: "Forbidden" });
      const { sessionId } = await setupPrimedSession();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/sessions/${sessionId}/pr/12`,
        payload: { removeLabels: ["stuck-label"] },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.number).toBe(12);
      expect(result.labelWarning).toContain("could not remove label(s) stuck-label");
    },
  );

  it(
    "/pr/agent-create commits pending working-tree changes before opening the PR",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

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

      fs.writeFileSync(path.join(sessionDir, "widget.ts"), "export const widget = 42;\n");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: {
          title: "Add widget",
          body: "## Summary\nAdds the widget.",
        },
      });
      expect(res.statusCode).toBe(200);

      expect(githubAuth.createPullRequestCalls).toHaveLength(1);

      expect(
        execSync("git status --porcelain", {
          cwd: sessionDir,
          env: { ...process.env, HOME: tmpDir },
        }).toString().trim(),
      ).toBe("");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(headAfter).not.toBe(headBefore);

      const filesInCommit = execSync(`git show --name-only --pretty=format: ${headAfter}`, {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(filesInCommit).toContain("widget.ts");
    },
  );

  it(
    "/pr/agent-create links the flush commit to the final assistant message",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();

      client.send({ type: "send_message", text: "add a feature", sessionId });
      const claude = await waitForClaude(() => latestClaude, latestClaude);

      fs.writeFileSync(path.join(sessionDir, "widget.ts"), "export const widget = 42;\n");
      const headBefore = execSync("git rev-parse HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: { title: "Add widget", body: "## Summary\nAdds the widget." },
      });
      expect(res.statusCode).toBe(200);
      const headAfter = execSync("git rev-parse HEAD", {
        cwd: sessionDir,
        env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      expect(headAfter).not.toBe(headBefore);

      claude.emit("event", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Opened PR with the widget." }] },
      });
      claude.finish("agent-session-1");
      await drainMessages(2000);

      const history = chatHistoryManager.load(sessionId);
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      expect(lastAssistant?.commitHash).toBe(headAfter);
      expect(lastAssistant?.parentCommitHash).toBe(headBefore);
    },
  );

});

describe("repo-aware PR brokering (docs/211)", () => {
  async function createBareSession(): Promise<{ sessionId: string; sessionDir: string }> {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-session-1" });
    claude.finish("agent-session-1");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await client.receive(500); } catch { break; }
    }
    const sessionsDir = path.join(tmpDir, "sessions");
    const sessionId = fs.readdirSync(sessionsDir)[0];
    const sessionDir = path.join(sessionsDir, sessionId, "workspace");
    return { sessionId, sessionDir };
  }

  it(
    "builds the PR from the cwd's clone for a sandbox session (no session remoteUrl)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: false });

      const cloneDir = path.join(sessionDir, "cloned");
      fs.mkdirSync(cloneDir, { recursive: true });
      const gitEnv = { ...process.env, HOME: tmpDir };
      execSync("git init -q", { cwd: cloneDir, env: gitEnv });
      execSync("git branch -m main", { cwd: cloneDir, env: gitEnv });
      execSync("git remote add origin https://github.com/sand-user/sand-repo.git", { cwd: cloneDir, env: gitEnv });
      fs.writeFileSync(path.join(cloneDir, "a.txt"), "hi\n");
      execSync("git add -A && git commit -q -m init", { cwd: cloneDir, env: gitEnv });
      execSync("git checkout -q -b shipit/sand-feature", { cwd: cloneDir, env: gitEnv });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: { title: "Sandbox PR", body: "## Summary\nFrom the clone.", cwd: "/workspace/cloned" },
      });

      expect(res.statusCode).toBe(200);
      expect(githubAuth.createPullRequestCalls).toHaveLength(1);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.owner).toBe("sand-user");
      expect(call.repo).toBe("sand-repo");
      expect(call.head).toBe("shipit/sand-feature");
    },
  );

  it(
    "--repo targets an explicit repo from the cwd clone",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: false });

      const cloneDir = path.join(sessionDir, "wherever");
      fs.mkdirSync(cloneDir, { recursive: true });
      const gitEnv = { ...process.env, HOME: tmpDir };
      execSync("git init -q", { cwd: cloneDir, env: gitEnv });
      execSync("git branch -m main", { cwd: cloneDir, env: gitEnv });
      execSync("git remote add origin https://github.com/other/origin-repo.git", { cwd: cloneDir, env: gitEnv });
      fs.writeFileSync(path.join(cloneDir, "a.txt"), "hi\n");
      execSync("git add -A && git commit -q -m init", { cwd: cloneDir, env: gitEnv });
      execSync("git checkout -q -b shipit/x", { cwd: cloneDir, env: gitEnv });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: { title: "Explicit", body: "x", cwd: "/workspace/wherever", repo: "explicit/target" },
      });

      expect(res.statusCode).toBe(200);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.owner).toBe("explicit");
      expect(call.repo).toBe("target");
    },
  );

  it(
    "repo-bound session ignores a cwd override (behavior UNCHANGED)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/agent-create`,
        payload: { title: "Bound", body: "x", cwd: "/workspace/some-subdir" },
      });

      expect(res.statusCode).toBe(200);
      const call = githubAuth.createPullRequestCalls[0];
      expect(call.owner).toBe("test-user");
      expect(call.repo).toBe("test-repo");
      expect(call.head).toBe("shipit/test-feature");
    },
  );

  it(
    "git-credential broker denies a sandbox with GitHub access off, allows it on",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");

      sessionManager.setCapabilities(sessionId, { git: false, docker: false, network: true, dangerousGitHubOps: false });
      const denied = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/git/credential`,
        payload: { host: "github.com", protocol: "https" },
      });
      expect(denied.statusCode).toBe(403);

      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: false });
      const allowed = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/git/credential`,
        payload: { host: "github.com", protocol: "https" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ username: "x-access-token", password: "test-token" });
    },
  );

  it(
    "docs/279 — revoking GitHub access closes the brokered PR/Actions verbs too, not just the token",
    { timeout: 20_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: false, docker: false, network: true, dangerousGitHubOps: false });

      const calls: { method: "GET" | "POST" | "PATCH"; url: string; payload: Record<string, unknown> }[] = [
        { method: "POST", url: `/api/sessions/${sessionId}/pr/agent-create`, payload: { title: "x", body: "y" } },
        { method: "PATCH", url: `/api/sessions/${sessionId}/pr/1`, payload: { title: "x" } },
        { method: "POST", url: `/api/sessions/${sessionId}/pr/1/comment`, payload: { body: "x" } },
        { method: "POST", url: `/api/sessions/${sessionId}/pr/1/ready`, payload: {} },
        { method: "POST", url: `/api/sessions/${sessionId}/pr/1/close`, payload: {} },
        { method: "POST", url: `/api/sessions/${sessionId}/pr/1/reopen`, payload: {} },
        { method: "POST", url: `/api/sessions/${sessionId}/pr/1/merge`, payload: {} },
        { method: "POST", url: `/api/sessions/${sessionId}/actions/runs/rerun`, payload: { runId: 1 } },
        { method: "GET", url: `/api/sessions/${sessionId}/pr/list`, payload: {} },
        { method: "GET", url: `/api/sessions/${sessionId}/pr/view`, payload: {} },
        { method: "GET", url: `/api/sessions/${sessionId}/pr/status`, payload: {} },
        { method: "GET", url: `/api/sessions/${sessionId}/actions/runs`, payload: {} },
        { method: "GET", url: `/api/sessions/${sessionId}/actions/workflows`, payload: {} },
      ];

      for (const call of calls) {
        const res = await app.inject({
          method: call.method,
          url: call.url,
          payload: call.payload,
        });
        expect(
          { url: call.url, status: res.statusCode },
        ).toEqual({ url: call.url, status: 403 });
      }
    },
  );

  it(
    "docs/279 — the same verbs are unaffected for a sandbox with GitHub access ON",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: false });

      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list` });
      expect(res.statusCode).not.toBe(403);
    },
  );

  it(
    "git-credential broker is unaffected for a normal repo-bound session",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/git/credential`,
        payload: { host: "github.com", protocol: "https" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: "x-access-token", password: "test-token" });
    },
  );

  const REPO = "https://github.com/test-user/test-repo.git";

  it(
    "agent merge is 403 in a repo-bound session the user has not granted",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/5/merge`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("Project Settings") });
    },
  );

  it(
    "a granted repository still refuses a pull request ShipIt did not open",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/5/merge`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("no record") });
    },
  );

  it(
    "a granted repository refuses a number other than the one this session opened",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/8/merge`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("#7") });
    },
  );

  it(
    "a granted repository refuses --repo, which would retarget the merge",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: { repo: "someone/else" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("--repo") });
    },
  );

  it(
    "the session's own pull request merges, pinned to the commit the gate read",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      // Settlement needs a by-number result as well as the merge response.
      githubAuth.setPullRequestByNumber(7, {
        url: "https://github.com/test-user/test-repo/pull/7",
        number: 7, base: "main", title: "T", body: "", state: "closed",
        merged_at: "2026-09-04T12:00:00Z", merge_commit_sha: "merge-sha",
        head_sha: head, head_ref: "shipit/test-feature", additions: 1, deletions: 0,
      });

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: { cwd: "/workspace" },
      }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true });
      expect(githubAuth.mergePullRequestCalls.at(-1)).toMatchObject({
        pullNumber: 7, expectedSha: head,
      });
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toBeNull();
      const history = chatHistoryManager.load(sessionId)
        .map((m) => (m as { text?: string }).text ?? "").join("\n");
      expect(history).toContain("Merged pull request #7");
    },
  );

  it(
    "reports the merge but not a clean success when settlement cannot finish",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      // Leave the by-number lookup empty so settlement cannot finish.

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));

      expect(res.json()).toMatchObject({
        success: true,
        message: expect.stringContaining("could not finish recording"),
      });
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toMatchObject({
        prNumber: 7, state: "settling",
      });
    },
  );

  it(
    "refuses when the pull request head is not this workspace's commit (req 14)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      githubAuth.setMergeGateResult({ headRefOid: "somebody-elses-commit", rollupState: "SUCCESS" });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));
      expect(res.json()).toMatchObject({
        success: false,
        message: expect.stringContaining("not this session's current commit"),
      });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );

  it(
    "refuses failing checks, and records --auto as a request instead of merging",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      const before = githubAuth.mergePullRequestCalls.length;

      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "FAILURE" });
      const failing = await withLiveTurn(sessionId, () => app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/pr/7/merge`, payload: {},
      }));
      expect(failing.json()).toMatchObject({
        success: false, message: expect.stringContaining("failing checks"),
      });

      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "PENDING" });
      const auto = await withLiveTurn(sessionId, () => app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/pr/7/merge`, payload: { auto: true, method: "squash" },
      }));
      expect(auto.json()).toMatchObject({
        success: true, message: expect.stringContaining("once its checks pass"),
      });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toMatchObject({
        state: "pending", origin: "auto", prNumber: 7, expectedSha: head,
        method: "squash",
      });
    },
  );

  it(
    "refuses to merge when this turn's work could not be committed (req 15)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const env = { ...process.env, HOME: tmpDir };
      const run = (cmd: string) => execSync(cmd, { cwd: sessionDir, env });
      run("git branch side");
      fs.writeFileSync(path.join(sessionDir, "shared.txt"), "feature\n");
      run("git add -A && git commit -q -m 'Feature change'");
      run("git checkout -q side");
      fs.writeFileSync(path.join(sessionDir, "shared.txt"), "side\n");
      run("git add -A && git commit -q -m 'Side change'");
      run("git checkout -q shipit/test-feature");
      try {
        run("git merge side");
      } catch {
        // Expected — that is the conflicted state under test.
      }

      githubAuth.setMergeGateResult({ rollupState: "SUCCESS" });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("unresolved conflicts") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );

  it(
    "pushes the unpushed commits and answers 'not yet' rather than merging (req 17)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const env = { ...process.env, HOME: tmpDir };
      const run = (cmd: string) => execSync(cmd, { cwd: sessionDir, env }).toString().trim();
      const pushedTip = run("git rev-parse HEAD");
      fs.writeFileSync(path.join(sessionDir, "later.txt"), "work\n");
      run("git add -A && git commit -q -m 'Work GitHub has not seen'");
      run(`git update-ref refs/remotes/origin/shipit/test-feature ${pushedTip}`);

      githubAuth.setMergeGateResult({ rollupState: "SUCCESS" });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("had not reached GitHub") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );

  it(
    "docs/288 — `--auto` arms past its OWN push, which is its whole use case",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const env = { ...process.env, HOME: tmpDir };
      const run = (cmd: string) => execSync(cmd, { cwd: sessionDir, env }).toString().trim();
      const pushedTip = run("git rev-parse HEAD");
      fs.writeFileSync(path.join(sessionDir, "later.txt"), "work\n");
      run("git add -A && git commit -q -m 'Work GitHub has not seen'");
      run(`git update-ref refs/remotes/origin/shipit/test-feature ${pushedTip}`);
      const newTip = run("git rev-parse HEAD");

      githubAuth.setMergeGateResult({ headRefOid: newTip, rollupState: "PENDING" });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: { auto: true },
      }));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true, message: expect.stringContaining("once its checks pass"),
      });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toMatchObject({
        state: "pending", origin: "auto", expectedSha: newTip,
      });
    },
  );

  it(
    "docs/288 — a diverged branch still refuses `--auto`, since the commit is not on GitHub",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");

      const env = { ...process.env, HOME: tmpDir };
      const run = (cmd: string) => execSync(cmd, { cwd: sessionDir, env }).toString().trim();
      fs.writeFileSync(path.join(sessionDir, "local.txt"), "local\n");
      run("git add -A && git commit -q -m 'Local only'");
      const local = run("git rev-parse HEAD");
      run(`git branch -f other ${local}~1`);
      run("git checkout -q other");
      fs.writeFileSync(path.join(sessionDir, "remote.txt"), "remote\n");
      run("git add -A && git commit -q -m 'Remote only'");
      const remoteOnly = run("git rev-parse HEAD");
      run("git checkout -q shipit/test-feature");
      run(`git update-ref refs/remotes/origin/shipit/test-feature ${remoteOnly}`);

      githubAuth.setMergeGateResult({ rollupState: "PENDING" });
      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: { auto: true },
      }));

      expect(res.statusCode).toBe(409);
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toBeNull();
    },
  );

  it(
    "refuses a merge that arrives with no turn running (req 9)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("no turn") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );

  it(
    "leaves the claim standing when the merge outcome is indeterminate (req 9)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      githubAuth.setMergeAttempt({
        outcome: "indeterminate", message: "ShipIt did not hear back from GitHub",
      });

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));

      expect(res.json()).toMatchObject({ success: false });
      const claim = new AgentMergeClaimStore(dbManager).get(sessionId);
      expect(claim).toMatchObject({ prNumber: 7, expectedSha: head, state: "merging" });
    },
  );

  it(
    "drops the claim when GitHub definitively refuses (req 9)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      githubAuth.setMergeAttempt({ outcome: "refused", message: "PR is not mergeable" });

      await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));

      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toBeNull();
    },
  );

  it(
    "revoking the grant closes the door again",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      repoStore.setAllowAgentMerge(REPO, false);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("Project Settings") });
    },
  );

  it(
    "revoking the grant DURING the merge stops it before the REST call (req 1)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      githubAuth.setOnMergeGateRead(() => { repoStore.setAllowAgentMerge(REPO, false); });
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/7/merge`,
        payload: {},
      }));
      githubAuth.setOnMergeGateRead(null);

      expect(res.json()).toMatchObject({ success: false, message: expect.stringContaining("withdrawn") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toBeNull();
    },
  );

  it(
    "refuses a second merge while an earlier one is unresolved (req 9)",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await setupPrimedSession();
      repoStore.setAllowAgentMerge(REPO, true);
      sessionManager.recordPrProvenance(sessionId, 7, "github:test-user/test-repo");
      const head = execSync("git rev-parse HEAD", {
        cwd: sessionDir, env: { ...process.env, HOME: tmpDir },
      }).toString().trim();
      githubAuth.setMergeGateResult({ headRefOid: head, rollupState: "SUCCESS" });
      githubAuth.setMergeAttempt({
        outcome: "indeterminate", message: "ShipIt did not hear back from GitHub",
      });
      await withLiveTurn(sessionId, () => app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/pr/7/merge`, payload: {},
      }));
      const outstanding = new AgentMergeClaimStore(dbManager).get(sessionId);
      expect(outstanding).toMatchObject({ expectedSha: head, state: "merging" });

      githubAuth.setMergeAttempt({ outcome: "merged", message: "Pull request merged", mergeCommitSha: "m" });
      const before = githubAuth.mergePullRequestCalls.length;
      const res = await withLiveTurn(sessionId, () => app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/pr/7/merge`, payload: {},
      }));

      expect(res.json()).toMatchObject({ success: false, message: expect.stringContaining("not been resolved") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
      expect(new AgentMergeClaimStore(dbManager).get(sessionId)).toMatchObject({
        expectedSha: head, state: "merging",
      });
    },
  );

  it(
    "agent merge is 403 for a sandbox without the dangerousGitHubOps grant",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: false });
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/5/merge`,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("not enabled") });
    },
  );

  it(
    "agent merge succeeds for a sandbox with the grant and green checks",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: true });

      const cloneDir = path.join(sessionDir, "cloned");
      fs.mkdirSync(cloneDir, { recursive: true });
      const gitEnv = { ...process.env, HOME: tmpDir };
      execSync("git init -q", { cwd: cloneDir, env: gitEnv });
      execSync("git remote add origin https://github.com/sand-user/sand-repo.git", { cwd: cloneDir, env: gitEnv });

      githubAuth.setMergeGateResult({ headRefOid: "sha-feat", rollupState: "SUCCESS" });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/20/merge`,
        payload: { method: "squash", cwd: "/workspace/cloned" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true });
      expect(githubAuth.mergePullRequestCalls.at(-1)).toMatchObject({
        pullNumber: 20, method: "squash", expectedSha: "sha-feat",
      });

      githubAuth.setMergeGateResult({ isDraft: true });
      const draft = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/21/merge`,
        payload: { cwd: "/workspace/cloned" },
      });
      expect(draft.statusCode).toBe(200);
      expect(draft.json()).toMatchObject({ success: false, message: expect.stringContaining("draft") });
    },
  );

  it(
    "a sandbox merge no longer proceeds when the check read FAILS",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: true });
      const cloneDir = path.join(sessionDir, "cloned");
      fs.mkdirSync(cloneDir, { recursive: true });
      const gitEnv = { ...process.env, HOME: tmpDir };
      execSync("git init -q", { cwd: cloneDir, env: gitEnv });
      execSync("git remote add origin https://github.com/sand-user/sand-repo.git", { cwd: cloneDir, env: gitEnv });

      githubAuth.setMergeGateResult(null);
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/20/merge`,
        payload: { cwd: "/workspace/cloned" },
      });
      expect(res.json()).toMatchObject({ success: false, message: expect.stringContaining("could not read") });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );

  it(
    "a sandbox merge refuses a GraphQL answer that carries errors alongside data",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId, sessionDir } = await createBareSession();
      sessionManager.setKind(sessionId, "sandbox");
      sessionManager.setCapabilities(sessionId, { git: true, docker: false, network: true, dangerousGitHubOps: true });
      const cloneDir = path.join(sessionDir, "cloned");
      fs.mkdirSync(cloneDir, { recursive: true });
      const gitEnv = { ...process.env, HOME: tmpDir };
      execSync("git init -q", { cwd: cloneDir, env: gitEnv });
      execSync("git remote add origin https://github.com/sand-user/sand-repo.git", { cwd: cloneDir, env: gitEnv });

      githubAuth.setMergeGateResult({ rollupState: null }, [{ message: "Something went wrong" }]);
      const before = githubAuth.mergePullRequestCalls.length;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/pr/20/merge`,
        payload: { cwd: "/workspace/cloned" },
      });
      expect(res.json()).toMatchObject({ success: false });
      expect(githubAuth.mergePullRequestCalls).toHaveLength(before);
    },
  );
});

describe("GET /pr/list state handling", () => {
  it(
    "defaults to open when ?state= is absent",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list` });
      expect(res.statusCode).toBe(200);
      expect(githubAuth.listPullRequestsCalls.at(-1)?.state).toBe("open");
    },
  );

  it(
    "passes ?state=merged through instead of coercing it to open",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list?state=merged` });
      expect(res.statusCode).toBe(200);
      expect(githubAuth.listPullRequestsCalls.at(-1)?.state).toBe("merged");
    },
  );

  it(
    "refuses an unknown ?state= by name rather than listing the open PRs",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list?state=bogus` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("open, closed, merged, all");
      expect(githubAuth.listPullRequestsCalls).toEqual([]);
    },
  );

  it(
    "answers non-2xx when the GitHub read failed, rather than 200 with no PRs",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      githubAuth.setListPrFailure("Resource not accessible by integration");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list` });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain("Resource not accessible by integration");
      expect(res.json().prs).toBeUndefined();
    },
  );

  it(
    "refuses an invalid ?limit= rather than quietly using the default",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      for (const bad of ["abc", "0", "-5", "2.5", "101", "1e2", "0x10", "1.0", ""]) {
        const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list?limit=${bad}` });
        expect({ bad, status: res.statusCode }).toEqual({ bad, status: 400 });
        expect(res.json().error).toContain("between 1 and 100");
      }
      expect(githubAuth.listPullRequestsCalls).toEqual([]);
    },
  );

  it(
    "passes a valid ?limit= through to the read",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list?limit=7` });
      expect(res.statusCode).toBe(200);
      expect(githubAuth.listPullRequestsCalls.at(-1)?.limit).toBe(7);
    },
  );

  it(
    "leaves the limit undefined when the parameter is absent",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list` });
      expect(githubAuth.listPullRequestsCalls.at(-1)?.limit).toBeUndefined();
    },
  );

  it(
    "refuses a malformed ?repo= instead of listing the session's own PRs",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list?repo=octocat` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Invalid --repo");
      expect(githubAuth.listPullRequestsCalls).toEqual([]);
    },
  );

  it(
    "refuses a malformed ?repo= on pr/status too, as a 400 not a 500",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/status?repo=octocat` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Invalid --repo");
    },
  );

  it(
    "still answers 200 with an empty list for a repo that genuinely has none",
    { timeout: 15_000 },
    async () => {
      await githubAuth.setToken("test-token");
      const { sessionId } = await setupPrimedSession();
      const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/pr/list` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ prs: [] });
    },
  );
});
