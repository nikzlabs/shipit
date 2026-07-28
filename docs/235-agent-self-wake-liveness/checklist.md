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
- [x] Emit the task list on each `agent_background_tasks`. Shipped as a field on
      `WsSessionStatus`; **corrected** to its own `background_tasks` message —
      riding on a turn-transition message forced a `running` snapshot at the one
      moment the CLI has drained the list but not yet self-woken, so the client
      read a starting turn as an idle session (indicator off + chime, back on a
      frame later)
- [x] Require an attention reason to hold for a settle window before
      `useAttentionNotifications` fires, so structural sub-second idle blips
      (drain→wake, turn-end→queue-drain) can't chime
- [x] Add `backgroundTaskSessionIds` to the `session_attention` SSE snapshot so
      the state survives reload / reconnect
- [x] Client store: `backgroundTaskSessions`, reconciled wholesale from the
      snapshot the way `activeRunnerSessions` is
- [x] Return `backgroundTasks` from `GET /api/sessions/:id/history` and honor it
      in `loadSessionHistory` — the SSE snapshot restores the sidebar marker, but
      the chat status line is re-established from history, which read only
      `agentRunning` and so blanked the line a beat after switching into a
      between-turns session with work outstanding
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
- [x] Gate that reset on `!runner.running` — `task_notification` also fires for a
      background job started *earlier in the current turn*, and resetting there
      deleted the running turn's already-persisted rows from chat history
      (`integration_tests/self-wake-midturn.test.ts`, docs/237)
- [x] Tests: adapter mapping, tracker gate + decay, enforcer refuses to reap a
      session with outstanding background tasks, tier escalation ditto
- [x] Tests: `computeAttentionReason` stays silent on pending background tasks
      but still reports a blocked permission prompt; the `background_tasks`
      handler sets/clears the marker, never touches `activeRunnerSessions` in
      either direction, leaves the chat surfaces alone mid-turn, and hands the
      turn-end `session_status` a named label to restore
- [x] Tests: an attention reason that reverts inside the settle window never
      notifies; one that outlives it still does, announcing the reason it
      settled on

## Deferred — tracked separately as [SHI-247](https://linear.app/shipit-ai/issue/SHI-247)

- [ ] Re-arm the post-turn flow for a self-woken turn so its file changes are
      committed / pushed / surfaced on the PR card. `turn-executor`'s first-wins
      guards (`streamingPostTurnFired`, `drainFired`, `tokenSyncFired`) are
      scoped to one `runTurn` invocation, so a wake turn's `agent_result`
      returns early today. Touches auto-commit and PR creation, so it wants its
      own change and its own tests. Until then a self-woken turn's edits are
      picked up by the next user turn's commit.
