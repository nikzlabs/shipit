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
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";

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
    supportsReview: true,
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

/**
 * Stub ChatHistoryManager that captures every assistant + user write the
 * driver and listener perform. The shared listener (`wireAgentListeners`)
 * uses `replaceInProgress` to write incremental message groups on
 * `agent_result`, then `finalizeInProgress` to clear the in-progress flag —
 * we track the *finalized* set so assertions match what the user would see
 * on reload.
 */
function makeStubHistory(captured: { role: string; text: string }[]): ChatHistoryManager {
  let inProgress: { role: string; text: string }[] = [];
  return {
    append: (_sessionId: string, msg: { role: string; text: string }) => {
      captured.push(msg);
    },
    replaceInProgress: (_sessionId: string, messages: { role: string; text: string }[]) => {
      inProgress = messages;
    },
    finalizeInProgress: (_sessionId: string) => {
      captured.push(...inProgress);
      inProgress = [];
    },
    clearInProgress: (_sessionId: string) => {
      inProgress = [];
    },
  } as unknown as ChatHistoryManager;
}

/** Minimal stub for SessionManager — only `get` is used by the driver. */
function makeStubSessionManager(): SessionManager {
  return {
    get: (sessionId: string) => ({ sessionId, agentSessionId: undefined }),
    setAgentSessionId: () => {},
    setLastTurnErrored: () => {},
    track: () => {},
    list: () => [],
  } as unknown as SessionManager;
}

/**
 * Minimal stubs for the listener-side managers (usage tracking and OAuth).
 * The rebase flow funnels through `wireAgentListeners` shared with the WS
 * path, so these need to exist even when the fake agent never produces
 * usage or hits an auth gate.
 */
function makeStubUsageManager(): UsageManager {
  return {
    record: () => {},
    getSessionUsage: () => undefined,
    getSessionTokenTotals: () => undefined,
  } as unknown as UsageManager;
}

function makeStubAuthManager(): AuthManager {
  return { startOAuthFlow: () => {} } as unknown as AuthManager;
}

/**
 * docs/169 — the conflict-resolution turn now runs through `runner.dispatch`,
 * which requires `SystemTurnDeps` wired on the runner (else dispatch enqueues
 * and the turn never starts). This wrapper builds those deps from the same
 * stubs the driver deps already carry, so the test exercises the real shared
 * dispatch path (the unification refactor's whole point) before delegating to
 * `runRebaseFlow`.
 */
