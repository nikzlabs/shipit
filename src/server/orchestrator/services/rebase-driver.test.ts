import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { SessionRunner, SessionRunnerRegistry, resetRunnerTurnState } from "../session-runner.js";
import { createIdleEnforcer } from "../idle-enforcer.js";
import { POST_TURN_HOLD_MAX_MS } from "../post-turn-hold.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { SessionContainerManager } from "../session-container.js";
import type { DockerMemoryStats } from "../../shared/types.js";
import {
  runRebaseFlow,
  runAutoResolveAttempt,
  buildRebaseConflictPrompt,
  buildBranchSyncAgentNotice,
  MAX_REBASE_ITERATIONS,
  syncFailureAlreadyExplained,
} from "./rebase-driver.js";
import { armFollowupNote, followupWindowOpen } from "./rebase-followup.js";
import { withWorkspaceLock } from "./marketplace.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { testDispatch } from "../integration_tests/dispatch-test-helpers.js";
import type { AgentProcess, AgentEvent, AgentRunParams, WsServerMessage } from "../../shared/types.js";

vi.mock("../session-worker-uid.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../session-worker-uid.js")>();
  return { ...actual, handWorkspaceBackToWorker: vi.fn() };
});
vi.mock("../git-lfs.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../git-lfs.js")>();
  return {
    ...actual,
    restoreLfsAfterTreeRewrite: vi.fn(() =>
      Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
    ),
  };
});
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";

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

  constructor(private resolve: (cwd: string) => string) {
    super();
  }

  run(params: AgentRunParams): void {
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

function createConflictingDivergence(bareDir: string, workDir: string) {
  execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
  fs.writeFileSync(path.join(workDir, "shared.txt"), "feature edit\n");
  execSync("git add -A && git commit -m 'Feature change'", { cwd: workDir, stdio: "pipe" });

  const tempClone = path.join(path.dirname(workDir), "temp-clone");
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, "shared.txt"), "upstream edit\n");
  execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });
}

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

function makeStubAuth(authenticated: boolean): GitHubAuthManager {
  return { authenticated } as GitHubAuthManager;
}

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

function makeStubSessionManager(notices: string[] = []): SessionManager {
  return {
    get: (sessionId: string) => ({ sessionId, agentSessionId: undefined }),
    setAgentSessionId: () => {},
    setLastTurnErrored: () => {},
    setPendingAgentNotice: (_id: string, notice: string) => { notices.push(notice); },
    track: () => {},
    setMuted: () => null,
    list: () => [],
  } as unknown as SessionManager;
}

function makeStubUsageManager(): UsageManager {
  return {
    record: () => {},
    getSessionUsage: () => undefined,
    getSessionTokenTotals: () => undefined,
  } as unknown as UsageManager;
}


// Without this the runner has no system-turn deps, and a dispatch never starts a turn.
function wireSystemTurnDeps(deps: Parameters<typeof runRebaseFlow>[0]): void {
  deps.runner.setSystemTurnDeps({
    agentFactory: deps.agentFactory!,
    autoCommit: async () => ({ commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null }),
    scheduleAutoPush: () => { /* postTurn: "none" skips this for rebase turns */ },
    listenerDeps: {
      sessionManager: deps.sessionManager,
      chatHistoryManager: deps.chatHistoryManager,
      usageManager: deps.usageManager,
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
}

async function runFlow(
  deps: Parameters<typeof runRebaseFlow>[0],
  baseBranch: string,
): ReturnType<typeof runRebaseFlow> {
  wireSystemTurnDeps(deps);
  return runRebaseFlow(deps, baseBranch);
}

describe("rebase-driver: runRebaseFlow", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-driver-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
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
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("up_to_date");
    expect(messages.find((m) => m.type === "rebase_complete")).toBeDefined();
    expect(messages.find((m) => m.type === "rebase_started")).toBeUndefined();
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

    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
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

    const pushResult = messages.find((m) => m.type === "github_push_result");
    expect(pushResult).toBeDefined();
    if (pushResult?.type === "github_push_result") {
      expect(pushResult.success).toBe(true);
      expect(pushResult.branch).toBe("feature");
    }
  });

  it("clean rebase — re-evaluates the session's shipit.yaml/compose config", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const reevaluate = vi.fn();
    (runner as unknown as { reevaluateWorkspaceConfig: () => void }).reevaluateWorkspaceConfig = reevaluate;

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(reevaluate).toHaveBeenCalledTimes(1);
  });

  it("clean rebase — re-checks the session's dependencies", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const rewritten = vi.fn();
    (runner as unknown as { notifyWorkspaceRewritten: () => void }).notifyWorkspaceRewritten = rewritten;

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(rewritten).toHaveBeenCalledTimes(1);
  });

  it("up-to-date branch — does NOT re-evaluate config or dependencies (the tree never changed)", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const reevaluate = vi.fn();
    (runner as unknown as { reevaluateWorkspaceConfig: () => void }).reevaluateWorkspaceConfig = reevaluate;
    const rewritten = vi.fn();
    (runner as unknown as { notifyWorkspaceRewritten: () => void }).notifyWorkspaceRewritten = rewritten;

    await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(reevaluate).not.toHaveBeenCalled();
    expect(rewritten).not.toHaveBeenCalled();
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
      sseBroadcast: () => {},
      }, "main");

      expect(result.status).toBe("rebased");
      expect(result).toHaveProperty("forcePushed", false);
      expect(forcePushSpy).toHaveBeenCalled();

      const pushResult = messages.find((m) => m.type === "github_push_result");
      expect(pushResult).toBeDefined();
      if (pushResult?.type === "github_push_result") {
        expect(pushResult.success).toBe(false);
        expect(pushResult.message).toMatch(/Force push failed/);
      }
      const logAppend = messages.find((m) => m.type === "log_append");
      expect(logAppend).toBeDefined();
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
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved shared.txt by merging both edits.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(agentInvocations).toBe(1);

    const final = fs.readFileSync(path.join(workDir, "shared.txt"), "utf-8");
    expect(final).not.toContain("<<<<<<<");
    expect(final).not.toContain(">>>>>>>");

    const types = messages.map((m) => m.type);
    expect(types).toContain("rebase_started");
    expect(types).toContain("rebase_conflicts");
    expect(types).toContain("system_user_message");
    expect(types).toContain("rebase_complete");

    const userMsg = captured.find((m) => m.role === "user");
    const assistantMsg = captured.find((m) => m.role === "assistant");
    expect(userMsg?.text).toContain("Rebasing onto");
    expect(assistantMsg?.text).toContain("Resolved shared.txt");
  });

  it("conflicts — preserves tool calls and splits assistant messages at tool-result boundary", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const captured: { role: string; text: string; toolUse?: { id: string; name: string }[]; toolResults?: { toolUseId: string }[]; branchSynced?: unknown }[] = [];

    class FakeToolUsingAgent extends FakeRebaseAgent {
      constructor(private fileEditPath: string, private fileEditContent: string) {
        super(() => "unused");
      }
      override run(params: AgentRunParams): void {
        setImmediate(() => {
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
          fs.writeFileSync(this.fileEditPath, this.fileEditContent);
          this.emit("event", {
            type: "agent_tool_result",
            content: [{ type: "tool_result", tool_use_id: "tool_1", content: "File updated." }],
          } as AgentEvent);
          this.emit("event", {
            type: "agent_assistant",
            content: [{ type: "text", text: "Conflict resolved." }],
          } as AgentEvent);
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
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");

    const userRow = captured.find((m) => m.role === "user");
    expect(userRow?.text).toContain("Rebasing onto");

    const assistantRows = captured.filter((m) => m.role === "assistant" && !m.branchSynced);
    expect(assistantRows).toHaveLength(2);

    expect(assistantRows[0].text).toBe("I'll examine the conflict in shared.txt and resolve it.");
    expect(assistantRows[0].toolUse).toHaveLength(1);
    expect(assistantRows[0].toolUse?.[0].name).toBe("Edit");
    expect(assistantRows[0].toolResults).toHaveLength(1);
    expect(assistantRows[0].toolResults?.[0].toolUseId).toBe("tool_1");

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
      sseBroadcast: () => {},
      }, "nonexistent-branch-xyz"),
    ).rejects.toThrow(/Cannot resolve base branch/);
  });

  it("planning#146: hands .git AND worktree back to the worker uid on the up-to-date path", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("up_to_date");
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(workDir);
  });

  it("planning#146: hands .git AND worktree back to the worker uid after a clean rebase", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(workDir);
  });

  it("planning#146: hands the worktree back BEFORE each resolution turn so the agent can edit conflicted files", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    let worktreeHandedBackBeforeEdit = false;
    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        worktreeHandedBackBeforeEdit = vi.mocked(handWorkspaceBackToWorker).mock.calls.some(
          ([dir]) => dir === workDir,
        );
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(worktreeHandedBackBeforeEdit).toBe(true);
    expect(vi.mocked(handWorkspaceBackToWorker).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("planning#146: hands .git AND worktree back even when the flow throws (unresolvable base)", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "nonexistent-branch-xyz"),
    ).rejects.toThrow(/Cannot resolve base branch/);

    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(workDir);
  });

  it("nikzlabs/shipit#2349: restores LFS content after a clean rebase rewrote the worktree", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      workDir,
      expect.stringContaining("main"),
      expect.any(Function),
    );
  });

  it("nikzlabs/shipit#2349: does NOT restore on the up-to-date path — nothing was rewritten", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("up_to_date");
    expect(restoreLfsAfterTreeRewrite).not.toHaveBeenCalled();
  });

  it("nikzlabs/shipit#2349: restores only AFTER the conflicts settle, never between iterations", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    let restoredBeforeResolution = false;
    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        restoredBeforeResolution = vi.mocked(restoreLfsAfterTreeRewrite).mock.calls.length > 0;
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(restoredBeforeResolution).toBe(false);
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(restoreLfsAfterTreeRewrite).mock.calls[0]![0]).toBe(workDir);
  });

  it("nikzlabs/shipit#2349: restores after an aborted rebase — the abort rewrites the tree too", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => {
          throw new Error("agent died mid-resolution");
        }) as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow();

    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      workDir,
      expect.any(String),
      expect.any(Function),
    );
  });

  it("nikzlabs/shipit#2349: restores BEFORE the handback and BEFORE the queue release", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    let handbacksBefore = -1;
    let holdStillHeld = false;
    vi.mocked(restoreLfsAfterTreeRewrite).mockImplementation(() => {
      handbacksBefore = vi.mocked(handWorkspaceBackToWorker).mock.calls.length;
      holdStillHeld = runner.systemTurnInProgress;
      return Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false });
    });

    await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(handbacksBefore).toBe(0);
    expect(holdStillHeld).toBe(true);
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(workDir);
  });

  it("nikzlabs/shipit#2349: holds the runner while restoring, so the idle enforcer can't cut it short", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    let heldDuringRestore = false;
    vi.mocked(restoreLfsAfterTreeRewrite).mockImplementation(() => {
      heldDuringRestore = runner.postTurnWorkInFlight && runner.agentBusy;
      return Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false });
    });

    await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(heldDuringRestore).toBe(true);
    expect(runner.postTurnWorkInFlight).toBe(false);
  });

  it("nikzlabs/shipit#2349: does NOT restore when the flow throws before touching the worktree", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "nonexistent-branch-xyz"),
    ).rejects.toThrow(/Cannot resolve base branch/);

    expect(restoreLfsAfterTreeRewrite).not.toHaveBeenCalled();
  });
});

