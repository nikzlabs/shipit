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
} from "./rebase-driver.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { releaseQueuedTurn } from "../queue-drain.js";
import { testDispatch } from "../integration_tests/dispatch-test-helpers.js";
import type { AgentProcess, AgentEvent, AgentRunParams, WsServerMessage } from "../../shared/types.js";

// planning#146: the rebase driver must hand the workspace (BOTH `.git` AND the
// worktree) back to the worker uid after its root-run git ops (the
// `postTurn: "none"` path elides the usual post-turn handoff). It does so via the
// shared `handWorkspaceBackToWorker` helper, whose `.git`/worktree/dep-dir
// internals are unit-tested in session-worker-uid.test.ts. The real helper is a
// no-op unless SHIPIT_SESSION_WORKER_UID is set AND the process can chown to that
// uid (root-only), and a test can't drop to uid 1000 to reproduce the real
// EACCES — so we spy on it to assert the driver WIRES the handoff. The
// end-to-end "agent edits a root-owned conflicted file as 1000" proof is the
// manual dev validation, noted in docs/150. importOriginal keeps the module's
// other exports intact for transitive importers.
vi.mock("../session-worker-uid.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's importOriginal generic requires an inline import() type
  const actual = await importOriginal<typeof import("../session-worker-uid.js")>();
  return { ...actual, handWorkspaceBackToWorker: vi.fn() };
});
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";

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

/**
 * Minimal stub for SessionManager — `get` plus the docs/221 pending-notice slot,
 * which the driver writes on a manual sync that moved the branch. `notices`
 * is exposed so a test can assert what the agent will be told next turn.
 */
function makeStubSessionManager(notices: string[] = []): SessionManager {
  return {
    get: (sessionId: string) => ({ sessionId, agentSessionId: undefined }),
    setAgentSessionId: () => {},
    setLastTurnErrored: () => {},
    setPendingAgentNotice: (_id: string, notice: string) => { notices.push(notice); },
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

  // A rebase rewrites the working tree from the orchestrator, so the incoming
  // `shipit.yaml` / compose file can declare services the running session knows
  // nothing about. The in-container inotify watcher is not a dependable signal
  // for a cross-container write (and is started best-effort), so the driver
  // tells the runner directly. Without this, "sync with main" silently leaves
  // the session running the pre-rebase compose stack.
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

  it("up-to-date branch — does NOT re-evaluate config (the tree never changed)", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);

    const runner = new SessionRunner({
      sessionId: "s1",
      sessionDir: workDir,
      defaultAgentId: "claude",
    });
    const reevaluate = vi.fn();
    (runner as unknown as { reevaluateWorkspaceConfig: () => void }).reevaluateWorkspaceConfig = reevaluate;

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
        // "Resolve" by writing a clean merged version.
        fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
        return "Resolved shared.txt by merging both edits.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
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

  // planning#146: every `runRebaseFlow` exit path must hand BOTH `.git` AND the
  // worktree back to the worker uid, because the driver runs its git ops as the
  // root orchestrator (which re-roots both) and dispatches resolution turns with
  // `postTurn: "none"` (which elides the usual post-turn handoff). Handing only
  // `.git` back restores git operability but leaves the conflicted files the
  // agent must EDIT root-owned, so the resolution turn still fails EACCES.
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

    // The worktree handoff MUST have fired by the time the agent runs (so the
    // conflicted file is writable). Assert it from inside the resolution fn.
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
    // The handoff fires at least twice: before the resolution turn + in the
    // final finally.
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

    // The finally must still run on the throw path — for both handoffs.
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith(workDir);
  });
});

/** Advance origin/main by one commit via a throwaway clone (so workDir's
 * origin/main diverges from its local main without touching local main). */
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

/** Two-method stub matching `RebasePrStatusPoller`, with call-arg assertions. */
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

/**
 * planning#369 — the rebase flow is what CLEARS GitHub's `CONFLICTING` state, so it
 * owes the PR-status poller a nudge. Without it the card kept its "Merge
 * conflicts" chip and "Resolve conflicts" button for up to a slow tick (120s),
 * and indefinitely with the polling gate closed, after the fix had landed.
 */
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
    // Both halves: the cadence bump alone waits a full slow tick for the first
    // reading; the one-shot alone often catches GitHub mid-recompute (UNKNOWN).
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
    // GitHub's view of the branch did not change — a refresh would only cost a
    // request and re-render the same conflicting state.
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

    // The push already landed; a failed status refresh must not undo that.
    expect(result).toHaveProperty("forcePushed", true);
  });
});

