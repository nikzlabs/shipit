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
import type { AutoResolveResult } from "../auto-conflict-resolve-manager.js";

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
  /**
   * docs/146 — fired immediately after `runner.setAgent(agent)` in
   * `runRebaseResolutionTurn`, so the auto-resolve wrapper can mark the
   * "agent was spawned" boundary. Anything thrown BEFORE this fires is a
   * pre-spawn failure (fetch, ancestry check) and should not burn a budget
   * attempt; anything thrown AFTER means real work happened. Optional —
   * user-driven rebases ignore this.
   */
  onAgentSpawned?: () => void;
  /**
   * docs/146 — drain callback fired after an auto-resolve attempt fully
   * settles, so a user message queued during the attempt drains only after
   * the rebase is continued/aborted and the repo is out of the conflict
   * state. Optional — tests / user-driven rebases can leave it unset.
   */
  drainQueue?: () => Promise<void> | void;
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
    runner.emitMessage({ type: "rebase_complete", forcePushed: false, upToDate: true });
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
    // docs/146 — flip `systemTurnInProgress` BEFORE the spawn callback fires,
    // so any concurrent WS send_message in the same tick sees the flag set
    // and suppresses live steering. Cleared in the `done` handler below.
    runner.systemTurnInProgress = true;
    runner.running = true;
    resetRunnerTurnState(runner);
    // docs/146 — signal to the auto-resolve wrapper that real work has started.
    // The wrapper uses this to classify a subsequent throw as a real-work
    // error vs. a pre-spawn defer.
    deps.onAgentSpawned?.();

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
      // docs/146 — clear the system-turn flag on the error path too. Without
      // this, a turn that errors out before `done` fires would leave the
      // flag stuck true and the next user turn would silently lose live
      // steering.
      runner.systemTurnInProgress = false;
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
      // docs/146 — clear the system-turn flag so live steering is allowed
      // again. Clear BEFORE `onAgentFinished()` so a re-entrant subscriber
      // running on the synchronous "idle" emit sees the correct state.
      runner.systemTurnInProgress = false;
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

// ---------------------------------------------------------------------------
// runAutoResolveAttempt — docs/146 wrapper around runRebaseFlow.
// ---------------------------------------------------------------------------