function advanceOriginMain(bareDir: string, workDir: string, file: string, content: string) {
  const tempClone = path.join(path.dirname(workDir), `temp-adv-${file}`);
  fs.mkdirSync(tempClone, { recursive: true });
  execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
  execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
  fs.writeFileSync(path.join(tempClone, file), content);
  execSync("git add -A && git commit -m 'Origin main advance'", { cwd: tempClone, stdio: "pipe" });
  execSync("git push", { cwd: tempClone, stdio: "pipe" });
  fs.rmSync(tempClone, { recursive: true, force: true });
}

interface StubPoller {
  notifyAutoPush: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  forceRefreshSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
}

function makeStubPoller(): StubPoller {
  return {
    notifyAutoPush: vi.fn<(sessionId: string) => void>(),
    forceRefreshSession: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
  };
}

describe("rebase-driver: planning#369 PR status refresh after a push", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-refresh-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const depsWithPoller = (
    git: GitManager,
    runner: SessionRunner,
    authed: boolean,
    prStatusPoller: StubPoller | null,
  ) => ({
    git,
    githubAuthManager: makeStubAuth(authed),
    runner,
    sessionManager: makeStubSessionManager(),
    chatHistoryManager: makeStubHistory([]),
    agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
    usageManager: makeStubUsageManager(),
    sseBroadcast: () => {},
    prStatusPoller,
  });

  it("clean rebase — bumps the session to fast cadence AND forces a refresh", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const poller = makeStubPoller();

    const result = await runFlow(depsWithPoller(git, runner, true, poller), "main");

    expect(result).toHaveProperty("forcePushed", true);
    expect(poller.notifyAutoPush).toHaveBeenCalledWith("s1");
    expect(poller.forceRefreshSession).toHaveBeenCalledWith("s1");
  });

  it("conflict resolution — notifies the poller after the resolved rebase is pushed", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const poller = makeStubPoller();

    const result = await runFlow({
      ...depsWithPoller(git, runner, true, poller),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged\n");
        return "Resolved";
      }) as unknown as AgentProcess,
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(poller.notifyAutoPush).toHaveBeenCalledWith("s1");
    expect(poller.forceRefreshSession).toHaveBeenCalledWith("s1");
  });

  it("no GitHub auth — nothing was pushed, so the poller is left alone", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const poller = makeStubPoller();

    const result = await runFlow(depsWithPoller(git, runner, false, poller), "main");

    expect(result).toHaveProperty("forcePushed", false);
    expect(poller.notifyAutoPush).not.toHaveBeenCalled();
    expect(poller.forceRefreshSession).not.toHaveBeenCalled();
  });

  it("no poller wired — a clean rebase still completes", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow(depsWithPoller(git, runner, true, null), "main");

    expect(result).toHaveProperty("forcePushed", true);
  });

  it("a refusing poller does not fail the rebase", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const poller = makeStubPoller();
    poller.forceRefreshSession.mockRejectedValue(new Error("GitHub 502"));

    const result = await runFlow(depsWithPoller(git, runner, true, poller), "main");

    expect(result).toHaveProperty("forcePushed", true);
  });
});

