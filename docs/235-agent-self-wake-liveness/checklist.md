# Checklist

- [x] Verify the Claude CLI reports background-task / self-wake activity on the
      stream-json wire (probed against `claude 2.1.219` in streaming mode)
- [x] Confirm the signal does not require `--include-hook-events`
- [ ] Type `task_started` / `task_updated` / `task_notification` /
      `background_tasks_changed` in `ClaudeSystemEvent`
- [ ] Map them to `agent_background_tasks` / `agent_self_wake` in `adapter.ts`
- [ ] Add `backgroundTaskCount` + `agentBusy` to `SessionRunnerInterface` and
      both runner implementations
- [ ] Set the state in `agent-listeners.ts`; clear it on agent `done`/`error`
- [ ] Guard `idle-enforcer.ts` (scan + TOCTOU re-check) on `agentBusy`
- [ ] Guard `canAutoDescend` in `tier-escalation.ts` on `agentBusy`
- [ ] Add `backgroundTasks: { count, descriptions }` to `WsSessionStatus`; emit
      on each `agent_background_tasks`
- [ ] Add `backgroundTaskSessionIds` to the `session_attention` SSE snapshot so
      the state survives reload / reconnect
- [ ] Client store: `backgroundTaskSessions`, reconciled wholesale from the
      snapshot the way `activeRunnerSessions` is
- [ ] Sidebar `SessionStatusDot`: widen the existing `isAgentRunning` condition
      to include background-task sessions — reuse the green pulsing dot, add no
      new indicator
- [ ] Chat `AgentStatusBar`: widen the `isLoading` gate and set the label to
      "Waiting for a background task to finish" (naming the task when there is
      exactly one); suppress the `tool` field
- [ ] Gate `backgroundTaskCount` on `isStreamingActive` — a task cannot outlive
      the CLI process, so the count is definitionally 0 without one
- [ ] Decay the count with `backgroundTasksSeenAt` (honored for at most one
      `IDLE_GRACE_PERIOD_MS`) so a dropped event can't strand a session
- [ ] `computeAttentionReason`: add `hasBackgroundTasks`, short-circuit with
      `isAgentRunning`, kept *below* the `awaitingPermission` check
- [ ] Detach turn listeners on `result` for a resident streaming process so a
      self-woken turn is not attributed to the prior turn's captured context
- [ ] Tests: adapter mapping, enforcer refuses to reap a session with
      outstanding background tasks, tier escalation ditto
- [ ] Tests: `computeAttentionReason` stays silent on pending background tasks
      but still reports a blocked permission prompt; sidebar dot renders the
      pending rung; snapshot reconcile restores state after a simulated reload
