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
} from "./session-runner.js";

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
  });

  // Post-turn: auto-commit + auto-push + PR card + queue drain. The listener
  // already set `runner.running = false` on `agent_result` and persisted the
  // message groups; this `done` block handles process-exit cleanup and
  // flow-specific post-turn work (commit/push/PR/drain).
  agent.on("done", async (code: number | null) => {
    console.log("[system-turn] agent exited with code", code);
    runner.setAgent(null);

    // docs/149 — write back any CLI-rotated OAuth token before doing further
    // post-turn work. Matches the WS-path `syncTokenBackAfterTurn` behavior.
    deps.finalizeAgentEnv?.(runner.sessionId, agentId);

    let commitHash: string | null = null;
    try {
      // docs/150 — fallback chain: prefer the assistant-derived summary (the
      // first line of the agent's text output), then the dispatch's activity
      // label, then a generic "agent turn" so the commit message is always
      // meaningful instead of the legacy literal "CI fix".
      const summary =
        runner.turnSummary.split("\n")[0]?.slice(0, 120) || activity || "agent turn";
      const result = await deps.autoCommit(runner.sessionDir, summary);
      if (result) {
        commitHash = result.commitHash;
        runner.emitMessage({ type: "git_committed", hash: result.commitHash, message: summary });
        deps.scheduleAutoPush(runner.sessionDir);
        // Link the commit to the last persisted assistant message so the
        // rewind preview can compute `fileCount` (without this, every
        // dispatched-turn session shows "0 files" in the Rewind dropdown
        // because `findCommitBeforeGap` finds no `commitHash` or
        // `parentCommitHash` to anchor the diff). Matches `postTurnCommit`
        // on the WS path.
        if (result.parentHash) {
          // Stash for the agent_result handler's fallback link, in case the
          // rows aren't persisted yet (codex double-`turn/completed` race).
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
      const next = runner.dequeue();
      if (next) {
        runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
        // docs/150 — thread every QueuedMessage field through, not just `text`.
        const nextOpts: AgentDispatchOptions = { text: next.text };
        if (next.activity !== undefined) nextOpts.activity = next.activity;
        if (next.images !== undefined) nextOpts.images = next.images;
        if (next.files !== undefined) nextOpts.files = next.files;
        if (next.uploads !== undefined) nextOpts.uploads = next.uploads;
        if (next.permissionMode !== undefined) nextOpts.permissionMode = next.permissionMode;
        if (next.reviewFilePath !== undefined) nextOpts.reviewFilePath = next.reviewFilePath;
        void runDispatchedTurn(runner, deps, agentId, nextOpts, createAgent);
        return;
      }
    }

    deps.listenerDeps.sseBroadcast("session_agent_finished", { sessionId: runner.sessionId });
    runner.onAgentFinished();
  });

  const runParams = await deps.buildRunParams(runner.sessionId, agentId, text);
  agent.run(runParams);
}