describe("rebase-driver: planning#369 up-to-date branch with unpushed commits", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-unpushed-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const deps = (
    git: GitManager,
    runner: SessionRunner,
    authed: boolean,
    prStatusPoller: StubPoller | null = null,
  ) => ({
    git,
    githubAuthManager: makeStubAuth(authed),
    runner,
    sessionManager: makeStubSessionManager(),
    chatHistoryManager: makeStubHistory([]),
    agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
    usageManager: makeStubUsageManager(),
    sseBroadcast: () => {},
    prStatusPoller,
  });

  function setupUnpushedCommit(tmpDirPath: string) {
    const repo = setupRepoWithRemote(tmpDirPath);
    execSync("git checkout -b feature", { cwd: repo.workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: repo.workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repo.workDir, "local-only.txt"), "never pushed\n");
    execSync("git add -A && git commit -m 'Local only'", { cwd: repo.workDir, stdio: "pipe" });
    return repo;
  }

  it("pushes the unpushed commit, reports forcePushed, and refreshes the PR status", async () => {
    const { workDir, git } = setupUnpushedCommit(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const poller = makeStubPoller();

    const localHead = await git.getHeadHash();
    expect(await git.getRefHash("origin/feature")).not.toBe(localHead);

    const result = await runFlow({ ...deps(git, runner, true, poller), recordSyncCard: true }, "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("origin/feature")).toBe(localHead);

    const complete = messages.find((m) => m.type === "rebase_complete");
    if (complete?.type === "rebase_complete") {
      expect(complete.upToDate).toBe(true);
      expect(complete.forcePushed).toBe(true);
    }
    const card = messages.find((m) => m.type === "branch_synced_card");
    if (card?.type === "branch_synced_card") {
      expect(card.card.forcePushed).toBe(true);
      expect(card.card.headFromSha).toBe(card.card.headToSha);
    }
    expect(poller.notifyAutoPush).toHaveBeenCalledWith("s1");
    expect(poller.forceRefreshSession).toHaveBeenCalledWith("s1");
  });

  it("remote already matches HEAD — pushes nothing and leaves the poller alone", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const poller = makeStubPoller();

    const result = await runFlow(deps(git, runner, true, poller), "main");

    expect(result.status).toBe("up_to_date");
    expect(messages.find((m) => m.type === "github_push_result")).toBeUndefined();
    expect(poller.notifyAutoPush).not.toHaveBeenCalled();
  });

  it("branch never pushed — publishing it is the auto-push path's job, not this one", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "local-only.txt"), "never pushed\n");
    execSync("git add -A && git commit -m 'Local only'", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow(deps(git, runner, true), "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("origin/feature")).toBeNull();
    expect(messages.find((m) => m.type === "github_push_result")).toBeUndefined();
  });

  it("session is ON the base branch — refuses to publish to it", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    fs.writeFileSync(path.join(workDir, "local-only.txt"), "never pushed\n");
    execSync("git add -A && git commit -m 'Local only'", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const originMainBefore = await git.getRefHash("origin/main");

    const result = await runFlow(deps(git, runner, true), "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("origin/main")).toBe(originMainBefore);
    expect(messages.find((m) => m.type === "github_push_result")).toBeUndefined();
  });

  it("HEAD is detached ahead of the branch ref — declines rather than reporting a phantom push", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    execSync("git checkout --detach HEAD", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "detached.txt"), "off-branch\n");
    execSync("git add -A && git commit -m 'Detached commit'", { cwd: workDir, stdio: "pipe" });
    vi.spyOn(git, "getCurrentBranch").mockResolvedValue("feature");

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const originFeatureBefore = await git.getRefHash("origin/feature");

    const result = await runFlow(deps(git, runner, true), "main");
    vi.mocked(git.getCurrentBranch).mockRestore();

    expect(result).toHaveProperty("forcePushed", false);
    expect(await git.getRefHash("origin/feature")).toBe(originFeatureBefore);
  });

  function raceCommitOntoOriginFeature(bareDir: string): string {
    const tempClone = path.join(tmpDir, `racer-${Math.abs(bareDir.length)}`);
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    execSync("git checkout feature", { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "racer.txt"), "someone else\n");
    execSync("git add -A && git commit -m 'Racer'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    return execSync("git rev-parse HEAD", { cwd: tempClone, encoding: "utf8" }).trim();
  }

  it("remote has diverged — leaves it alone rather than rewriting it", async () => {
    const { workDir, bareDir, git } = setupUnpushedCommit(tmpDir);
    const racerSha = raceCommitOntoOriginFeature(bareDir);

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const result = await runFlow(deps(git, runner, true), "main");

    expect(result).toHaveProperty("forcePushed", false);
    expect(await git.getRefHash("origin/feature")).toBe(racerSha);
  });

  it("remote moves between the ancestor check and the push — the lease rejects it", async () => {
    const { workDir, bareDir, git } = setupUnpushedCommit(tmpDir);
    const preRacer = await git.getRefHash("origin/feature");
    const racerSha = raceCommitOntoOriginFeature(bareDir);

    const realGetRefHash = git.getRefHash.bind(git);
    vi.spyOn(git, "getRefHash").mockImplementation(async (ref: string) =>
      (ref === "origin/feature" ? preRacer : realGetRefHash(ref)));

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow(deps(git, runner, true), "main");
    vi.mocked(git.getRefHash).mockRestore();

    expect(result).toHaveProperty("forcePushed", false);
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });
    expect(await git.getRefHash("origin/feature")).toBe(racerSha);
    expect(messages.find((m) => m.type === "git_push_rejected")).toBeDefined();
  });

  it("auto-resolve: an up-to-date flow that pushed is reported as success, not deferred", async () => {
    const { workDir, git } = setupUnpushedCommit(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runAutoResolveAttempt(deps(git, runner, true), "main");

    expect(result).toMatchObject({ outcome: "success", forcePushed: true, didWork: true });
  });

  it("nikzlabs/shipit#2349: on the auto-resolve TIMEOUT, restores before draining the queue", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const order: string[] = [];
    vi.mocked(restoreLfsAfterTreeRewrite).mockImplementation(() => {
      order.push("restore");
      return Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false });
    });

    // Counted: a deadline that expires before the agent ever runs is measuring the
    // wrong thing, which is exactly how this test used to pass.
    const runs = vi.fn();
    const hangingAgent = () => Object.assign(new EventEmitter(), {
      agentId: "claude" as const,
      capabilities: {
        supportsResume: true, supportsImages: false, supportsSystemPrompt: true,
        supportsPermissionModes: false, supportedPermissionModes: [], toolNames: [],
        models: [], supportsReview: true,
      },
      run: runs,
      kill: () => {},
    }) as unknown as AgentProcess;

    const attemptDeps = {
      ...deps(git, runner, true),
      agentFactory: hangingAgent,
      // Long enough that a loaded machine still reaches the dispatch: the assertion below is
      // that the agent RAN, and under the full suite 250ms expired during the rebase itself.
      timeoutMs: 3_000,
      drainQueue: () => { order.push("drain"); },
    };
    // Wire the deps: without them the resolution turn is refused rather than started,
    // and the deadline this test is about would never be the thing that fires.
    wireSystemTurnDeps(attemptDeps);
    const result = await runAutoResolveAttempt(attemptDeps, "main");

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout" });
    expect(runs).toHaveBeenCalledTimes(1);
    expect(order.indexOf("restore")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("drain"));
  });

  it("reports the TIMEOUT even when the interrupted flow settles first", async () => {
    // The deadline's `rebaseAbort` runs against a tree the flow is still rebasing, so
    // the flow falls over with git's complaint about the wreckage. It settles while the
    // abort is still running, so it can win the race — and, being pre-spawn, it answers
    // `deferred`, which costs no attempt and retries straight back into the timeout.
    // Stubbed rather than timed: real git under CI load is what made this intermittent.
    const workDir = fs.mkdtempSync(path.join(tmpDir, "timeout-race-"));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let abortCalls = 0;
    const git = {
      isClean: () => Promise.resolve(true),
      isRebaseInProgress: () => Promise.resolve(false),
      inspectWorkingTree: () => Promise.resolve({ clean: true, conflictedFiles: [], unreadable: null }),
      // Outlives the deadline, then fails the way an aborted-from-under-it rebase does.
      fetch: async () => {
        await sleep(40);
        throw new Error("error: Your local changes to the following files would be overwritten by merge:\n\tshared.txt");
      },
      // The abort is the slow half: it is doing real work on the tree.
      rebaseAbort: async () => { abortCalls++; await sleep(150); },
    } as unknown as GitManager;
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runAutoResolveAttempt(
      { ...deps(git, runner, true), timeoutMs: 20 },
      "main",
    );

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout", didWork: true });
    // Proves the flow really did lose its rebase to the abort, i.e. the race happened.
    expect(abortCalls).toBeGreaterThan(0);
  });

  it("auto-resolve: a genuine no-op stays a suppressed deferral", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runAutoResolveAttempt(deps(git, runner, true), "main");

    expect(result).toMatchObject({ outcome: "deferred", didWork: false, suppressEmit: true });
  });

  it("no GitHub auth — reports up-to-date without pretending it pushed", async () => {
    const { workDir, git } = setupUnpushedCommit(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow(deps(git, runner, false), "main");

    expect(result.status).toBe("up_to_date");
    const complete = messages.find((m) => m.type === "rebase_complete");
    if (complete?.type === "rebase_complete") expect(complete.forcePushed).toBe(false);
  });
});

describe("rebase-driver: docs/221 sync card + local base move", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-sync-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseDeps = (git: GitManager, runner: SessionRunner, captured: { role: string; text: string }[], authed: boolean) => ({
    git,
    githubAuthManager: makeStubAuth(authed),
    runner,
    sessionManager: makeStubSessionManager(),
    chatHistoryManager: makeStubHistory(captured),
    agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
    usageManager: makeStubUsageManager(),
    sseBroadcast: () => {},
  });

  it("clean rebase with recordSyncCard — emits a branch_synced_card, persists it, and advances local main", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const captured: { role: string; text: string; branchSynced?: { cardId: string } }[] = [];

    const result = await runFlow({ ...baseDeps(git, runner, captured, true), recordSyncCard: true }, "main");

    expect(result.status).toBe("rebased");

    expect(await git.getRefHash("main")).toBe(await git.getRefHash("origin/main"));

    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();
    if (card?.type === "branch_synced_card") {
      expect(card.card.base).toBe("main");
      expect(card.card.forcePushed).toBe(true);
      expect(card.card.headFromSha).not.toBe(card.card.headToSha);
    }
    expect(captured.some((m) => m.branchSynced)).toBe(true);
  });

  it("emits the sync card on the automatic path too (recordSyncCard unset) — and still moves local main", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const captured: { role: string; text: string; branchSynced?: { cardId: string } }[] = [];

    const result = await runFlow(baseDeps(git, runner, captured, true), "main");

    expect(result.status).toBe("rebased");
    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();
    if (card?.type === "branch_synced_card") {
      expect(card.card.forcePushed).toBe(true);
      expect(card.card.headFromSha).not.toBe(card.card.headToSha);
    }
    expect(captured.some((m) => m.branchSynced)).toBe(true);
    expect(await git.getRefHash("main")).toBe(await git.getRefHash("origin/main"));
  });

  it("emits the card LAST on an automatic conflict resolution, after everything the flow said", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const captured: { role: string; text: string; branchSynced?: { cardId: string } }[] = [];

    const result = await runFlow({
      ...baseDeps(git, runner, captured, true),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged\n");
        return "Resolved the conflict.";
      }) as unknown as AgentProcess,
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(captured.length).toBeGreaterThan(1);
    expect(captured[captured.length - 1].branchSynced).toBeDefined();
  });

  it("a failed card write does not fail the rebase", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const deps = baseDeps(git, runner, [], true);
    const history = deps.chatHistoryManager as unknown as { append: () => void };
    history.append = () => { throw new Error("history is wedged"); };

    const result = await runFlow(deps, "main");
    expect(result.status).toBe("rebased");
  });

  it("up-to-date branch but local main behind — moves main, emits card, and flags baseMoved on rebase_complete", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    advanceOriginMain(bareDir, workDir, "up.txt", "up\n");
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });
    execSync("git rebase origin/main", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const originMain = await git.getRefHash("origin/main");
    expect(await git.getRefHash("main")).not.toBe(originMain);

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow({ ...baseDeps(git, runner, [], true), recordSyncCard: true }, "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("main")).toBe(originMain);

    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();

    const complete = messages.find((m) => m.type === "rebase_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "rebase_complete") {
      expect(complete.upToDate).toBe(true);
      expect(complete.baseMoved).toBe(true);
    }
  });

  it("nothing to do (local main already current) — still records the manual sync", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow({ ...baseDeps(git, runner, [], false), recordSyncCard: true }, "main");

    expect(result.status).toBe("up_to_date");
    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();
    if (card?.type === "branch_synced_card") {
      expect(card.card.headFromSha).toBe(card.card.headToSha);
      expect(card.card.baseFromSha).toBe(card.card.baseToSha);
    }
    const complete = messages.find((m) => m.type === "rebase_complete");
    if (complete?.type === "rebase_complete") {
      expect(complete.baseMoved).toBe(true);
    }
  });
});

