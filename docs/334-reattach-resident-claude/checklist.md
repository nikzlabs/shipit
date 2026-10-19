# 334 — Re-attach the resident process: checklist

- [x] `requirements.md`, with the user's answers of 2026-10-19
- [x] `plan.md`
- [x] Worker keeps and reports the spawn facts and the task list (`agent-controller.ts`, `agent-types.ts`)
- [x] The executor gives the spawn identity to the process before the spawn (`turn-executor.ts`, `proxy-agent-process.ts`, `container-session-runner.ts`)
- [x] `attachIdleResident`, `restoreResidentSpawn`, `residentToAttach` (`container-session-runner.ts`)
- [x] Restore on both in-flight adoption paths
- [x] Both turn paths attach before their spawn guards (`dispatched-turn.ts`, `ws-handlers/agent-execution.ts`)
- [x] Idle compaction takes the process over after a restart (`services/idle-compaction.ts`)
- [x] Tests: `restart-idle-resident.test.ts`, `restart-idle-resident-composer.test.ts`, `services/idle-compaction.test.ts`
- [x] Probe with the real CLI (plan.md, "Probe")
- [x] Review fixes: tend a taken-over proxy until a turn takes it; gate on the finished first reading; no attach for a rebase step; worker follows the CLI's own mode changes; restore the MCP servers; attach before compaction-before-turn; idle compaction re-checks after its worker reading; an unfollowed process's exit clears its mark
- [x] docs/333: req 16 receipt, plan's piece 3 step 4 and "Known limits"
- [x] `session-containers` skill