/**
 * planning#369 (secondary) — the up-to-date short-circuit asks a purely LOCAL
 * question, while GitHub computes `mergeable` from the PUSHED head. A branch
 * holding an unpushed commit is "up to date" locally and CONFLICTING on GitHub,
 * and the old code pushed nothing — so the chip could never clear, however many
 * times the user pressed the button.
 */
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

  /** Branch already contains origin/main, is pushed, then gains a local-only commit. */
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
    expect(await git.getRefHash("origin/feature")).not.toBe(localHead); // remote is behind

    const result = await runFlow({ ...deps(git, runner, true, poller), recordSyncCard: true }, "main");

    // Still an up-to-date rebase — nothing was replayed — but the remote caught up.
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
      expect(card.card.headFromSha).toBe(card.card.headToSha); // no rebase happened
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

  // The session CAN be on the base branch — `syncLocalBaseRef` has a clause for
  // exactly that. `origin/main` is trivially an ancestor of a `main` checkout
  // carrying local commits, so without the guard "Sync with main" would publish
  // straight to `main` and bypass the pull request.
  it("session is ON the base branch — refuses to publish to it", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    // Still on `main`, pushed, then a local-only commit.
    fs.writeFileSync(path.join(workDir, "local-only.txt"), "never pushed\n");
    execSync("git add -A && git commit -m 'Local only'", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    const originMainBefore = await git.getRefHash("origin/main");

    const result = await runFlow(deps(git, runner, true), "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("origin/main")).toBe(originMainBefore); // untouched
    expect(messages.find((m) => m.type === "github_push_result")).toBeUndefined();
  });

  // The ancestry question is asked of HEAD, but `git push origin <branch>` pushes
  // the BRANCH REF. When those disagree — a detached HEAD, where
  // `getCurrentBranch()` falls back to a name rather than reporting the
  // detachment — the push aims at a ref the check never examined. Here the branch
  // ref already matches origin, so the push is a silent no-op that would
  // nonetheless be reported as a successful force-push, and the commit on the
  // detached HEAD would never reach GitHub at all.
  it("HEAD is detached ahead of the branch ref — declines rather than reporting a phantom push", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    execSync("git checkout --detach HEAD", { cwd: workDir, stdio: "pipe" });
    fs.writeFileSync(path.join(workDir, "detached.txt"), "off-branch\n");
    execSync("git add -A && git commit -m 'Detached commit'", { cwd: workDir, stdio: "pipe" });
    // Reproduce the fallback: a detached HEAD reported as an ordinary branch.
    vi.spyOn(git, "getCurrentBranch").mockResolvedValue("feature");

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const originFeatureBefore = await git.getRefHash("origin/feature");

    const result = await runFlow(deps(git, runner, true), "main");
    vi.mocked(git.getCurrentBranch).mockRestore();

    // No push, and — critically — no claim that one happened.
    expect(result).toHaveProperty("forcePushed", false);
    expect(await git.getRefHash("origin/feature")).toBe(originFeatureBefore);
  });

  /** Land a third-party commit on `origin/feature` from a throwaway clone. */
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

    // The flow's own fetch sees the divergence, so the ancestor clause declines.
    expect(result).toHaveProperty("forcePushed", false);
    expect(await git.getRefHash("origin/feature")).toBe(racerSha);
  });

  // The window the ancestor check cannot close: a commit landing between the
  // check and the push. `git.forcePush()` re-reads the LIVE tip and leases
  // against that, so it would have adopted the racer's commit as the lease and
  // overwritten it. Passing the checked sha makes git reject the push instead.
  // Simulated by making the check observe the pre-racer tip, which is exactly
  // what a real race looks like from inside the flow.
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
    // The racer's commit is still the remote tip — not clobbered.
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });
    expect(await git.getRefHash("origin/feature")).toBe(racerSha);
    expect(messages.find((m) => m.type === "git_push_rejected")).toBeDefined();
  });

  // `writeBack` in auto-conflict-resolve-manager.ts derives `pushed` from
  // `outcome === "success" && forcePushed`. Reporting a push as `deferred` would
  // skip the settle window and leave await-fresh-signal unarmed, so the next poll
  // — still holding GitHub's pre-push CONFLICTING verdict — re-fires against a
  // head that no longer has the conflict. That is the docs/146 spin.
  it("auto-resolve: an up-to-date flow that pushed is reported as success, not deferred", async () => {
    const { workDir, git } = setupUnpushedCommit(tmpDir);
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runAutoResolveAttempt(deps(git, runner, true), "main");

    expect(result).toMatchObject({ outcome: "success", forcePushed: true, didWork: true });
  });

  it("auto-resolve: a genuine no-op stays a suppressed deferral", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });

    const result = await runAutoResolveAttempt(deps(git, runner, true), "main");

    // Nothing changed on GitHub, so the budget must not move and the UI must not
    // flash a contradicting envelope after the inner `rebase_complete`.
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

    // Local main fast-forwarded to origin/main (the headline correctness ask).
    expect(await git.getRefHash("main")).toBe(await git.getRefHash("origin/main"));

    // A persisted, broadcast card recording the move.
    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();
    if (card?.type === "branch_synced_card") {
      expect(card.card.base).toBe("main");
      expect(card.card.forcePushed).toBe(true);
      expect(card.card.headFromSha).not.toBe(card.card.headToSha); // branch rebased
    }
    // The card is written to chat history (survives reload), not emit-only.
    expect(captured.some((m) => m.branchSynced)).toBe(true);
  });

  it("does NOT emit a sync card when recordSyncCard is unset (auto-resolve path) — but still moves local main", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createCleanDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow(baseDeps(git, runner, [], true), "main");

    expect(result.status).toBe("rebased");
    expect(messages.find((m) => m.type === "branch_synced_card")).toBeUndefined();
    // Local base move is unconditional (plain correctness), independent of the card.
    expect(await git.getRefHash("main")).toBe(await git.getRefHash("origin/main"));
  });

  it("up-to-date branch but local main behind — moves main, emits card, and flags baseMoved on rebase_complete", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    execSync("git checkout -b feature", { cwd: workDir, stdio: "pipe" });
    // Advance origin/main, then bring feature up to date so the sync is a no-op
    // rebase — leaving local main the only thing still behind.
    advanceOriginMain(bareDir, workDir, "up.txt", "up\n");
    execSync("git fetch origin", { cwd: workDir, stdio: "pipe" });
    execSync("git rebase origin/main", { cwd: workDir, stdio: "pipe" });
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });

    const originMain = await git.getRefHash("origin/main");
    expect(await git.getRefHash("main")).not.toBe(originMain); // local main is behind

    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    const result = await runFlow({ ...baseDeps(git, runner, [], true), recordSyncCard: true }, "main");

    expect(result.status).toBe("up_to_date");
    expect(await git.getRefHash("main")).toBe(originMain); // local main caught up

    const card = messages.find((m) => m.type === "branch_synced_card");
    expect(card).toBeDefined();

    const complete = messages.find((m) => m.type === "rebase_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "rebase_complete") {
      expect(complete.upToDate).toBe(true);
      expect(complete.baseMoved).toBe(true); // suppresses the "Already up to date" toast
    }
  });

  it("nothing to do (local main already current) — still records the manual sync", async () => {
    const { workDir, git } = setupRepoWithRemote(tmpDir);
    // No divergence: session is on main, which already matches origin/main.
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

/**
 * docs/221 — the agent-facing half of a manual sync. The card tells the user; a
 * pending notice tells the agent on its next turn, because the sync itself runs
 * with no turn in flight to prepend to.
 */
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
    // Structural anchors only — the prose is copy, not contract.
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

/**
 * planning#338 — a production session stranded mid-rebase: a queued user message was
 * dispatched while the conflict-resolution system turn was in flight, its fresh
 * proxy displaced the resolution turn's agent slot, and the driver's
 * continuation (`git add -A && git rebase --continue`) never ran — nor did
 * anything run `git rebase --abort`, so every later turn's auto-commit refused
 * with "rebase in progress" until a human cleaned up by hand.
 *
 * Two independent fixes under test here:
 *  1. The flow HOLDS `systemTurnInProgress` for its whole duration and every
 *     user-turn entry path respects it, so a message arriving mid-flow queues
 *     and drains after the flow settles.
 *  2. Defense in depth: when a resolution turn is displaced (or otherwise ends
 *     short of `completed`) anyway, the driver aborts the rebase and leaves a
 *     persisted notice — the workspace can never strand mid-rebase.
 */
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

  /** A resolution agent whose turn is displaced by a newer spawn: it emits
   * `superseded` (what `supersedeDisplacedAgent` fires at the displaced proxy)
   * and never produces a result — its terminal events would be sse-dropped as
   * stale in production. */
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

    // The incident state: nothing continued OR aborted the rebase, so the
    // workspace sat mid-rebase and auto-commit refused forever. The driver now
    // aborts before rethrowing.
    expect(await git.isRebaseInProgress()).toBe(false);
    // The user gets a durable explanation, not just a transient WS event.
    const notice = captured.find((m) => m.text.includes("aborted"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("interrupted");
    // The displaced turn does not re-assert the flow's hold — the displacing
    // turn owns the runner now, and the flag is not the flow's to keep.
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

    // Before planning#338 the user-driven path relied on the route's `rebase_aborted`
    // EVENT alone and never touched git — the rebase stayed in progress.
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
          // A user message arrives while the resolution turn is running. It
          // must queue — not displace the resolution turn's agent slot.
          queuedHandle = runner.dispatch(testDispatch({ text: "Build it from the reverse-engineered API" }));
          fs.writeFileSync(path.join(cwd, "shared.txt"), "merged result\n");
          return "Resolved.";
        }
        return "Ran the queued user turn.";
      }) as unknown as AgentProcess,
      usageManager: makeStubUsageManager(),
      sseBroadcast: () => {},
    }, "main");

    // The rebase completed untouched by the concurrent message…
    expect(result.status).toBe("conflicts_resolved");
    expect(await git.isRebaseInProgress()).toBe(false);
    expect(messages.some((m) => m.type === "message_queued")).toBe(true);

    // …and the queued message then ran as its own turn after the flow settled.
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
    runner.systemTurnInProgress = true; // another flow's hold (running=false)

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
    // The refused flow must not clear the hold it does not own.
    expect(runner.systemTurnInProgress).toBe(true);
  });

  it("a failed rebase abort is reported as a failure, not narrated as a clean abort", async () => {
    const { workDir, bareDir, git } = setupRepoWithRemote(tmpDir);
    createConflictingDivergence(bareDir, workDir);
    execSync("git push -u origin feature", { cwd: workDir, stdio: "pipe" });
    const runner = new SessionRunner({ sessionId: "s1", sessionDir: workDir, defaultAgentId: "claude" });
    const captured: { role: string; text: string }[] = [];

    // The displacement path reaches the driver's abort — which then fails,
    // leaving the workspace genuinely mid-rebase.
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

    // The workspace really is still mid-rebase — and the durable notice says
    // so instead of claiming "the branch is unchanged".
    expect(await git.isRebaseInProgress()).toBe(true);
    const notice = captured.find((m) => m.text.includes("FAILED"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("still mid-rebase");

    // Clean up the real rebase state so afterEach's rm doesn't race git.
    await git.rebaseAbort().catch(() => {});
  });

  it("dispatchOnRunner enqueues a non-system dispatch while the flow holds the session between turns", async () => {
    // The gap the production incident fell through: `tryDrain` clears `running`
    // at `agent_result` while the driver still has git work (and possibly more
    // resolution turns) ahead. The flow-held flag must make dispatch enqueue.
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

    runner.systemTurnInProgress = true; // the flow's hold, no turn in flight

    const handle = runner.dispatch(testDispatch({ text: "user msg mid-flow" }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);

    // Another SYSTEM turn (CI fix / wake shape: systemTurn without
    // postTurn:"none") is no safer mid-rebase — it queues too.
    const ciHandle = runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(2);

    // The flow's own resolution turns (`systemTurn` + `postTurn: "none"`, the
    // driver's exclusive shape) must still start.
    const sysHandle = runner.dispatch(testDispatch({ text: "resolve conflicts", systemTurn: true, postTurn: "none" }));
    expect(runner.running).toBe(true);
    await sysHandle.settled;

    // Release the hold the way the flow's finally does, and drain. The head
    // starts; the second entry drains off the first's own post-turn drain.
    runner.systemTurnInProgress = false;
    expect(releaseQueuedTurn(runner)).toBe(true);
    await handle.settled;
    await ciHandle.settled;
    expect(runner.queueLength).toBe(0);
  });
});