describe("rebase-driver: docs/221 pending agent notice", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-notice-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const depsWithNotices = (
    git: GitManager,
    runner: SessionRunner,
    notices: string[],
    authed: boolean,
  ) => ({
    git,
    githubAuthManager: makeStubAuth(authed),
    runner,
    sessionManager: makeStubSessionManager(notices),
    chatHistoryManager: makeStubHistory([]),
    agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
    usageManager: makeStubUsageManager(),
    sseBroadcast: () => {},
  });

  it("clean manual sync that moved the branch records a notice for the next turn", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const notices: string[] = [];

    const result = await runFlow(
      { ...depsWithNotices(git, runner, notices, true), recordSyncCard: true },
      "main",
    );

    expect(result.status).toBe("rebased");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[System]");
    expect(notices[0]).toContain("origin/main");
    expect(notices[0]).toContain("force-pushed");
  });

  it("does NOT record a notice on the auto-resolve path (recordSyncCard unset)", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const notices: string[] = [];

    const result = await runFlow(depsWithNotices(git, runner, notices, true), "main");

    expect(result.status).toBe("rebased");
    expect(notices).toEqual([]);
  });

  it("records no notice when the branch did not move (nothing the agent's context can be stale about)", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const notices: string[] = [];

    const result = await runFlow(
      { ...depsWithNotices(git, runner, notices, false), recordSyncCard: true },
      "main",
    );

    expect(result.status).toBe("up_to_date");
    expect(notices).toEqual([]);
  });

  it("buildBranchSyncAgentNotice reports the SHA move and omits force-push when it did not happen", () => {
    const notice = buildBranchSyncAgentNotice({
      baseBranch: "master",
      headFrom: "a1f3c9d1111",
      headTo: "7e02b482222",
      forcePushed: false,
      resolvedConflicts: true,
    });
    expect(notice).toContain("origin/master");
    expect(notice).toContain("a1f3c9d");
    expect(notice).toContain("7e02b48");
    expect(notice).toContain("conflicts");
    expect(notice).not.toContain("force-pushed");
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

  it("discloses continue-after-rebase — an armable command the agent never hears about is never used", () => {
    const prompt = buildRebaseConflictPrompt("main", [{ path: "single.ts", content: "" }]);
    expect(prompt).toContain("shipit session continue-after-rebase --note");
    expect(prompt).toContain("This turn ends BEFORE the rebase does");
  });
});

describe("rebase-driver: constants", () => {
  it("MAX_REBASE_ITERATIONS is exported and > 0", () => {
    expect(MAX_REBASE_ITERATIONS).toBeGreaterThan(0);
  });
});

describe("rebase-driver: planning#338 displacement + queue hold", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-displace-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  class FakeSupersededAgent extends EventEmitter {
    readonly agentId = "claude" as const;
    run(): void {
      setImmediate(() => this.emit("superseded"));
    }
    writeStdin(): void { /* no-op */ }
    interrupt(): void { /* no-op */ }
    kill(): void { /* no-op */ }
  }

  it("displacement mid-resolution — aborts the rebase, persists a notice, and never strands the workspace", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const captured: { role: string; text: string }[] = [];

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        agentFactory: () => new FakeSupersededAgent() as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow(/interrupted/);

    expect(await git.isRebaseInProgress()).toBe(false);
    const notice = captured.find((m) => m.text.includes("aborted"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("interrupted");
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("agent error mid-resolution — aborts the rebase instead of leaving it in progress", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const captured: { role: string; text: string }[] = [];

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        agentFactory: () => new FakeRebaseAgent(() => {
          throw new Error("resolution agent crashed");
        }) as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow(/Agent error during rebase conflict resolution/);

    expect(await git.isRebaseInProgress()).toBe(false);
    expect(runner.systemTurnInProgress).toBe(false);
    expect(captured.some((m) => m.text.includes("aborted"))).toBe(true);
  });

  it("a user message dispatched during the flow is queued, and drains only after the flow settles", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    let agentInvocations = 0;
    let queuedHandle: { settled: Promise<{ status: string }> } | null = null;
    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        agentInvocations++;
        if (agentInvocations === 1) {
          queuedHandle = runner.dispatch(testDispatch({ text: "Build it from the reverse-engineered API" }));
          fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
          return "Resolved.";
        }
        return "Ran the queued user turn.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(await git.isRebaseInProgress()).toBe(false);
    expect(messages.some((m) => m.type === "message_queued")).toBe(true);

    expect(queuedHandle).not.toBeNull();
    const outcome = await queuedHandle!.settled;
    expect(outcome.status).toBe("completed");
    expect(agentInvocations).toBe(2);
    expect(runner.queueLength).toBe(0);
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("the hold is exclusive — a second flow entering while one holds the session is refused with 409", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    runner.systemTurnInProgress = true;

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow(/system turn is in progress/);
    expect(runner.systemTurnInProgress).toBe(true);
  });

  it("a failed rebase abort is reported as a failure, not narrated as a clean abort", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const captured: { role: string; text: string }[] = [];

    const abortSpy = vi.spyOn(git, "rebaseAbort").mockRejectedValue(new Error("cannot lock ref"));

    await expect(
      runFlow({
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        agentFactory: () => new FakeSupersededAgent() as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      }, "main"),
    ).rejects.toThrow(/interrupted/);
    abortSpy.mockRestore();

    expect(await git.isRebaseInProgress()).toBe(true);
    const notice = captured.find((m) => m.text.includes("FAILED"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("still mid-rebase");

    await git.rebaseAbort().catch(() => {});
  });

  it("dispatchOnRunner enqueues a non-system dispatch while the flow holds the session between turns", async () => {
    const { workDir } = setupRepoWithRemote(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    runner.setSystemTurnDeps({
      agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
      autoCommit: async () => ({ commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null }),
      scheduleAutoPush: () => {},
      listenerDeps: {
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
        broadcastLog: () => {},
        getSelectedModel: () => undefined,
      },
      buildRunParams: async (sessionId, _agentId, prompt) =>
        ({ prompt, sessionId, cwd: workDir }) as AgentRunParams,
    });

    runner.systemTurnInProgress = true;

    const handle = runner.dispatch(testDispatch({ text: "user msg mid-flow" }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);

    const ciHandle = runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(2);

    const sysHandle = runner.dispatch(testDispatch({ text: "resolve conflicts", systemTurn: true, postTurn: "none" }));
    expect(runner.running).toBe(true);
    await sysHandle.settled;

    runner.systemTurnInProgress = false;
    expect(releaseQueuedTurn(runner)).toBe(true);
    await handle.settled;
    await ciHandle.settled;
    expect(runner.queueLength).toBe(0);
  });

  // The resolution turn holds systemTurnInProgress for the whole flow, so a queued
  // entry of its own could only drain after the hold it is itself waiting to release.
  // Every gate in dispatchOnRunner that does not start a turn NOW must therefore
  // refuse it rather than enqueue it (planning#297).
  describe("a resolution turn that cannot start now fails fast instead of stranding the driver", () => {
    // Must hold on any gate, including ones added after this test was written.
    async function expectStrandFreeFailure(
      run: () => Promise<unknown>,
      opts: { runner: SessionRunner; git: GitManager; captured: { role: string; text: string }[] },
    ): Promise<void> {
      await expect(run()).rejects.toMatchObject({ statusCode: 409 });
      expect(opts.runner.systemTurnInProgress).toBe(false);
      // A stranded prompt would drain later and ask the agent to resolve conflicts that are gone.
      expect(opts.runner.queueLength).toBe(0);
      expect(await opts.git.isRebaseInProgress()).toBe(false);
      const notice = opts.captured.find((m) => m.text.includes("was interrupted before the conflicts"));
      expect(notice?.text).toContain("the branch is unchanged");
    }

    it("refuses when the runner has no system-turn dependencies wired", async () => {
      const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
      createConflictingDivergence(bareDir, workDir);
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
      const captured: { role: string; text: string }[] = [];
      const headBefore = execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim();

      // runRebaseFlow directly: runFlow() would wire the deps this case is about.
      await expectStrandFreeFailure(() => runRebaseFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
        recordSyncCard: true,
      }, "main"), { runner, git, captured });

      expect(execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim()).toBe(headBefore);
    });

    it("refuses while a merge is held for the session", async () => {
      const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
      createConflictingDivergence(bareDir, workDir);
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
      const captured: { role: string; text: string }[] = [];
      runner.mergeHold = true;

      await expectStrandFreeFailure(() => runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
        recordSyncCard: true,
      }, "main"), { runner, git, captured });

      expect(runner.mergeHold).toBe(true);
    });

    it("refuses while the resident agent has background work a system turn would destroy", async () => {
      const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
      createConflictingDivergence(bareDir, workDir);
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
      const captured: { role: string; text: string }[] = [];

      // The observed trigger: the session opened its PR "while the suite and review finish".
      const resident = new FakeRebaseAgent(() => "resident") as unknown as AgentProcess;
      runner.setAgent(resident);
      runner.isStreamingActive = true;
      runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);
      expect(runner.backgroundWorkDescriptions).toEqual(["npm test"]);

      await expectStrandFreeFailure(() => runFlow({
        git,
        githubAuthManager: makeStubAuth(false),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory(captured),
        agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
        recordSyncCard: true,
      }, "main"), { runner, git, captured });

      // Refusing is the point: the work the gate protects must still be there.
      expect(runner.getAgent()).toBe(resident);
      expect(runner.backgroundWorkDescriptions).toEqual(["npm test"]);
    });

    it("is never steered into another turn, and never enters the queue", async () => {
      const { workDir } = setupRepoWithRemote(tmpDir);
      const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
      runner.setSystemTurnDeps({
        agentFactory: () => new FakeRebaseAgent(() => "ok") as unknown as AgentProcess,
        autoCommit: async () => ({ commitHash: null, parentHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null }),
        scheduleAutoPush: () => {},
        listenerDeps: {
          sessionManager: makeStubSessionManager(),
          chatHistoryManager: makeStubHistory([]),
          usageManager: makeStubUsageManager(),
          sseBroadcast: () => {},
          broadcastLog: () => {},
          getSelectedModel: () => undefined,
        },
        buildRunParams: async (sessionId, _agentId, prompt) =>
          ({ prompt, sessionId, cwd: workDir }) as AgentRunParams,
        steerInputs: () => ({ liveSteering: true, steeringCapable: true }),
      });

      runner.running = true;
      runner.setAgent(new FakeRebaseAgent(() => "resident") as unknown as AgentProcess);
      runner.isStreamingActive = true;

      const handle = runner.dispatch(testDispatch({ text: "resolve conflicts" }), { whenBusy: "refuse" });

      expect(runner.queueLength).toBe(0);
      expect(runner.steeredMessages).toHaveLength(0);
      await expect(handle.settled).resolves.toMatchObject({ status: "refused", errored: true });
    });
  });
});

