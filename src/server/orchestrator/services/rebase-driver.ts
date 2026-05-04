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
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams } from "../../shared/types.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface } from "../session-runner.js";
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

  let result;
  try {
    result = await git.rebase(baseRef);
  } catch (err) {
    runner.emitMessage({ type: "rebase_aborted" });
    throw err;
  }

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
      runner.emitMessage({ type: "rebase_aborted" });
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
      // resolve anything). Abort to leave the tree clean.
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      runner.emitMessage({ type: "rebase_aborted" });
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
 * Run an agent turn dedicated to resolving rebase conflicts. Differs from
 * `runSystemTurn` in that it skips auto-commit / auto-push at the end (the
 * rebase machinery commits via `rebase --continue`, and force push happens
 * after the entire flow completes).
 */
function runRebaseResolutionTurn(
  deps: RebaseDriverDeps,
  prompt: string,
): Promise<void> {
  const { runner, agentFactory, sessionManager, chatHistoryManager, sseBroadcast } = deps;

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
    runner.accumulatedText = "";
    runner.turnSummary = "";
    runner.needsNewMessageGroup = true;
    runner.clearTurnEventBuffer();

    const activity = "Resolving conflicts...";
    runner.emitMessage({ type: "system_user_message", text: prompt, activity });
    chatHistoryManager.append(runner.sessionId, { role: "user", text: prompt });
    sseBroadcast("session_agent_started", { sessionId: runner.sessionId, activity });

    const onEvent = (event: AgentEvent) => {
      runner.emitMessage({ type: "agent_event", event });
      if (event.type === "agent_assistant") {
        const contentArr = (event as { content?: { type: string; text?: string }[] }).content ?? [];
        const text = contentArr
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) {
          runner.turnSummary = text;
          runner.accumulatedText += text;
        }
      }
    };

    const onError = (err: Error) => {
      console.error("[rebase] agent error:", err.message);
      runner.emitMessage({ type: "error", message: `Agent process error: ${err.message}` });
      runner.setAgent(null);
      runner.running = false;
      reject(err);
    };

    const onDone = (code: number | null) => {
      console.log("[rebase] agent exited with code", code);
      runner.setAgent(null);
      if (runner.accumulatedText) {
        chatHistoryManager.append(runner.sessionId, {
          role: "assistant",
          text: runner.accumulatedText,
        });
      }
      runner.running = false;
      sseBroadcast("session_agent_finished", { sessionId: runner.sessionId });
      runner.onAgentFinished();
      resolve();
    };

    agent.on("event", onEvent);
    agent.on("error", onError);
    agent.on("done", onDone);

    const session = sessionManager.get(runner.sessionId);
    const agentSessionId = session?.agentSessionId ?? runner.sessionId;

    agent.run({
      prompt,
      sessionId: agentSessionId,
      cwd: runner.sessionDir,
    } as AgentRunParams);
  });
}
