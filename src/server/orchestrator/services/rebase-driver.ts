/**
 * Rebase driver — orchestrates the full rebase flow with agent-driven conflict
 * resolution.
 *
 * Lifecycle:
 *   1. Fetch latest from origin.
 *   2. Check ancestry — if HEAD is up-to-date, emit complete and return.
 *   3. Attempt git rebase onto base ref.
 *   4. On conflicts: emit `rebase_started` + `rebase_conflicts`, send the agent
 *      a system message with conflict context, await agent completion, then
 *      stage all files and run `git rebase --continue`. Repeat until clean
 *      (multi-commit rebases may surface conflicts at multiple steps).
 *   5. Once the rebase completes cleanly, force-push (best-effort — no auth
 *      means we still report `rebase_complete` with `forcePushed: false`).
 *
 * The driver bypasses the standard system-turn flow because system turns
 * auto-commit + auto-push, both of which would corrupt a rebase. Instead it
 * spawns an agent directly, persists chat messages manually, and handles its
 * own lifecycle.
 */

import type { GitManager, RebaseConflictFile } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { AgentProcess, AgentId, AgentRunParams } from "../../shared/types.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { UsageManager } from "../usage.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { resetRunnerTurnState } from "../session-runner.js";
import { wireAgentListeners, type AgentListenerDeps } from "../ws-handlers/agent-listeners.js";
import { ServiceError } from "./types.js";
import { isNonFastForwardError } from "./git.js";
import { getErrorMessage } from "../validation.js";

/**
 * Maximum number of conflict iterations before bailing out. A multi-commit
 * rebase may surface conflicts more than once, but we cap iterations so a
 * misbehaving agent (or pathological repo state) cannot loop forever.
 */
export const MAX_REBASE_ITERATIONS = 10;

export interface RebaseDriverDeps {
  git: GitManager;
  githubAuthManager: GitHubAuthManager;
  runner: SessionRunnerInterface;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  /**
   * Usage + auth managers needed by the shared agent listener
   * (`wireAgentListeners`). Without these the conflict-resolution turn would
   * skip per-turn cost/token tracking and couldn't kick off OAuth on
   * `auth_required`. Shared with the WS path so the rebase turn is just
   * "a user turn with the post-turn commit/push elided" — see
   * `runRebaseResolutionTurn`.
   */
  usageManager: UsageManager;
  authManager: AuthManager;
  /** Factory for creating agents. Falls back to runner.createAgent if available. */
  agentFactory?: (agentId: AgentId) => AgentProcess;
  sseBroadcast: (event: string, data: unknown) => void;
}

export type RebaseFlowOutcome =
  | { status: "up_to_date" }
  | { status: "rebased"; forcePushed: boolean }
  | { status: "conflicts_resolved"; iterations: number; forcePushed: boolean }
  | { status: "aborted"; reason: string };

/** Build the conflict resolution prompt sent to the agent. */
export function buildRebaseConflictPrompt(
  baseBranch: string,
  conflicts: RebaseConflictFile[],
): string {
  const fileList = conflicts.map((c) => `- \`${c.path}\``).join("\n");
  return [
    `Rebasing onto \`${baseBranch}\` — ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} to resolve:`,
    fileList,
    "",
    "Each file has standard git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).",
    "Edit them to produce the correct merged result. Don't run any git commands —",
    "just edit the files. After you finish, the orchestrator will stage your changes",
    "and continue the rebase.",
  ].join("\n");
}

/**
 * Run the full rebase flow. Emits WS events through the runner so the client
 * can update its UI as the flow progresses.
 *
 * Throws ServiceError on validation problems (e.g. agent already running,
 * unresolvable base branch). Internal failures (force push errors, etc.) are
 * reported via WS events rather than thrown.
 */
