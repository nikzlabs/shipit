import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { SessionRunner } from "../session-runner.js";
import { runRebaseFlow, buildRebaseConflictPrompt, MAX_REBASE_ITERATIONS } from "./rebase-driver.js";
import type { AgentProcess, AgentEvent, AgentRunParams, WsServerMessage } from "../../shared/types.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";

/**
 * Fake agent for rebase tests. The test injects a "resolution function" that
 * decides what file edits to perform when the agent runs. After running, the
 * agent emits an `agent_assistant` (so accumulatedText is populated) followed
 * by `done`.
 */
class FakeRebaseAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  readonly capabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [],
    models: [],
  };

  /**
   * Resolution function — called when run() is invoked. Should edit files in
   * `cwd` to remove conflict markers, then return a summary string used as the
   * assistant's "I resolved..." message in chat.
   */
  constructor(private resolve: (cwd: string) => string) {
    super();
  }

  run(params: AgentRunParams): void {
    // Run async so listeners attach first.
    setImmediate(() => {
      try {
        const summary = this.resolve(params.cwd);
        this.emit("event", {
          type: "agent_assistant",
          content: [{ type: "text", text: summary }],
        } as AgentEvent);
        this.emit("event", {
          type: "agent_result",
          status: "success",
          sessionId: params.sessionId,
        } as AgentEvent);
        this.emit("done", 0);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  writeStdin(): void { /* no-op */ }
  interrupt(): void { /* no-op */ }
  kill(): void { /* no-op */ }
}

/** Build a bare-repo + working-clone with one initial commit. */
function setupRepoWithRemote(tmpDir: string) {
  const bareDir = path.join(tmpDir, "bare.git");
  const workDir = path.join(tmpDir, "work");
  fs.mkdirSync(bareDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  execSync("git init --bare -b main", { cwd: bareDir, stdio: "pipe" });
  execSync(`git clone ${bareDir} .`, { cwd: workDir, stdio: "pipe" });

  fs.writeFileSync(path.join(workDir, "shared.txt"), "v1\n");
  execSync("git add -A && git commit -m 'Initial'", { cwd: workDir, stdio: "pipe" });
  execSync("git push", { cwd: workDir, stdio: "pipe" });

  return { bareDir, workDir, git: new GitManager(workDir) };
}

/**
 * Diverge feature branch and main: feature edits shared.txt one way, main edits
 * it another way. Pushing both creates a conflict on rebase.
 */
function createConflictingDivergence(bareDir: string, workDir: string) {
  execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
  fs.writeFileSync(path.join(workDir, "shared.txt"), "feature edit\n");
  execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

  // Push main forward via a temp clone so origin/main diverges.
  const tempClone = path.join(path.dirname(workDir), "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, "shared.txt"), "upstream edit\n");
  execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });
}

/**
 * Diverge feature branch from main without conflicts: feature touches a
 * different file than main.
 */
function createCleanDivergence(bareDir: string, workDir: string) {
  execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
  fs.writeFileSync(path.join(workDir, "feature.txt"), "feature\n");
  execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

  const tempClone = path.join(path.dirname(workDir), "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, "main-only.txt"), "main\n");
  execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });
}

/** Stub GitHubAuthManager used by the driver's force-push step. */
function makeStubAuth(authenticated: boolean): GitHubAuthManager {
  return { authenticated } as GitHubAuthManager;
}

/** Minimal stub for ChatHistoryManager — only `append` is used by the driver. */
function makeStubHistory(captured: { role: string; text: string }[]): ChatHistoryManager {
  return {
    append: (_sessionId: string, msg: { role: string; text: string }) => {
      captured.push(msg);
    },
  } as unknown as ChatHistoryManager;
}

/** Minimal stub for SessionManager — only `get` is used by the driver. */
function makeStubSessionManager(): SessionManager {
  return {
    get: (sessionId: string) => ({ sessionId, agentSessionId: undefined }),
  } as unknown as SessionManager;
}

describe("rebase-driver: runRebaseFlow", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-driver-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    // Prevent rebase --continue from opening an editor
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("up-to-date branch — emits rebase_complete and skips agent", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    // No divergence — branch is already at HEAD of main.
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const captured: { role: string; text: string }[] = [];
    const result = await runRebaseFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("up_to_date");
    expect(messages.find((m) => m.type === "rebase_complete")).toBeDefined();
    expect(messages.find((m) => m.type === "rebase_started")).toBeUndefined();
    // Agent is never invoked, so no chat messages are persisted.
    expect(captured).toHaveLength(0);
  });

  it("clean rebase — force-pushes and emits rebase_complete with forcePushed=true", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    // Set the feature branch as the upstream so force-push has a target.
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const result = await runRebaseFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(result).toHaveProperty("forcePushed", true);

    const startedIdx = messages.findIndex((m) => m.type === "rebase_started");
    const completeIdx = messages.findIndex((m) => m.type === "rebase_complete");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startedIdx);

    const completeMsg = messages[completeIdx];
    if (completeMsg.type === "rebase_complete") {
      expect(completeMsg.forcePushed).toBe(true);
    }

    // The force push must surface a github_push_result so the UI can show
    // confirmation (regression: the rebase used to swallow the result, leaving
    // the user unsure whether the rebased history actually reached origin).
    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeDefined();
    if (pushResult?.type === "github_push_result") {
      expect(pushResult.success).toBe(true);
      expect(pushResult.branch).toBe("feature");
    }
  });

  it("force push failure — surfaces github_push_result(success=false) + log_entry", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    // Let fetch + rebase succeed, then make the force push itself throw.
    const forcePushSpy = vi
      .spyOn(git, "forcePush")
      .mockRejectedValue(new Error("simulated push failure: connection refused"));

    try {
      const result = await runRebaseFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
        sseBroadcast: () => {},
      }, "main");

      expect(result.status).toBe("rebased");
      expect(result).toHaveProperty("forcePushed", false);
      expect(forcePushSpy).toHaveBeenCalled();

      // Failure must be visible to the user — both as a push result and as a log entry.
      const pushResult = messages.find((m) => m.type === "github_push_result");
      expect(pushResult).toBeDefined();
      if (pushResult?.type === "github_push_result") {
        expect(pushResult.success).toBe(false);
        expect(pushResult.message).toMatch(/Force push failed/);
      }
      const logEntry = messages.find((m) => m.type === "log_entry");
      expect(logEntry).toBeDefined();
    } finally {
      forcePushSpy.mockRestore();
    }
  });

  it("clean rebase without auth — completes with forcePushed=false", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runRebaseFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(result).toHaveProperty("forcePushed", false);
    const completeMsg = messages.find((m) => m.type === "rebase_complete");
    if (completeMsg?.type === "rebase_complete") {
      expect(completeMsg.forcePushed).toBe(false);
    }
  });

  it("conflicts — agent resolves and rebase completes", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const captured: { role: string; text: string }[] = [];
    let agentInvocations = 0;

    const result = await runRebaseFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        agentInvocations++;
        // "Resolve" by writing a clean merged version.
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved shared.txt by merging both edits.";
      }) as unknown as AgentProcess,
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(agentInvocations).toBe(1);

    // Verify file contents are clean (no conflict markers).
    const final = fs.readFileSync(path.join(workDir, "shared.txt"), "utf-8");
    expect(final).not.toContain("<<<<<<<");
    expect(final).not.toContain(">>>>>>>");

    // Verify expected WS event sequence.
    const types = messages.map((m) => m.type);
    expect(types).toContain("rebase_started");
    expect(types).toContain("rebase_conflicts");
    expect(types).toContain("system_user_message");
    expect(types).toContain("rebase_complete");

    // Chat history should record both the prompt and the assistant resolution.
    const userMsg = captured.find((m) => m.role === "user");
    const assistantMsg = captured.find((m) => m.role === "assistant");
    expect(userMsg?.text).toContain("Rebasing onto");
    expect(assistantMsg?.text).toContain("Resolved shared.txt");
  });

  it("throws if agent is already running on the runner", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    runner.running = true;

    await expect(
      runRebaseFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow(/Cannot rebase while an agent turn is in progress/);
  });

  it("throws if base branch cannot be resolved", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });

    await expect(
      runRebaseFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        sseBroadcast: () => {},
      }, "nonexistent-branch-xyz"),
    ).rejects.toThrow(/Cannot resolve base branch/);
  });
});

describe("rebase-driver: buildRebaseConflictPrompt", () => {
  it("includes base branch and file list", () => {
    const prompt = buildRebaseConflictPrompt("main", [
      { path: "src/foo.ts", content: "" },
      { path: "src/bar.ts", content: "" },
    ]);
    expect(prompt).toContain("`main`");
    expect(prompt).toContain("2 conflicts");
    expect(prompt).toContain("src/foo.ts");
    expect(prompt).toContain("src/bar.ts");
    expect(prompt).toContain("conflict markers");
  });

  it("uses singular for one conflict", () => {
    const prompt = buildRebaseConflictPrompt("develop", [
      { path: "single.ts", content: "" },
    ]);
    expect(prompt).toContain("1 conflict to resolve");
  });
});

describe("rebase-driver: constants", () => {
  it("MAX_REBASE_ITERATIONS is exported and > 0", () => {
    expect(MAX_REBASE_ITERATIONS).toBeGreaterThan(0);
  });
});
