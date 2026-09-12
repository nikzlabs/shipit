# `/goal` on Grok Build — checklist

Plan: [plan.md](plan.md). Requirements: [requirements.md](requirements.md).

- [x] `goalActions` on `AgentCapabilities`, with the gate in `send-message.ts` and the refusal in `handleGoalCommand`
- [x] `goalActions` plumbed to the client (`AgentInfo`, `listAgents`, `AgentOption`, `useServerEvents`)
- [x] `grok` harness block declares `supportsGoals` and `goalActions`
- [x] `grok-goal.ts`: answer parser, elapsed parser, control spawn
- [x] `GrokAdapter.goalCommand`, refusing during a running turn
- [x] Post-goal-turn `/goal status` read emitting `agent_goal_updated`
- [x] `user_paused` labelled in `goalStatusLabel` and `GoalChip`
- [x] `/` menu and `send-handler.ts` honour the per-action mode
- [x] Tests: parser fixtures, control spawn, adapter, gate, and a Codex-unchanged guard
- [x] Grok row updated in `docs/154-native-goal-command/plan.md`