// The auto-resolve loop ran 55 times in 68 minutes against a session whose resident agent
// held an open background poll. Every cycle fetched, rebased and aborted under that agent,
// and wrote the same warning into the chat.
describe("rebase-driver: nikzlabs/shipit#2751 auto-resolve against a busy resident agent", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-busy-agent-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function conflictedSession(): {
    git: GitManager;
    workDir: string;
    runner: SessionRunner;
    captured: { role: string; text: string }[];
  } {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    return { git, workDir, runner, captured: [] };
  }

  function attemptDeps(
    git: GitManager,
    runner: SessionRunner,
    captured: { role: string; text: string }[],
  ) {
    return {
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    };
  }

  it("defers on the pre-flight without fetching, rebasing or warning", async () => {
    const { git, workDir, runner, captured } = conflictedSession();
    runner.setAgent(new FakeRebaseAgent(() => "resident") as unknown as AgentProcess);
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);

    const headBefore = execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim();
    // Un-fetched: the upstream commit is in the bare repo but not in this remote-tracking ref.
    const originMainBefore = await git.getRefHash("origin/main");

    const deps = attemptDeps(git, runner, captured);
    wireSystemTurnDeps(deps);
    const result = await runAutoResolveAttempt(deps, "main");

    expect(result).toEqual({
      outcome: "deferred",
      lastError: "agent_background_work",
      didWork: false,
    });
    expect(await git.getRefHash("origin/main")).toBe(originMainBefore);
    expect(execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim()).toBe(headBefore);
    expect(await git.isRebaseInProgress()).toBe(false);
    expect(captured).toEqual([]);
    expect(runner.backgroundWorkDescriptions).toEqual(["npm test"]);
  });

  it("an idle agent with no background work still resolves the conflict", async () => {
    const { git, workDir, runner, captured } = conflictedSession();
    const deps = {
      ...attemptDeps(git, runner, captured),
      // The gate's absence has to be observable as work, not as the absence of a reason.
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged\n");
        return "resolved";
      }) as unknown as AgentProcess,
    };
    wireSystemTurnDeps(deps);
    const headBefore = execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim();
    const originMainBefore = await git.getRefHash("origin/main");

    const result = await runAutoResolveAttempt(deps, "main");

    expect(result).toMatchObject({ outcome: "success", forcePushed: true, didWork: true });
    expect(await git.getRefHash("origin/main")).not.toBe(originMainBefore);
    expect(execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim()).not.toBe(headBefore);
    expect(fs.readFileSync(path.join(workDir, "shared.txt"), "utf8")).toBe("merged\n");
  });

  it("work that starts inside the pre-flight window is classified the same way", async () => {
    const { git, runner, captured } = conflictedSession();
    const deps = attemptDeps(git, runner, captured);
    wireSystemTurnDeps(deps);
    // The gate is clear at pre-flight and closed by the time the resolution turn dispatches.
    const realFetch = git.fetch.bind(git);
    git.fetch = async (remote: string) => {
      runner.setAgent(new FakeRebaseAgent(() => "resident") as unknown as AgentProcess);
      runner.isStreamingActive = true;
      runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);
      return realFetch(remote);
    };

    const result = await runAutoResolveAttempt(deps, "main");

    expect(result).toEqual({
      outcome: "deferred",
      lastError: "agent_background_work",
      didWork: false,
    });
  });

  describe("the interruption notice", () => {
    // No system-turn deps: the resolution turn is refused, which is the abort-notice path.
    const failingDeps = (
      git: GitManager,
      runner: SessionRunner,
      captured: { role: string; text: string }[],
      recordSyncCard?: boolean,
    ) => ({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      ...(recordSyncCard ? { recordSyncCard } : {}),
    });

    const interruptions = (captured: { text: string }[]) =>
      captured.filter((m) => m.text.includes("was interrupted before the conflicts"));

    it("is written once when the automatic path retries the same refusal", async () => {
      const { git, runner, captured } = conflictedSession();

      for (let i = 0; i < 5; i++) {
        await expect(runRebaseFlow(failingDeps(git, runner, captured), "main"))
          .rejects.toMatchObject({ statusCode: 409 });
      }

      expect(interruptions(captured)).toHaveLength(1);
    });

    it("is re-armed by any other ending, so a later recurrence is still reported", async () => {
      const { git, runner, captured } = conflictedSession();

      await expect(runRebaseFlow(failingDeps(git, runner, captured), "main"))
        .rejects.toMatchObject({ statusCode: 409 });
      // Fails before the conflict loop, so it says nothing about the interruption.
      await expect(runRebaseFlow(failingDeps(git, runner, captured), "no-such-base"))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(runRebaseFlow(failingDeps(git, runner, captured), "main"))
        .rejects.toMatchObject({ statusCode: 409 });

      expect(interruptions(captured)).toHaveLength(2);
    });

    it("answers every manual sync, which is one deliberate click each time", async () => {
      const { git, runner, captured } = conflictedSession();

      for (let i = 0; i < 3; i++) {
        await expect(runRebaseFlow(failingDeps(git, runner, captured, true), "main"))
          .rejects.toMatchObject({ statusCode: 409 });
      }

      expect(interruptions(captured)).toHaveLength(3);
    });
  });
});

describe("rebase-driver: pre-rebase workspace preparation", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-prepare-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRunner = (workDir: string): SessionRunner =>
    new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

  it("waits out an in-flight post-turn commit instead of rebasing into its index", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);

    fs.writeFileSync(path.join(workDir, "from-last-turn.txt"), "work\n");

    const order: string[] = [];
    const realRebase = git.rebase.bind(git);
    vi.spyOn(git, "rebase").mockImplementation(async (ref: string) => {
      order.push("rebase");
      return realRebase(ref);
    });

    const commitInFlight = withWorkspaceLock(workDir, async () => {
      execSync("git add -A", { cwd: workDir, stdio: "pipe" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      execSync("git commit -m 'Previous turn'", { cwd: workDir, stdio: "pipe" });
      order.push("commit");
    });

    const flow = runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
    }, "main");

    const [result] = await Promise.all([flow, commitInFlight]);

    expect(order).toEqual(["commit", "rebase"]);
    expect(result.status).toBe("rebased");
    expect(fs.readFileSync(path.join(workDir, "from-last-turn.txt"), "utf8")).toBe("work\n");
    expect(execSync("git log --oneline -3", { cwd: workDir }).toString()).toContain("Previous turn");
  });

  it("saves an otherwise-orphaned dirty tree through the commit pipeline, then rebases", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = makeRunner(workDir);

    fs.writeFileSync(path.join(workDir, "unsaved.txt"), "precious\n");
    const armPush = vi.fn();
    const commitPendingWork = vi.fn(async (deferPushArm: (arm: () => void) => void) => {
      execSync("git add -A && git commit -m 'Save work before syncing with main'", {
        cwd: workDir,
        stdio: "pipe",
      });
      deferPushArm(armPush);
      return { commitHash: execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim() };
    });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
      commitPendingWork,
    }, "main");

    expect(commitPendingWork).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("rebased");
    expect(result).toHaveProperty("forcePushed", true);
    expect(fs.readFileSync(path.join(workDir, "unsaved.txt"), "utf8")).toBe("precious\n");
    expect(armPush).not.toHaveBeenCalled();
  });

  it("refuses the sync when the pipeline cannot clean the tree, and says so durably", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    fs.writeFileSync(path.join(workDir, "has-a-secret.txt"), "sk-live-xxx\n");
    const headBefore = execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim();

    const armPush = vi.fn();
    const captured: { role: string; text: string }[] = [];
    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
      commitPendingWork: async (deferPushArm: (arm: () => void) => void) => {
        deferPushArm(armPush);
        return { commitHash: null };
      },
    }, "main")).rejects.toMatchObject({ statusCode: 409 });

    expect(execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim()).toBe(headBefore);
    expect(fs.readFileSync(path.join(workDir, "has-a-secret.txt"), "utf8")).toBe("sk-live-xxx\n");
    expect(messages.find((m) => m.type === "rebase_started")).toBeUndefined();

    const notice = captured.find((m) => m.text.includes("did not start"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("could not save this session's uncommitted changes");
    expect(notice?.text).toContain("your work is untouched");
    expect(armPush).toHaveBeenCalledTimes(1);
  });

  it("refuses a dirty tree with no save pipeline, and leaves no notice on the automatic path", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);

    fs.writeFileSync(path.join(workDir, "dirty.txt"), "mine\n");
    const headBefore = execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim();

    const captured: { role: string; text: string }[] = [];
    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main")).rejects.toMatchObject({ statusCode: 409 });

    expect(execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim()).toBe(headBefore);
    expect(fs.existsSync(path.join(workDir, "dirty.txt"))).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it("names an already-in-progress rebase instead of blaming the working tree", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);

    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });
    try {
      execSync("git rebase origin/main", { cwd: workDir, stdio: "pipe" });
    } catch { /* expected: conflicts */ }
    expect(await git.isRebaseInProgress()).toBe(true);

    const captured: { role: string; text: string }[] = [];
    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
    }, "main")).rejects.toMatchObject({ statusCode: 409 });

    const notice = captured.find((m) => m.text.includes("did not start"));
    expect(notice?.text).toContain("rebase is already in progress");
    expect(notice?.text).toContain("git rebase --abort");
  });

  it("releases the session hold when preparation refuses", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);
    fs.writeFileSync(path.join(workDir, "dirty.txt"), "mine\n");

    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main")).rejects.toBeDefined();

    expect(runner.systemTurnInProgress).toBe(false);
    expect(runner.running).toBe(false);
  });
});

