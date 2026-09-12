# Checklist — `/goal` on Claude Code

- [x] `goalActions` on `AgentCapabilities`, declared on the `claude` harness
- [x] `claude-goal.ts`: answer parsing for every measured CLI shape
- [x] `claude-goal.ts`: the control process (`--resume`, `--tools ""`, 15 s limit, process-tree teardown)
- [x] `ClaudeAdapter.goalCommand` — the resident CLI, a control process, a refusal during a turn, `set` refused
- [x] `ClaudeAdapter` consumes an injected command's answer and its zero-turn result
- [x] `ClaudeAdapter` reports the `Goal set:` acknowledgement as `agent_goal_updated`
- [x] `send-message.ts` lets a `"turn"` action ride the turn path
- [x] `agent-execution.ts` delivers a `"turn"` goal command verbatim, leaving pending notices unconsumed
- [x] `goal-command.ts` refuses an unsupported action before the adapter
- [x] `refreshAgentGoalAfterTurn` on the runner's `idle` event
- [x] `goalAgentFor` — never displace an installed agent to run a goal read
- [x] `goalActions` published through `agent_list` and used to filter the `/` menu
- [x] Tests: parsing, control process, adapter paths, interception, refusals, verbatim delivery, post-turn read, Codex keeps the full vocabulary
- [x] docs/154's backend-support table corrected for Claude, Grok and OpenCode, with the capability-gate note
- [x] `npm run typecheck`, `npm run lint:dev`, full `npm test`
- [x] Independent review, findings folded in

## Known limits, deliberately not built

- A goal command sent while a turn runs is refused rather than queued. The user
  retries when the turn ends.
- With live steering **off**, a goal command can still overlap a turn started in
  the same instant: the adapter's refusal reads the flag before the turn sets it.
  The consequence is bounded — that turn's CLI is one-shot, so the next turn
  resumes from the transcript, where the command is recorded.