export async function runRebaseFlow(
  deps: RebaseDriverDeps,
  baseBranch: string,
): Promise<RebaseFlowOutcome> {
  const { git, githubAuthManager, runner } = deps;

  if (runner.running) {
    throw new ServiceError(409, "Cannot rebase while an agent turn is in progress");
  }

  // 1. Fetch latest from origin.
  await git.fetch("origin");

  // 2. Resolve the base branch ref.
  const baseRef = await git.resolveBaseBranchRef(baseBranch);
  if (!baseRef) {
    throw new ServiceError(400, `Cannot resolve base branch: ${baseBranch}`);
  }

  // 3. Check ancestry — already up-to-date?
  const isAncestor = await git.isAncestor(baseRef, "HEAD");
  if (isAncestor) {
    runner.emitMessage({ type: "rebase_complete", forcePushed: false });
    return { status: "up_to_date" };
  }

  // 4. Begin rebase.
  runner.emitMessage({ type: "rebase_started", baseBranch });

  // Errors propagate to the route's `flowPromise.catch`, which emits a single
  // `rebase_aborted` carrying the error message. Don't emit here too — before
  // this dedupe the user got two aborts for one failure.
  let result = await git.rebase(baseRef);

  // 5. Clean rebase — go straight to force push.
  if (result.status === "clean") {
    const forcePushed = await tryForcePush(git, githubAuthManager, runner);
    runner.emitMessage({ type: "rebase_complete", forcePushed });
    return { status: "rebased", forcePushed };
  }

  // 6. Conflict loop — delegate resolution to the agent.
  let iter = 0;
  while (result.status === "conflicts") {
    iter++;
    if (iter > MAX_REBASE_ITERATIONS) {
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      throw new ServiceError(
        500,
        `Too many conflict iterations (>${MAX_REBASE_ITERATIONS}) — rebase aborted`,
      );
    }

    runner.emitMessage({
      type: "rebase_conflicts",
      conflicts: result.conflicts.map((c) => ({ path: c.path })),
    });

    const prompt = buildRebaseConflictPrompt(baseBranch, result.conflicts);
    await runRebaseResolutionTurn(deps, prompt);

    // The agent may have left files unmodified or staged. `add -A` covers both.
    await git.stageAll();

    try {
      result = await git.rebaseContinue();
    } catch (err) {
      // Continue can fail if there is nothing staged (agent didn't actually
      // resolve anything). Abort to leave the tree clean. The route's
      // `flowPromise.catch` emits a single `rebase_aborted` with the reason.
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      throw err;
    }
  }

  // 7. Force push after successful resolution.
  const forcePushed = await tryForcePush(git, githubAuthManager, runner);
  runner.emitMessage({ type: "rebase_complete", forcePushed });
  return { status: "conflicts_resolved", iterations: iter, forcePushed };
}

/**
 * Attempt a force push with lease. Returns true on success, false if push
 * was skipped (no auth) or failed.
 *
 * Emits the same WS events as the regular auto-push flow so the user sees
 * confirmation on success and an actionable error on failure — without these,
 * the rebase appears "complete" while the rewritten history never reaches
 * origin (see also `scheduleAutoPush` in index.ts / app-lifecycle.ts).
 */
async function tryForcePush(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  runner: SessionRunnerInterface,
): Promise<boolean> {
  if (!githubAuthManager.authenticated) return false;
  try {
    const message = await git.forcePush();
    const branch = await git.getCurrentBranch();
    runner.emitMessage({ type: "github_push_result", success: true, message, branch });
    return true;
  } catch (err) {
    const errMsg = getErrorMessage(err);
    console.error("[rebase] force push failed:", errMsg);
    if (isNonFastForwardError(err)) {
      runner.emitMessage({
        type: "git_push_rejected",
        reason: "non_fast_forward",
        message: "Force push rejected — remote moved since the last fetch. Try rebasing again.",
      });
    } else {
      const text = errMsg.includes("workflow")
        ? "Force push failed: your GitHub token needs the `workflow` scope to push GitHub Actions workflow files. Update your token at https://github.com/settings/tokens."
        : `Force push failed: ${errMsg}`;
      runner.emitMessage({ type: "github_push_result", success: false, message: text });
      runner.emitMessage({ type: "log_entry", source: "server", text, timestamp: new Date().toISOString() });
    }
    return false;
  }
}

