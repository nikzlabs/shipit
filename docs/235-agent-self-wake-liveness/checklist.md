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
- [ ] Detach turn listeners on `result` for a resident streaming process so a
      self-woken turn is not attributed to the prior turn's captured context
- [ ] Tests: adapter mapping, enforcer refuses to reap a session with
      outstanding background tasks, tier escalation ditto