async function runFlow(
  deps: Parameters<typeof runRebaseFlow>[0],
  baseBranch: string,
): ReturnType<typeof runRebaseFlow> {
  deps.runner.setSystemTurnDeps({
    agentFactory: deps.agentFactory!,
    autoCommit: async () => ({ commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false }),
    scheduleAutoPush: () => { /* postTurn: "none" skips this for rebase turns */ },
    listenerDeps: {
      sessionManager: deps.sessionManager,
      chatHistoryManager: deps.chatHistoryManager,
      usageManager: deps.usageManager,
      authManager: deps.authManager,
      sseBroadcast: deps.sseBroadcast,
      broadcastLog: () => { /* rebase flow doesn't surface CLI log lines */ },
      getSelectedModel: () => deps.sessionManager.get(deps.runner.sessionId)?.model,
    },
    buildRunParams: async (sessionId, _agentId, prompt) => {
      const session = deps.sessionManager.get(sessionId) as { agentSessionId?: string } | undefined;
      const agentSessionId = session?.agentSessionId ?? sessionId;
      return { prompt, sessionId: agentSessionId, cwd: deps.runner.sessionDir } as AgentRunParams;
    },
  });
  return runRebaseFlow(deps, baseBranch);
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
    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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
      const result = await runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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

    const result = await runFlow({
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
      usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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

  it("conflicts — preserves tool calls and splits assistant messages at tool-result boundary", async () => {
    // Regression test for the "invisible tool calls + concatenated assistant
    // text" bug. Before the unification refactor, the rebase driver had its
    // own custom event listener that joined assistant text blocks with no
    // separator across events and dropped all tool_use blocks — producing
    // chat-history rows like:
    //   { role: "assistant", text: "I'll examine the conflict.Conflict resolved." }
    // with no record of the file edit the agent made between the two
    // utterances. After the refactor, the rebase flow goes through
    // `wireAgentListeners` (same as the WS user-typed path), so message
    // groups split at tool-result boundaries and tool_use blocks are
    // preserved on each group. This test exercises the exact event sequence
    // from the bug report.
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const captured: { role: string; text: string; toolUse?: { id: string; name: string }[]; toolResults?: { toolUseId: string }[] }[] = [];

    /**
     * Fake agent that emits the canonical "assistant says X → tool call →
     * tool result → assistant says Y → agent_result" sequence. The Read +
     * Edit names mirror Claude's actual tool taxonomy so the listener treats
     * them as ordinary tools (not standalone tools like AskUserQuestion).
     */
    class FakeToolUsingAgent extends FakeRebaseAgent {
      constructor(private fileEditPath: string, private fileEditContent: string) {
        super(() => "unused");
      }
      override run(params: AgentRunParams): void {
        setImmediate(() => {
          // 1. Assistant preamble + tool_use (Edit).
          this.emit("event", {
            type: "agent_assistant",
            content: [
              { type: "text", text: "I'll examine the conflict in shared.txt and resolve it." },
              {
                type: "tool_use",
                id: "tool_1",
                name: "Edit",
                input: { file_path: this.fileEditPath, content: this.fileEditContent },
              },
            ],
          } as AgentEvent);
          // 2. Perform the edit (mirrors what a real tool result implies).
          fs.writeFileSync(this.fileEditPath, this.fileEditContent);
          // 3. Tool result. The listener's `agent_tool_result` branch flips
          //    `needsNewMessageGroup` so the NEXT agent_assistant starts a
          //    fresh group instead of concatenating into the first one.
          this.emit("event", {
            type: "agent_tool_result",
            content: [{ type: "tool_result", tool_use_id: "tool_1", content: "File updated." }],
          } as AgentEvent);
          // 4. Assistant follow-up (post-tool).
          this.emit("event", {
            type: "agent_assistant",
            content: [{ type: "text", text: "Conflict resolved." }],
          } as AgentEvent);
          // 5. Result + done.
          this.emit("event", {
            type: "agent_result",
            status: "success",
            sessionId: params.sessionId,
          } as AgentEvent);
          this.emit("done", 0);
        });
      }
    }

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () =>
        new FakeToolUsingAgent(path.join(workDir, "shared.txt"), "merged result\n") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");

    // Captured rows: one user (the conflict prompt) + two assistant rows
    // (preamble-with-tool-call, then post-tool-result text). Before the fix
    // the second assistant row didn't exist — its text was concatenated
    // into the first row's text and the tool_use was missing entirely.
    const userRow = captured.find((m) => m.role === "user");
    expect(userRow?.text).toContain("Rebasing onto");

    const assistantRows = captured.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(2);

    // First assistant row: the preamble TEXT + the tool_use block, plus the
    // tool_result that came back. Without the fix this row's text would have
    // been "I'll examine the conflict in shared.txt and resolve it.Conflict
    // resolved." (no separator, two utterances joined) and `toolUse` would
    // have been undefined.
    expect(assistantRows[0].text).toBe("I'll examine the conflict in shared.txt and resolve it.");
    expect(assistantRows[0].toolUse).toHaveLength(1);
    expect(assistantRows[0].toolUse?.[0].name).toBe("Edit");
    expect(assistantRows[0].toolResults).toHaveLength(1);
    expect(assistantRows[0].toolResults?.[0].toolUseId).toBe("tool_1");

    // Second assistant row: just the post-tool text, no tool_use.
    expect(assistantRows[1].text).toBe("Conflict resolved.");
    expect(assistantRows[1].toolUse).toBeUndefined();
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
      runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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
      runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
      authManager: makeStubAuthManager(),
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