/**
 * Run an agent turn dedicated to resolving rebase conflicts.
 *
 * Funnels through the same `wireAgentListeners` implementation the WS user-
 * typed turn and the system-dispatched turn (`runDispatchedTurn`) use, so
 * chat history accumulates the same message-group structure (tool calls
 * visible, assistant text split at tool-result boundaries) regardless of
 * caller. The only carve-out is the post-turn behavior: this flow skips
 * auto-commit / auto-push / queue-drain because the rebase machinery
 * commits via `rebase --continue` and force-push runs after the entire
 * flow completes — auto-committing mid-rebase would corrupt the rebase.
 */
function runRebaseResolutionTurn(
  deps: RebaseDriverDeps,
  prompt: string,
): Promise<void> {
  const {
    runner, agentFactory, sessionManager, chatHistoryManager,
    sseBroadcast, usageManager, authManager,
  } = deps;

  return new Promise((resolve, reject) => {
    const agentId = runner.agentId;
    const createFn = runner.createAgent
      ? (id: AgentId) => runner.createAgent!(id)
      : agentFactory;
    if (!createFn) {
      reject(new ServiceError(500, "No agent factory available for rebase resolution"));
      return;
    }

    const agent = createFn(agentId);
    runner.setAgent(agent);
    runner.running = true;
    resetRunnerTurnState(runner);

    const activity = "Resolving conflicts...";
    runner.emitMessage({ type: "system_user_message", text: prompt, activity });
    chatHistoryManager.append(runner.sessionId, { role: "user", text: prompt });
    sseBroadcast("session_agent_started", { sessionId: runner.sessionId, activity });

    // Listener deps shared with the WS user-typed path. The rebase flow has
    // no per-connection model selection, so we surface the session's pinned
    // model (whatever the WS user-typed turn would have used).
    const listenerDeps: AgentListenerDeps = {
      sessionManager,
      chatHistoryManager,
      usageManager,
      authManager,
      sseBroadcast,
      broadcastLog: (_source, _text) => { /* rebase flow doesn't surface CLI log lines */ },
      getSelectedModel: () => sessionManager.get(runner.sessionId)?.model,
    };

    wireAgentListeners(agent, runner, listenerDeps, {
      isNewSession: false,
      // User message persisted synchronously above; the listener's `isNewSession`
      // branch is gated to false, so this lambda never fires.
      persistUserMessage: () => { /* no-op */ },
      capturedSessionId: runner.sessionId,
      fallbackTitle: "Rebase",
    });

    // Reject the rebase Promise on agent process error. The listener's own
    // error handler has already emitted the error to chat history and reset
    // runner state; we just need to unblock the outer rebase loop.
    agent.on("error", (err: Error) => {
      console.error("[rebase] agent error:", err.message);
      reject(err);
    });

    // Resolve on process exit. The listener has already persisted message
    // groups on `agent_result` and set `runner.running = false`; this `done`
    // handler just performs the rebase-specific finish (sseBroadcast +
    // onAgentFinished + resolve). No auto-commit / auto-push / queue drain
    // — see the function docstring for why.
    agent.on("done", (code: number | null) => {
      console.log("[rebase] agent exited with code", code);
      // Identity-guard: don't clobber a later turn that already replaced
      // the runner's agent ref — that would silently drop its SSE events.
      if (runner.getAgent() === agent) runner.setAgent(null);
      // Defensive: a process that exited without firing `agent_result` (rare
      // crash before any events) wouldn't have had its `running` flag reset
      // by the listener. Force it false so the rebase loop's next iteration
      // can start cleanly.
      runner.running = false;
      sseBroadcast("session_agent_finished", { sessionId: runner.sessionId });
      runner.onAgentFinished();
      resolve();
    });

    const session = sessionManager.get(runner.sessionId);
    const agentSessionId = session?.agentSessionId ?? runner.sessionId;

    agent.run({
      prompt,
      sessionId: agentSessionId,
      cwd: runner.sessionDir,
    } as AgentRunParams);
  });
}
