import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { SessionRunner } from "../session-runner.js";
import {
  runRebaseFlow,
  runAutoResolveAttempt,
  buildRebaseConflictPrompt,
  buildBranchSyncAgentNotice,
  MAX_REBASE_ITERATIONS,
  syncFailureAlreadyExplained,
} from "./rebase-driver.js";
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


async function runFlow(
  deps: Parameters<typeof runRebaseFlow>[0],
  baseBranch: string,
): ReturnType<typeof runRebaseFlow> {
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

    const hangingAgent = () => Object.assign(new EventEmitter(), {
      agentId: "claude" as const,
      capabilities: {
        supportsResume: true, supportsImages: false, supportsSystemPrompt: true,
        supportsPermissionModes: false, supportedPermissionModes: [], toolNames: [],
        models: [], supportsReview: true,
      },
      run: () => {},
      kill: () => {},
    }) as unknown as AgentProcess;

    const result = await runAutoResolveAttempt({
      ...deps(git, runner, true),
      agentFactory: hangingAgent,
      timeoutMs: 250,
      drainQueue: () => { order.push("drain"); },
    }, "main");

    expect(result).toMatchObject({ outcome: "error", lastError: "timeout" });
    expect(order.indexOf("restore")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("drain"));
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