describe("rebase-driver: pre-sync save — publication and handoff", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-save-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRunner = (workDir: string): SessionRunner =>
    new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

  it("never publishes the pre-sync commit when the session is on the base branch", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    const runner = makeRunner(workDir);
    const captured: { role: string; text: string }[] = [];
    fs.writeFileSync(path.join(workDir, "dirty-on-main.txt"), "local\n");

    const armPush = vi.fn();
    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
      commitPendingWork: async (deferPushArm: (arm: () => void) => void) => {
        execSync("git add -A && git commit -m 'Save work before syncing with main'", {
          cwd: workDir,
          stdio: "pipe",
        });
        deferPushArm(armPush);
        return { commitHash: execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim() };
      },
    }, "main");

    expect(result.status).toBe("up_to_date");
    expect(result).toHaveProperty("forcePushed", false);
    expect(execSync("git log --oneline -1", { cwd: workDir }).toString()).toContain("Save work");
    expect(armPush).not.toHaveBeenCalled();
    const notice = captured.find((m) => m.text.includes("NOT pushed"));
    expect(notice?.text).toContain("checked out on `main`");
  });

  it("still arms the pre-sync commit's push when preparation throws after the save", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);

    fs.writeFileSync(path.join(workDir, "unsaved.txt"), "precious\n");
    const armPush = vi.fn();

    const realInspect = git.inspectWorkingTree.bind(git);
    let inspections = 0;
    vi.spyOn(git, "inspectWorkingTree").mockImplementation(async () => {
      inspections++;
      if (inspections >= 2) throw new Error("status failed");
      return realInspect();
    });

    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
      commitPendingWork: async (deferPushArm: (arm: () => void) => void) => {
        execSync("git add -A && git commit -m 'Save work before syncing with main'", {
          cwd: workDir,
          stdio: "pipe",
        });
        deferPushArm(armPush);
        return { commitHash: execSync("git rev-parse HEAD", { cwd: workDir }).toString().trim() };
      },
    }, "main")).rejects.toBeDefined();

    expect(armPush).toHaveBeenCalledTimes(1);
  });

  it("refuses a tree dirtied after preparation, rather than letting git report it", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);
    const captured: { role: string; text: string }[] = [];

    const realFetch = git.fetch.bind(git);
    vi.spyOn(git, "fetch").mockImplementation(async (remote?: string) => {
      await realFetch(remote);
      fs.writeFileSync(path.join(workDir, "late-edit.txt"), "typed while syncing\n");
      execSync("git add -A", { cwd: workDir, stdio: "pipe" });
    });

    await expect(runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory(captured),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
    }, "main")).rejects.toMatchObject({ statusCode: 409 });

    const notice = captured.find((m) => m.text.includes("did not start"));
    expect(notice?.text).toContain("changed while the sync was preparing");
    expect(fs.readFileSync(path.join(workDir, "late-edit.txt"), "utf8")).toBe("typed while syncing\n");
    expect(vi.mocked(restoreLfsAfterTreeRewrite)).not.toHaveBeenCalled();
  });

  it("tags the failures it already explained, and only those", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    const runner = makeRunner(workDir);
    fs.writeFileSync(path.join(workDir, "dirty.txt"), "mine\n");

    const explained = await runFlow({
      git,
      githubAuthManager: makeStubAuth(false),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "x") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      recordSyncCard: true,
    }, "main").catch((err: unknown) => err);
    expect(syncFailureAlreadyExplained(explained)).toBe(true);

    expect(syncFailureAlreadyExplained(new Error("fetch died"))).toBe(false);
    expect(syncFailureAlreadyExplained(null)).toBe(false);
  });
});

