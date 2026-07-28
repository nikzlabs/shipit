# Checklist

- [x] Verify the Claude CLI reports background-task / self-wake activity on the
      stream-json wire (probed against `claude 2.1.219` in streaming mode)
- [x] Confirm the signal does not require `--include-hook-events`
- [x] Type `task_started` / `task_updated` / `task_notification` /
      `background_tasks_changed` in `ClaudeSystemEvent`
- [x] Map them to `agent_background_tasks` / `agent_self_wake` in `adapter.ts`
- [x] Add `backgroundTaskCount` + `agentBusy` to `SessionRunnerInterface` and
      both runner implementations
- [x] Set the state in `agent-listeners.ts`; clear it on agent `done`/`error`
- [x] Guard `idle-enforcer.ts` (scan + TOCTOU re-check) on `agentBusy`
- [x] Guard `canAutoDescend` in `tier-escalation.ts` on `agentBusy`
- [x] Add `backgroundTasks: { count, descriptions }` to `WsSessionStatus`; emit
      on each `agent_background_tasks`
- [x] Add `backgroundTaskSessionIds` to the `session_attention` SSE snapshot so
      the state survives reload / reconnect
- [x] Client store: `backgroundTaskSessions`, reconciled wholesale from the
      snapshot the way `activeRunnerSessions` is
- [x] Sidebar `SessionStatusDot`: widen the existing `isAgentRunning` condition
      to include background-task sessions — reuse the green pulsing dot, add no
      new indicator
- [x] Chat `AgentStatusBar`: widen the `isLoading` gate and set the label to
      "Waiting for a background task to finish" (naming the task when there is
      exactly one); suppress the `tool` field
- [x] `computeAttentionReason`: add `hasBackgroundTasks`, short-circuit with
      `isAgentRunning`, kept *below* the `awaitingPermission` check
- [x] Gate `backgroundTaskCount` on `isStreamingActive` — a task cannot outlive
      the CLI process, so the count is definitionally 0 without one
- [x] Decay the count with `backgroundTasksSeenAt` (honored for at most one
      `IDLE_GRACE_PERIOD_MS`) so a dropped event can't strand a session
- [x] Give a self-woken turn its own turn state (`resetRunnerTurnState` at the
      wake edge) so it doesn't re-persist the previous turn's message groups
- [x] Tests: adapter mapping, tracker gate + decay, enforcer refuses to reap a
      session with outstanding background tasks, tier escalation ditto
- [x] Tests: `computeAttentionReason` stays silent on pending background tasks
      but still reports a blocked permission prompt; `session_status` handler
      sets/clears the marker, keeps the label across a turn-end status that
      omits the field, and never widens `activeRunnerSessions`

## Deferred — tracked separately as [SHI-247](https://linear.app/shipit-ai/issue/SHI-247)

- [ ] Re-arm the post-turn flow for a self-woken turn so its file changes are
      committed / pushed / surfaced on the PR card. `turn-executor`'s first-wins
      guards (`streamingPostTurnFired`, `drainFired`, `tokenSyncFired`) are
      scoped to one `runTurn` invocation, so a wake turn's `agent_result`
      returns early today. Touches auto-commit and PR creation, so it wants its
      own change and its own tests. Until then a self-woken turn's edits are
      picked up by the next user turn's commit.
