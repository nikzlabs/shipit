# Native goal command — checklist

- [x] Measure the `thread/goal/*` shapes and behavior on the pinned codex-cli 0.154.0
- [x] Shared types: `AgentGoal`, `AgentGoalCommand`, `agent_goal_updated`, `supportsGoals`, `AgentProcess.goalCommand`
- [x] Codex: notification handlers, rehydrate after `thread/resume`, `goalCommand` (live process or control process)
- [x] Worker `/agent/goal` route and the orchestrator proxy
- [x] Persist the goal on the session record; broadcast it with the session list
- [x] `send-message.ts` interception of `/goal`, `/goal status|clear|pause|resume`
- [x] Client: capability-gated `/` menu entries, no spinner for a goal command, goal chip above the composer
- [x] Tests: parser, Codex handler and control process, worker route, interception, capability gate
- [x] Record the continuation decision in plan.md