describe("rebase-driver: docs/303 post-rebase follow-up", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-followup-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Two feature commits over one upstream commit on the same file: the rebase replays them
  // one at a time, so each conflicts in its own round.
  function createTwoRoundConflict(bareDir: string, workDir: string) {
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "shared.txt"), "feature edit one\n");
    execSync("git add -A && git commit -m 'Feature one'", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "shared.txt"), "feature edit two\n");
    execSync("git add -A && git commit -m 'Feature two'", { cwd: workDir, stdio: "pipe" });

    const tempClone = path.join(path.dirname(workDir), "temp-clone-2");
    fs.mkdirSync(tempClone, { recursive: true });
    execSync(`git clone ${bareDir} .`, { cwd: tempClone, stdio: "pipe" });
    execSync("git checkout main", { cwd: tempClone, stdio: "pipe" });
    fs.writeFileSync(path.join(tempClone, "shared.txt"), "upstream edit\n");
    execSync("git add -A && git commit -m 'Upstream change'", { cwd: tempClone, stdio: "pipe" });
    execSync("git push", { cwd: tempClone, stdio: "pipe" });
    fs.rmSync(tempClone, { recursive: true, force: true });
  }

  function baseDeps(git: GitManager, runner: SessionRunner, resolve: (cwd: string) => string) {
    return {
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(resolve) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    };
  }

  it("an arm made while resolving conflicts rides the concluded rebase", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow(baseDeps(git, runner, (cwd) => {
      armFollowupNote("s1", "re-run codegen over the merged result");
      fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
      return "Resolved.";
    }), "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(result).toHaveProperty("followup");
    if (result.status === "conflicts_resolved") {
      expect(result.followup?.notes).toEqual(["re-run codegen over the merged result"]);
      expect(result.followup?.baseBranch).toBe("main");
      expect(result.followup?.forcePushed).toBe(true);
      expect(result.followup?.headFrom).not.toBe(result.followup?.headTo);
    }
    // Consumed at the conclusion, so a later rebase cannot inherit it.
    expect(followupWindowOpen("s1")).toBe(false);
  });

  it("notes armed in different conflict rounds all arrive", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createTwoRoundConflict(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s2", sessionDir: workDir, defaultAgentId: "claude" });

    let round = 0;
    const result = await runFlow(baseDeps(git, runner, (cwd) => {
      round++;
      armFollowupNote("s2", `note from round ${round}`);
      fs.writeFileSync(path.join(cwd, "shared.txt"), `resolved round ${round}\n`);
      return "Resolved.";
    }), "main");

    expect(round).toBeGreaterThan(1);
    expect(result.status).toBe("conflicts_resolved");
    if (result.status === "conflicts_resolved") {
      expect(result.followup?.notes).toEqual(
        Array.from({ length: round }, (_, i) => `note from round ${i + 1}`),
      );
    }
  });

  it("a clean rebase carries no notes and opens no window — its turn never runs", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s3", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow(baseDeps(git, runner, () => "should not run"), "main");

    expect(result.status).toBe("rebased");
    expect(result).not.toHaveProperty("followup");
    expect(followupWindowOpen("s3")).toBe(false);
  });

  it("an up-to-date branch carries no notes", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s4", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runFlow(baseDeps(git, runner, () => "should not run"), "main");

    expect(result.status).toBe("up_to_date");
    expect(result).not.toHaveProperty("followup");
    expect(followupWindowOpen("s4")).toBe(false);
  });

  it("an aborted rebase discards the arm — the branch is unchanged, so nothing follows", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s5", sessionDir: workDir, defaultAgentId: "claude" });

    await expect(runFlow(baseDeps(git, runner, () => {
      armFollowupNote("s5", "never delivered");
      throw new Error("agent blew up mid-resolution");
    }), "main")).rejects.toThrow();

    expect(followupWindowOpen("s5")).toBe(false);
  });

  it("req 3: an attempt that times out with a hanging agent leaves no window", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s6", sessionDir: workDir, defaultAgentId: "claude" });

    // Arms, then hangs: the resolution turn settles only through its completion callback, so
    // the flow's `finally` never runs and cannot be what closes the window.
    let armed = false;
    const hangingAgent = () => Object.assign(new EventEmitter(), {
      agentId: "claude" as const,
      capabilities: {
        supportsResume: true, supportsImages: false, supportsSystemPrompt: true,
        supportsPermissionModes: false, supportedPermissionModes: [], toolNames: [],
        models: [], supportsReview: true,
      },
      run: () => {
        armFollowupNote("s6", "would wake on someone else's rebase");
        armed = true;
      },
      kill: () => {},
    }) as unknown as AgentProcess;

    const attemptDeps = {
      ...baseDeps(git, runner, () => "unused"),
      agentFactory: hangingAgent,
      // See the note on the other 3s deadline: 250ms expired before the dispatch under load.
      timeoutMs: 3_000,
    };
    wireSystemTurnDeps(attemptDeps);
    const result = await runAutoResolveAttempt(attemptDeps, "main");

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout" });
    // Without this the deadline could have expired before a window ever opened, and the
    // assertion below would hold for the wrong reason.
    expect(armed).toBe(true);
    expect(followupWindowOpen("s6")).toBe(false);
  });

  it("req 3: a window the flow opens AFTER the deadline fired is closed at once", async () => {
    // The flow is raced, not cancelled, so it can reach its first conflict after the attempt
    // already returned "timeout" — with no deadline left to close what it opens.
    const workDir = fs.mkdtempSync(path.join(tmpDir, "late-window-"));
    const runner = new SessionRunner({ sessionId: "s8", sessionDir: workDir, defaultAgentId: "claude" });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let openedLate = false;
    const attemptDeps = {
      ...baseDeps(new GitManager(workDir), runner, () => "unused"),
      git: {
        isClean: () => Promise.resolve(true),
        isRebaseInProgress: () => Promise.resolve(false),
        inspectWorkingTree: () => Promise.resolve({ clean: true, conflictedFiles: [], unreadable: null }),
        // Outlives the deadline, so everything after it runs on a timed-out attempt.
        fetch: async () => { await sleep(60); },
        resolveBaseBranchRef: () => Promise.resolve("base-sha"),
        getHeadHash: () => Promise.resolve("head-sha"),
        getRefHash: () => Promise.resolve(null),
        isAncestor: () => Promise.resolve(false),
        rebase: () => Promise.resolve({ status: "conflicts", conflicts: [{ path: "shared.txt", content: "" }] }),
        rebaseAbort: () => Promise.resolve(),
      } as unknown as GitManager,
      agentFactory: () => Object.assign(new EventEmitter(), {
        agentId: "claude" as const,
        capabilities: {
          supportsResume: true, supportsImages: false, supportsSystemPrompt: true,
          supportsPermissionModes: false, supportedPermissionModes: [], toolNames: [],
          models: [], supportsReview: true,
        },
        run: () => { openedLate = true; },
        kill: () => {},
      }) as unknown as AgentProcess,
      timeoutMs: 20,
    };
    wireSystemTurnDeps(attemptDeps);
    const result = await runAutoResolveAttempt(attemptDeps, "main");

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout" });
    await vi.waitFor(() => expect(openedLate).toBe(true));
    expect(followupWindowOpen("s8")).toBe(false);
  });

  it("the automatic path delivers only after its own LFS restore and queue drain", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s7", sessionDir: workDir, defaultAgentId: "claude" });

    const order: string[] = [];
    vi.mocked(restoreLfsAfterTreeRewrite).mockImplementation(() => {
      order.push("restore");
      return Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false });
    });

    // Recorded at dispatch, not when the agent process starts: turn setup is async, so an
    // agent-side marker lands after this path's cleanup however the delivery is ordered.
    const realDispatch = runner.dispatch.bind(runner);
    (runner as unknown as { dispatch: typeof runner.dispatch }).dispatch = (opts, admission) => {
      if (opts.text.includes("you resolved conflicts for")) order.push("followup");
      return realDispatch(opts, admission);
    };

    const attemptDeps = {
      ...baseDeps(git, runner, (cwd) => {
        order.push("resolve");
        armFollowupNote("s7", "re-run the tests");
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved.";
      }),
      drainQueue: () => { order.push("drain"); },
    };
    wireSystemTurnDeps(attemptDeps);
    const result = await runAutoResolveAttempt(attemptDeps, "main");

    expect(result).toMatchObject({ outcome: "success" });
    await vi.waitFor(() => expect(order).toContain("followup"));
    expect(order.lastIndexOf("restore")).toBeLessThan(order.indexOf("followup"));
    expect(order.indexOf("drain")).toBeLessThan(order.indexOf("followup"));
  });
});

