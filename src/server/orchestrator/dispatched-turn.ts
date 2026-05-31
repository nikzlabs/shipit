/**
 * Shared implementation for server-dispatched agent turns (docs/150).
 *
 * Lives outside `session-runner.ts` so it can depend on the runtime value
 * `wireAgentListeners` without creating an import cycle (`agent-listeners.ts`
 * imports `SessionRunnerInterface` from session-runner.ts).
 *
 * Used by both SessionRunner.dispatch and ContainerSessionRunner.dispatch.
 * All three turn flows — WS user-typed (`runAgentWithMessage`), system-
 * dispatched (here), and rebase conflict resolution
 * (`services/rebase-driver.ts`) — share the same listener implementation
 * (`wireAgentListeners`) and the same `resetRunnerTurnState` reset, so
 * message-group accumulation + chat-history persistence behaves identically
 * regardless of caller. Per-flow differences (auto-commit/push/PR vs. none,
 * queue drain vs. single-shot) live in the done handler.
 */

import type { AgentId, AgentProcess } from "../shared/types.js";
import { wireAgentListeners } from "./ws-handlers/agent-listeners.js";
import { resetRunnerTurnState } from "./session-runner.js";
import type {
  SessionRunnerInterface,
  SystemTurnDeps,
  AgentDispatchOptions,
  QueuedMessage,
} from "./session-runner.js";
import { formatUnresolvedConflictNotice } from "./services/conflict-marker-notice.js";

function queuedMessageToDispatchOptions(next: QueuedMessage): AgentDispatchOptions {
  const nextOpts: AgentDispatchOptions = { text: next.text };
  if (next.activity !== undefined) nextOpts.activity = next.activity;
  if (next.images !== undefined) nextOpts.images = next.images;
  if (next.files !== undefined) nextOpts.files = next.files;
  if (next.uploads !== undefined) nextOpts.uploads = next.uploads;
  if (next.permissionMode !== undefined) nextOpts.permissionMode = next.permissionMode;
  if (next.reviewFilePath !== undefined) nextOpts.reviewFilePath = next.reviewFilePath;
  return nextOpts;
}

/**
 * Run a single dispatched agent turn against the given runner.
 *
 * docs/149 — async because run-params assembly is async (reads system prompt,
 * MCP config, etc). Callers fire-and-forget via `void runDispatchedTurn(...)`
 * — `dispatch` still returns `void`.
 */
export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: AgentDispatchOptions,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  const { text, activity } = opts;
  const agent = createAgent(agentId);
  runner.running = true;
  resetRunnerTurnState(runner, { reviewFilePath: opts.reviewFilePath ?? null });

  const drainNextQueuedTurn = async (): Promise<void> => {
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  // System-initiated user message: surface it as a user bubble in chat. The
  // WS path emits this via `system_user_message` (when the orchestrator
  // initiates) or skips it entirely (when the user typed it — the optimistic
  // bubble is already in the client store). System turns always emit, since
  // there's no client-side optimistic bubble to dedupe against.
  runner.emitMessage({ type: "system_user_message", text, activity });
  deps.listenerDeps.chatHistoryManager.append(runner.sessionId, { role: "user", text });
  deps.listenerDeps.sseBroadcast("session_agent_started", { sessionId: runner.sessionId, activity });

  // Shared listener: handles agent_init/assistant/tool_result/result/error,
  // accumulates `chatMessageGroups`, persists message groups on agent_result,
  // and writes error rows on auth_required / process error. Same code path
  // the WS user-typed turn uses.
  wireAgentListeners(agent, runner, deps.listenerDeps, {
    isNewSession: false,
    persistUserMessage: () => {
      // No-op: we persisted the user message synchronously above. The
      // listener's `isNewSession` branch is the one that would call this;
      // we set `isNewSession: false` so this lambda never fires.
    },
    fallbackTitle: text.slice(0, 80) || "Agent",
    capturedSessionId: runner.sessionId,
    ...(opts.permissionMode !== undefined ? { requestedPermissionMode: opts.permissionMode } : {}),
    onError: drainNextQueuedTurn,
  });

  // Post-turn: auto-commit + auto-push + PR card + queue drain. The listener
  // already set `runner.running = false` on `agent_result` and persisted the
  // message groups; this `done` block handles process-exit cleanup and
  // flow-specific post-turn work (commit/push/PR/drain).
  agent.on("done", async (code: number | null) => {
    console.log("[system-turn] agent exited with code", code);
    // Identity-guard: only clear the runner's agent ref if it still points at
    // *this* turn's agent. A later WS turn or dispatched turn that started
    // after we did has already called `setAgent(NEW)`; clobbering to null
    // here would strand the new agent and the SSE relay would log
    // `[sse-drop] ... dropped (no _agent)` for every event from it.
    if (runner.getAgent() === agent) runner.setAgent(null);

    // docs/149 — write back any CLI-rotated OAuth token before doing further
    // post-turn work. Matches the WS-path `syncTokenBackAfterTurn` behavior.
    deps.finalizeAgentEnv?.(runner.sessionId, agentId);

    let commitHash: string | null = null;
    // docs/150 — fallback chain: prefer the assistant-derived summary (the
    // first line of the agent's text output), then the dispatch's activity
    // label, then a generic "agent turn" so the commit message is always
    // meaningful instead of the legacy literal "CI fix".
    const summary =
      runner.turnSummary.split("\n")[0]?.slice(0, 120) || activity || "agent turn";
    try {
      if (deps.commitTurn) {
        // Shared path — the same `postTurnCommit` the WS path uses (workspace
        // lock + conflict notice + auto-push + commit→message link). Both
        // transports now commit through one helper.
        commitHash = await deps.commitTurn({
          sessionDir: runner.sessionDir,
          sessionId: runner.sessionId,
          summary,
          turnStartHeadHash: null,
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
      console.error("[system-turn] auto-commit failed:", err);
    }

    // docs/149 — emit PR lifecycle card after the commit lands, same as the
    // WS path. Optional dep; tests can leave it unwired.
    if (commitHash) {
      try {
        await deps.postTurnPrFlow?.(runner.sessionId, runner.sessionDir, commitHash, (m) => runner.emitMessage(m));
      } catch (err) {
        console.error("[system-turn] pr-lifecycle flow failed:", err);
      }
    }

    // Defensive: the listener sets `running = false` on `agent_result`, but
    // a process that exits without firing `agent_result` (crash before any
    // events) would leave `running = true`. Force it false here so the queue
    // drain branch below can run.
    runner.running = false;
    if (runner.queueLength > 0) {
      void drainNextQueuedTurn();
      return;
    }

    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId: runner.sessionId });
    runner.onAgentFinished();
  });

  try {
    // Sync the freshest OAuth token (and provision/pin on the first turn)
    // immediately before spawn — the same late moment the WS path runs env prep
    // inside `runAgentWithMessage`. This is what closes the staleness window
    // that let a quick/child/CI-fix turn spawn with a sibling-rotated (dead)
    // refresh token and fail with "Not logged in · Please run /login". The
    // service fn's earlier call already pinned the agent (so the model/agent
    // stays authoritative for the WS connect); this call is idempotent and just
    // re-syncs the token. buildRunParams reads `agentSessionId` from the DB,
    // which env-prep's docs/153 leak repair updates as a side-effect, so resume
    // recovery is honored automatically.
    await deps.prepareAgentEnv?.(runner.sessionId, agentId);
    const runParams = await deps.buildRunParams(runner.sessionId, agentId, text);
    agent.run(runParams);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    agent.emit("error", error);
  }
}