/** Default wall-clock cap on a single auto-resolve attempt. */
export const AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wraps `runRebaseFlow` for the auto-conflict-resolve path. (docs/146)
 *
 * Pre-flight gates (don't burn budget):
 *   - dirty tree, in-progress rebase, no GitHub auth → deferred.
 *
 * Translation of `runRebaseFlow`'s outcome:
 *   - `up_to_date` (GitHub said CONFLICTING but our local view disagrees) →
 *     deferred with `suppressEmit: true` so the WS layer doesn't flash
 *     "rebased then deferred" after the inner `rebase_complete`.
 *   - `rebased` / `conflicts_resolved` → success carrying `forcePushed`.
 *   - `ServiceError(409)` from the running-guard → deferred (TOCTOU backstop).
 *   - Any throw BEFORE `onAgentSpawned` fires (fetch failure, ancestry
 *     check, base-ref resolution) → deferred with a synthetic label, so a
 *     network blip doesn't burn budget. Anything thrown AFTER spawn → error
 *     (real work happened).
 *
 * Wall-clock timeout (default 10 min, overridable via `timeoutMs`): if the
 * agent never finishes, this wrapper does the full runner-state teardown
 * `git.rebaseAbort()` alone doesn't cover. See "Timeout teardown" in doc 146.
 *
 * Does NOT emit `auto_resolve_started` / `auto_resolve_result` itself — the
 * manager owns those envelopes and ties them to attempt accounting. The inner
 * `rebase_started` / `rebase_conflicts` / `rebase_complete` / `rebase_aborted`
 * events still fire from `runRebaseFlow` as a side effect.
 */
export async function runAutoResolveAttempt(
  deps: RebaseDriverDeps & {
    /** Wall-clock timeout for the whole attempt. Default 10 min. */
    timeoutMs?: number;
    /** Injectable clock — included for symmetry with the manager but currently unused inside the wrapper. */
    now?: () => number;
  },
  baseBranch: string,
): Promise<AutoResolveResult> {
  const { git, githubAuthManager, runner } = deps;

  // Pre-flight 1: no GitHub auth. The auto-path diverges from doc 094's
  // user-driven flow here — without auth the agent would do real work, the
  // local rebase would succeed, but the force-push silently no-ops while the
  // PR on GitHub still shows CONFLICTING. Burning agent turns on a remote
  // that will never see the result is wasteful; the failure mode is
  // structurally invisible. Pre-flight gate skips the attempt entirely.
  if (!githubAuthManager.authenticated) {
    return { outcome: "deferred", lastError: "no_github_auth", didWork: false };
  }

  // Pre-flight 2: dirty tree. Defensive — shouldn't happen for an idle
  // session, but the auto-path must NEVER stash silently (a stash here would
  // surprise the user, and `git stash pop` on top of a rebase is a hazard).
  try {
    const clean = await git.isClean();
    if (!clean) {
      return { outcome: "deferred", lastError: "dirty_tree", didWork: false };
    }
  } catch (err) {
    return { outcome: "deferred", lastError: `is_clean_failed: ${getErrorMessage(err)}`, didWork: false };
  }

  // Pre-flight 3: stale rebase from a previous orchestrator crash mid-flight.
  // `runRebaseFlow` would call `git.rebase(baseRef)` which fails when a
  // rebase is already in progress. Abort and defer; the next poll retries
  // from a clean state without burning budget.
  try {
    if (await git.isRebaseInProgress()) {
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      return { outcome: "deferred", lastError: "stale_rebase", didWork: false };
    }
  } catch (err) {
    return { outcome: "deferred", lastError: `is_rebase_in_progress_failed: ${getErrorMessage(err)}`, didWork: false };
  }

  // `didSpawn` flips true inside `runRebaseResolutionTurn` via the
  // `onAgentSpawned` callback. Used to classify a downstream throw: pre-spawn
  // → deferred (no budget burn); post-spawn → error (real work happened).
  let didSpawn = false;
  const wrappedDeps: RebaseDriverDeps = {
    ...deps,
    onAgentSpawned: () => { didSpawn = true; },
  };

  const timeoutMs = deps.timeoutMs ?? AUTO_RESOLVE_ATTEMPT_TIMEOUT_MS;

  // Wall-clock timeout. Resolves the outer promise early with an error
  // outcome and tears down all the runner state `git.rebaseAbort()` alone
  // doesn't cover. Without the teardown, the session is left with
  // `running = true` and a zombie agent ref, blocking every subsequent user
  // turn until the orchestrator restarts.
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<AutoResolveResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      void (async () => {
        // 1. Kill the in-flight agent process.
        try { runner.getAgent()?.kill(); } catch { /* defensive */ }
        // 2. Clear the agent ref so the next turn doesn't pick up the dead reference.
        runner.setAgent(null);
        // 3. Reset running flag; the listener's normal `agent_result` reset
        //    never runs because we killed before completion.
        runner.running = false;
        // 4. Clear system-turn flag so live steering is allowed again.
        runner.systemTurnInProgress = false;
        // 5. Emit "idle" so any deferred subscribers re-evaluate.
        runner.onAgentFinished();
        // 6. Abort the underlying git rebase (best-effort).
        try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
        // 7. Surface a `rebase_aborted` so the UI clears the rebase banner
        //    doc 094 raised. The inner driver doesn't emit this on our
        //    timeout path because it never gets the chance.
        runner.emitMessage({ type: "rebase_aborted" });
        resolve({ outcome: "error", lastError: "timeout", didWork: true });
      })();
    }, timeoutMs);
  });

  // The actual flow. Wrap the throwing/early-exit cases into the AutoResolveResult shape.
  const flowPromise = (async (): Promise<AutoResolveResult> => {
    try {
      const result = await runRebaseFlow(wrappedDeps, baseBranch);
      if (result.status === "up_to_date") {
        // GitHub said CONFLICTING; our local view says HEAD already contains
        // every commit in base. Races between GraphQL mergeability recompute
        // and our local fetch. Suppress the `auto_resolve_result deferred`
        // emit on this specific path — `runRebaseFlow` already emitted
        // `rebase_complete { forcePushed: false }` and a contradicting
        // `auto_resolve_result deferred` would flash "rebased then deferred"
        // in the UI.
        return { outcome: "deferred", didWork: false, suppressEmit: true };
      }
      // rebased / conflicts_resolved
      return { outcome: "success", forcePushed: result.status !== "aborted" && "forcePushed" in result ? result.forcePushed : false, didWork: true };
    } catch (err) {
      // 409 from the running-guard. Pre-spawn, no real work; defer.
      if (err instanceof ServiceError && err.statusCode === 409) {
        return { outcome: "deferred", didWork: false };
      }
      // Pre-spawn throw (fetch failure, ancestry check, base-ref resolution).
      // Defer rather than count against budget — a network blip should not
      // exhaust the per-session attempts.
      if (!didSpawn) {
        return { outcome: "deferred", lastError: getErrorMessage(err), didWork: false };
      }
      // Post-spawn throw. Real work happened (one or more agent turns).
      // Ensure the underlying rebase is aborted before returning — without
      // this cleanup the next attempt's stale-rebase pre-flight defers and
      // the per-session budget never reaches the cap. `runRebaseFlow` aborts
      // on its own internal paths (lockfile/abort/continue failures) but a
      // bubbled-up agent process error escapes before those run.
      try { await git.rebaseAbort(); } catch { /* may already be aborted */ }
      return { outcome: "error", lastError: getErrorMessage(err), didWork: true };
    }
  })();

  const winner = await Promise.race([flowPromise, timeoutPromise]);
  settled = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try {
    await deps.drainQueue?.();
  } catch (err) {
    console.error("[auto-resolve] drainQueue failed:", err);
  }
  return winner;
}