describe("rebase-driver: planning#556 the runner is held across the rebase's publication segment", () => {
  const SESSION_ID = "22222222-2222-4222-8222-222222222222";

  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-hold-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRunner(workDir: string): SessionRunner {
    return new SessionRunner({ sessionId: SESSION_ID, sessionDir: workDir, defaultAgentId: "claude" });
  }

  function resolvingAgentFactory(): () => AgentProcess {
    return () => new FakeRebaseAgent((cwd) => {
      fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
      return "Resolved shared.txt.";
    }) as unknown as AgentProcess;
  }

  /**
   * Every step here runs with `running` already false, so the lease is the only thing
   * standing between the rebase and an idle reclaim. `at` names the step so a failure
   * says which part of the segment lost its cover.
   */
  function instrumentSegment(
    git: GitManager,
    runner: SessionRunner,
    onStep: (at: string) => void,
  ): void {
    const wrap = (name: "rebase" | "stageAll" | "rebaseContinue" | "forcePush"): void => {
      const orig = git[name].bind(git) as (...args: unknown[]) => Promise<unknown>;
      (git as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        expect(runner.running, `runner.running at ${name}`).toBe(false);
        onStep(name);
        return orig(...args);
      };
    };
    wrap("rebase");
    wrap("stageAll");
    wrap("rebaseContinue");
    wrap("forcePush");
  }

  it("agentBusy stays true at every step of the segment, and only drops while a turn runs", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = makeRunner(workDir);
    const busyAt: Record<string, boolean> = {};
    instrumentSegment(git, runner, (at) => { busyAt[at] = runner.agentBusy; });

    // The branch-synced card is appended after the push, at the very end of the
    // segment. Match on the card itself: the resolution turn appends rows too.
    let busyAtCard: boolean | null = null;
    const history = makeStubHistory([]);
    const origAppend = history.append.bind(history);
    history.append = (sessionId, msg) => {
      if ((msg as { branchSynced?: unknown }).branchSynced) busyAtCard = runner.agentBusy;
      return origAppend(sessionId, msg);
    };

    // Only a running resolution turn may see the lease dropped; `running` covers it there.
    let busyDuringTurn: boolean | null = null;
    let runningDuringTurn: boolean | null = null;
    let leasedDuringTurn: boolean | null = null;

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: history,
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        busyDuringTurn = runner.agentBusy;
        runningDuringTurn = runner.running;
        leasedDuringTurn = runner.postTurnWorkInFlight;
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved shared.txt.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(Object.keys(busyAt).sort()).toEqual(["forcePush", "rebase", "rebaseContinue", "stageAll"]);
    for (const [at, busy] of Object.entries(busyAt)) {
      expect(busy, `agentBusy at ${at}`).toBe(true);
    }
    expect(busyAtCard).toBe(true);
    expect(runningDuringTurn).toBe(true);
    expect(busyDuringTurn).toBe(true);
    // Dropped, not held across the whole flow: POST_TURN_HOLD_MAX_MS is 120s and a
    // multi-round rebase outlives it, so a flow-wide lease would expire mid-flow.
    expect(leasedDuringTurn).toBe(false);
    // The flow must not leave the lease behind once it returns.
    expect(runner.agentBusy).toBe(false);
    expect(runner.postTurnWorkInFlight).toBe(false);
  });

  it("a non-forced dispose() is declined throughout the segment", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = makeRunner(workDir);
    const declinedAt: string[] = [];
    instrumentSegment(git, runner, (at) => {
      runner.dispose();
      if (!runner.disposed) declinedAt.push(at);
    });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: resolvingAgentFactory(),
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(runner.disposed).toBe(false);
    expect(declinedAt.sort()).toEqual(["forcePush", "rebase", "rebaseContinue", "stageAll"]);
  });

  it("an over-budget idle-enforcer pass mid-publication leaves the container alone", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = makeRunner(workDir);
    const registry = new SessionRunnerRegistry({
      runnerFactory: () => runner as unknown as SessionRunnerInterface,
    });
    registry.getOrCreate(SESSION_ID, workDir, "claude");

    const destroyAgentContainer = vi.fn().mockResolvedValue(undefined);
    const containerManager = {
      getAll: () => [{ sessionId: SESSION_ID }],
      isStandby: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
      destroyAgentContainer,
    } as unknown as SessionContainerManager;

    // A fresh snapshot per pass: the enforcer refuses to act twice on the same object.
    const enforce = createIdleEnforcer({
      containerManager,
      runnerRegistry: registry,
      getMemoryStats: (): DockerMemoryStats => ({
        usedBytes: 200,
        totalBytes: 100,
        budgetBytes: 100,
        bySession: { [SESSION_ID]: { agentBytes: 100, serviceBytes: 0 } },
      }),
    });

    // No viewer is attached, which is exactly the idle auto-resolve shape (docs/146).
    expect(runner.viewerCount).toBe(0);
    const passes: string[] = [];
    instrumentSegment(git, runner, (at) => { passes.push(at); enforce(); });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: resolvingAgentFactory(),
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(passes).toHaveLength(4);
    expect(destroyAgentContainer).not.toHaveBeenCalled();
    expect(runner.disposed).toBe(false);

    // The same pass reclaims it once the flow has released the lease — the fixture
    // is over budget for a reason, so this is not a test that can never reclaim.
    enforce();
    expect(destroyAgentContainer).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("rebase-driver: planning#556 leases that a neighbour can invalidate", () => {
  const SESSION_ID = "33333333-3333-4333-8333-333333333333";

  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-lease-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a resolution turn whose own lease expired does not take the flow's with it", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    // Only Date is faked: the flow needs real timers for its git work to settle.
    vi.useFakeTimers({ toFake: ["Date"] });

    const runner = new SessionRunner({
      sessionId: SESSION_ID, sessionDir: workDir, defaultAgentId: "claude",
    });

    // PostTurnHold.begin() zeroes an expired depth, so an expired predecessor's end()
    // consumes the lease taken after it. Age the turn executor's lease past the
    // deadline while its turn still runs, which is the only way to produce that order.
    const origBegin = runner.beginPostTurnWork.bind(runner);
    let aged = false;
    runner.beginPostTurnWork = () => {
      origBegin();
      // The turn executor is the only holder that takes its lease with the agent still
      // attached; the driver's own takes all happen after the agent is detached.
      if (aged || runner.getAgent() === null) return;
      aged = true;
      vi.setSystemTime(Date.now() + POST_TURN_HOLD_MAX_MS + 1_000);
    };

    const busyAt: Record<string, boolean> = {};
    for (const name of ["stageAll", "rebaseContinue", "forcePush"] as const) {
      const orig = git[name].bind(git) as (...args: unknown[]) => Promise<unknown>;
      (git as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        busyAt[name] = runner.agentBusy;
        return orig(...args);
      };
    }

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent((cwd) => {
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved shared.txt.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("conflicts_resolved");
    expect(aged).toBe(true);
    expect(busyAt).toEqual({ stageAll: true, rebaseContinue: true, forcePush: true });
  });

  it("the auto-resolve timeout holds the runner across its own teardown", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({
      sessionId: SESSION_ID, sessionDir: workDir, defaultAgentId: "claude",
    });

    // onAgentFinished() emits `idle`, which the runner registry wires straight to the
    // idle enforcer — so this is the exact moment a reclaim would be decided.
    const busyAtIdle: boolean[] = [];
    runner.on("idle", () => busyAtIdle.push(runner.agentBusy));

    const busyAtAbort: boolean[] = [];
    const origAbort = git.rebaseAbort.bind(git);
    git.rebaseAbort = async () => {
      busyAtAbort.push(runner.agentBusy);
      return origAbort();
    };

    // Counted below: a deadline that expires before the agent ever runs would measure
    // the wrong thing, so the headroom over real git setup is deliberate.
    const runs = vi.fn();
    const hangingAgent = () => Object.assign(new EventEmitter(), {
      agentId: "claude" as const,
      capabilities: {
        supportsResume: true, supportsImages: false, supportsSystemPrompt: true,
        supportsPermissionModes: false, supportedPermissionModes: [], toolNames: [],
        models: [], supportsReview: true,
      },
      run: runs,
      kill: () => {},
    }) as unknown as AgentProcess;

    const attemptDeps = {
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: hangingAgent,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
      timeoutMs: 3_000,
    };
    wireSystemTurnDeps(attemptDeps);

    const result = await runAutoResolveAttempt(attemptDeps, "main");

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout" });
    expect(runs).toHaveBeenCalledTimes(1);
    // The first idle is the deadline's own onAgentFinished(), mid-teardown.
    expect(busyAtIdle[0]).toBe(true);
    expect(busyAtAbort.length).toBeGreaterThan(0);
    for (const busy of busyAtAbort) expect(busy).toBe(true);
    // Taken, not leaked: a teardown lease that is never released would keep the
    // session unreclaimable until the deadline expires it.
    expect(runner.postTurnWorkInFlight).toBe(false);
  });

  it("a clean rebase that outruns the deadline re-arms before publishing", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    vi.useFakeTimers({ toFake: ["Date"] });

    const runner = new SessionRunner({
      sessionId: SESSION_ID, sessionDir: workDir, defaultAgentId: "claude",
    });

    // No resolution turn on this path, so nothing else refreshes the lease taken at
    // the top of the flow. Age the clock across the rebase itself.
    const origRebase = git.rebase.bind(git);
    git.rebase = async (ref: string) => {
      const result = await origRebase(ref);
      vi.setSystemTime(Date.now() + POST_TURN_HOLD_MAX_MS + 1_000);
      return result;
    };

    let busyAtPush: boolean | null = null;
    const origPush = git.forcePush.bind(git);
    git.forcePush = async () => {
      busyAtPush = runner.agentBusy;
      const message = await origPush();
      // Age it again so the teardown below starts on an expired lease too.
      vi.setSystemTime(Date.now() + POST_TURN_HOLD_MAX_MS + 1_000);
      return message;
    };

    // The handback is the last step of the flow's teardown, after LFS restoration has
    // run its own begin/end over the same counter — which zeroes an expired depth and
    // then drops it, so the teardown needs a lease of its own.
    const busyAtHandback: boolean[] = [];
    vi.mocked(handWorkspaceBackToWorker).mockImplementation(() => {
      busyAtHandback.push(runner.agentBusy);
    });

    const result = await runFlow({
      git,
      githubAuthManager: makeStubAuth(true),
      runner,
      sessionManager: makeStubSessionManager(),
      chatHistoryManager: makeStubHistory([]),
      agentFactory: () => new FakeRebaseAgent(() => "should not run") as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    expect(result.status).toBe("rebased");
    expect(busyAtPush).toBe(true);
    expect(busyAtHandback.length).toBeGreaterThan(0);
    for (const busy of busyAtHandback) expect(busy).toBe(true);
    expect(runner.postTurnWorkInFlight).toBe(false);
  });
});

// planning#554 — the flow's `finally` used `!runner.running` as an ownership check for
// systemTurnInProgress. It is not one: a turn can run without owning the hold, and the hold
// can change hands with no turn running at all.
describe("rebase-driver: the flow releases its own hold, not whatever the flag holds", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let origGitEditor: string | undefined;

  beforeEach(() => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rebase-hold-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    origGitEditor = process.env.GIT_EDITOR;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
    process.env.GIT_EDITOR = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    if (origGitEditor !== undefined) process.env.GIT_EDITOR = origGitEditor;
    else delete process.env.GIT_EDITOR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupDivergedSession(): { git: GitManager; runner: SessionRunner; deps: Parameters<typeof runRebaseFlow>[0] } {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    return {
      git,
      runner,
      deps: {
        git,
        githubAuthManager: makeStubAuth(true),
        runner,
        sessionManager: makeStubSessionManager(),
        chatHistoryManager: makeStubHistory([]),
        agentFactory: () => new FakeRebaseAgent(() => "Ran the queued user turn.") as unknown as AgentProcess,
        usageManager: makeStubUsageManager(),
        sseBroadcast: () => {},
      },
    };
  }

  /** The push is a non-turn step of the flow — the incident's window. */
  function duringTheFlow(git: GitManager, inject: () => void): void {
    vi.spyOn(git, "forcePush").mockImplementation(async () => {
      inject();
      return "pushed";
    });
  }

  it("releases the hold when a CLI-started turn was adopted mid-flow", async () => {
    const { git, runner, deps } = setupDivergedSession();
    let queued: { settled: Promise<{ status: string }> } | null = null;

    duringTheFlow(git, () => {
      queued = runner.dispatch(testDispatch({ text: "and now do the other thing" }));
      // What adoptCliStartedTurn (ws-handlers/agent-listeners.ts) does for a self-wake: it starts
      // a turn ShipIt never dispatched, moves the turn epoch, and takes no system hold.
      resetRunnerTurnState(runner);
      runner.running = true;
    });

    expect((await runFlow(deps, "main")).status).toBe("rebased");
    expect(runner.queueLength).toBe(1);
    expect(runner.systemTurnInProgress).toBe(false);

    // The stall the incident produced: with the hold stranded, nothing this session does again
    // can start a turn — not even the adopted turn's own teardown drain.
    runner.running = false;
    expect(releaseQueuedTurn(runner)).toBe(true);
    expect((await queued!.settled).status).toBe("completed");
    expect(runner.queueLength).toBe(0);
  });

  it("leaves a hold taken over mid-flow alone, and drains nothing under it", async () => {
    const { git, runner, deps } = setupDivergedSession();

    duringTheFlow(git, () => {
      runner.dispatch(testDispatch({ text: "and now do the other thing" }));
      // Another owner takes the session between turns. Every write of `true` mints a new ticket,
      // so this is a different hold even though the flag never went false (docs/304).
      runner.systemTurnInProgress = true;
    });

    expect((await runFlow(deps, "main")).status).toBe("rebased");

    // Its owner may be mid-rebase itself; handing it a queued turn is what docs/304 stopped.
    expect(runner.systemTurnInProgress).toBe(true);
    expect(runner.queueLength).toBe(1);
  });
});
