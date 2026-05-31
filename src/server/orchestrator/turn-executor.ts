/**
 * Shared agent-turn executor — the single code path both turn entry points run
 * through (docs/149→152 convergence; quick-session "Not logged in" follow-up).
 *
 *   - `runDispatchedTurn` (dispatched-turn.ts) — HTTP dispatch / quick / child /
 *     CI-fix turns.
 *   - `runAgentWithMessage` (ws-handlers/agent-execution.ts) — WS user-typed
 *     turns. Routed here in a subsequent step.
 *
 * Divergence is confined to the transport adapter (attachment resolution,
 * optimistic-bubble dedup, streaming-agent reuse, captured per-connection
 * state). Everything from "we have a prompt + a runner" onward — reset,
 * env-prep, spawn, listener wiring, and the post-turn commit/push/PR/drain
 * handler — lives here so the two transports cannot drift apart again. The
 * env-prep-at-spawn step is also what keeps every entry point's OAuth token
 * fresh at the moment the CLI starts (the quick-session "Not logged in" fix).
 *
 * Standalone module (like the former inline `dispatched-turn.ts`) so it can
 * import the runtime value `wireAgentListeners` without an import cycle through
 * `session-runner.ts`.
 */

import type { AgentId, AgentProcess, PermissionMode } from "../shared/types.js";
import { wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { resetRunnerTurnState } from "./session-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";

/**
 * Normalized, transport-agnostic description of one turn. The adapters
 * translate their transport-specific inputs (WS attachments / optimistic
 * bubble, dispatch activity label) into this shape so the executor branches
 * only on these fields — never on "which transport".
 */
export interface TurnInput {
  agentId: AgentId;
  /** Final prompt string handed to the CLI (WS: assembled with file/image context). */
  prompt: string;
  /** Raw user text — drives the echo bubble, persisted user row, and titles. */
  userText: string;
  /** Optional activity label (dispatch); used in the echo + commit-summary fallback. */
  activity?: string;
  permissionMode?: PermissionMode;
  reviewFilePath?: string;
  /**
   * Emit a `system_user_message` bubble (dispatch — the orchestrator initiated
   * the message) vs. rely on the client's already-rendered optimistic bubble
   * (WS user-typed).
   */
  emitUserEcho: boolean;
  /** Persist the user row (transport owns the payload shape: text-only vs. +images/files). */
  persistUserMessage: (sessionId: string) => void;
  isNewSession: boolean;
  /** Fallback chat title when AI naming hasn't produced one yet. */
  fallbackTitle: string;
  /** HEAD at turn start, for the "branch tip moved, no working-tree change" auto-push. */
  turnStartHeadHash: string | null;
  /** Start the next queued message (each transport supplies its own re-entry). */
  drainNext: () => Promise<void>;
}

/**
 * Run a single agent turn end-to-end against `runner` using a freshly-acquired
 * `agent` process. Async because env-prep + run-params assembly are async; the
 * adapters fire-and-forget.
 */
export async function executeAgentTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agent: AgentProcess,
  input: TurnInput,
): Promise<void> {
  const { agentId, prompt, activity } = input;

  runner.running = true;
  resetRunnerTurnState(runner, { reviewFilePath: input.reviewFilePath ?? null });

  // Surface the user message. Dispatch emits a `system_user_message` bubble (no
  // client-side optimistic bubble to dedupe against); WS skips the echo.
  if (input.emitUserEcho) {
    runner.emitMessage({ type: "system_user_message", text: input.userText, activity });
  }
  deps.listenerDeps.sseBroadcast("session_agent_started", { sessionId: runner.sessionId, activity });

  // Shared listener: handles agent_init/assistant/tool_result/result/error,
  // accumulates `chatMessageGroups`, persists message groups on agent_result,
  // and writes error rows on auth_required / process error.
  wireAgentListeners(agent, runner, deps.listenerDeps, {
    isNewSession: input.isNewSession,
    persistUserMessage: input.persistUserMessage,
    fallbackTitle: input.fallbackTitle,
    capturedSessionId: runner.sessionId,
    ...(input.permissionMode !== undefined ? { requestedPermissionMode: input.permissionMode } : {}),
    onError: input.drainNext,
  });

  // For a resumed session (id already known) persist the user row synchronously
  // before the turn. New sessions defer to the listener's `isNewSession` branch
  // (which calls `persistUserMessage` once the row exists).
  if (!input.isNewSession) {
    input.persistUserMessage(runner.sessionId);
  }

  // Post-turn: token sync-back + commit/push/PR + queue drain + finished. The
  // listener already set `runner.running = false` on agent_result and persisted
  // the message groups; this handles process-exit cleanup and the flow-specific
  // post-turn work.
  agent.on("done", async (code: number | null) => {
    console.log("[turn] agent exited with code", code);
    // Identity-guard: only clear the runner's agent ref if it still points at
    // *this* turn's agent. A later turn that started after us already called
    // `setAgent(NEW)`; clobbering to null here would strand it and the SSE
    // relay would log `[sse-drop] ... dropped (no _agent)` for every event.
    if (runner.getAgent() === agent) runner.setAgent(null);

    // Write back any CLI-rotated OAuth token before further post-turn work.
    deps.finalizeAgentEnv?.(runner.sessionId, agentId);

    // Commit summary fallback chain: assistant-derived summary → activity label
    // → generic "agent turn".
    let commitHash: string | null = null;
    const summary = runner.turnSummary.split("\n")[0]?.slice(0, 120) || activity || "agent turn";
    try {
      if (deps.commitTurn) {
        commitHash = await deps.commitTurn({
          sessionDir: runner.sessionDir,
          sessionId: runner.sessionId,
          summary,
          turnStartHeadHash: input.turnStartHeadHash,
          runner,
          emit: (m) => runner.emitMessage(m),
        });
      } else {
        // Fallback for minimal test setups that wire `autoCommit` but not
        // `commitTurn`.
        const result = await deps.autoCommit(runner.sessionDir, summary);
        if (result.conflictedFiles.length > 0 || result.rebaseInProgress) {
          runner.emitMessage({
            type: "system_notice",
            sessionId: runner.sessionId,
            level: "warn",
            message: formatUnresolvedConflictNotice({
              conflictedFiles: result.conflictedFiles,
              rebaseInProgress: result.rebaseInProgress,
            }),
          });
        }
        if (result.commitHash) {
          commitHash = result.commitHash;
          runner.emitMessage({ type: "git_committed", hash: result.commitHash, message: summary });
          deps.scheduleAutoPush(runner.sessionDir);
          if (result.parentHash) {
            runner.pendingCommitLink = {
              commitHash: result.commitHash,
              parentCommitHash: result.parentHash,
            };
            const updatedId = deps.listenerDeps.chatHistoryManager.updateLastMessage(runner.sessionId, {
              commitHash: result.commitHash,
              parentCommitHash: result.parentHash,
            });
            if (updatedId !== null) {
              runner.pendingCommitLink = null;
              const messageIndex = deps.listenerDeps.chatHistoryManager.indexOfMessageId(runner.sessionId, updatedId);
              if (messageIndex >= 0) {
                runner.emitMessage({
                  type: "commit_linked",
                  messageIndex,
                  commitHash: result.commitHash,
                  parentCommitHash: result.parentHash,
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[turn] auto-commit failed:", err);
    }

    // PR lifecycle card after the commit lands. Optional dep; tests can omit it.
    if (commitHash) {
      try {
        await deps.postTurnPrFlow?.(runner.sessionId, runner.sessionDir, commitHash, (m) => runner.emitMessage(m));
      } catch (err) {
        console.error("[turn] pr-lifecycle flow failed:", err);
      }
    }

    // Defensive: the listener sets `running = false` on agent_result, but a
    // process that exits without firing agent_result (crash before any events)
    // would leave `running = true`. Force it false so the drain branch can run.
    runner.running = false;
    if (runner.queueLength > 0) {
      void input.drainNext();
      return;
    }

    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId: runner.sessionId });
    runner.onAgentFinished();
  });

  try {
    // Sync the freshest OAuth token (and provision/pin on the first turn)
    // immediately before spawn. This late env-prep is what keeps the token
    // fresh at the moment the CLI starts — the quick-session "Not logged in"
    // fix. buildRunParams reads `agentSessionId` from the DB, which env-prep's
    // docs/153 leak repair updates as a side-effect, so resume recovery is
    // honored automatically.
    await deps.prepareAgentEnv?.(runner.sessionId, agentId);
    const runParams = await deps.buildRunParams(runner.sessionId, agentId, prompt);
    agent.run(runParams);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    agent.emit("error", error);
  }
}
