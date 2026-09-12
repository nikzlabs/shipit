# `/goal` on Grok Build

Plan: [plan.md](plan.md). Remaining work: [checklist.md](checklist.md).

1. On a Grok Build session, `/goal <objective>` starts Grok's own goal loop, and
   everything it does appears in the ShipIt transcript of an ordinary turn.
2. `/goal` or `/goal status` shows the current goal in chat and starts no turn.
3. `/goal pause` and `/goal clear` change the goal from chat and start no turn.
4. `/goal resume` continues a paused goal, and the work it does appears in the
   ShipIt transcript of an ordinary turn.
5. While a Grok session has a goal, the chat shows it, and what it shows is right
   after a page reload, a session switch and an orchestrator restart.
6. The `/` menu offers the `/goal` commands on a Grok session.
7. No `/goal` command makes the agent do work outside a ShipIt turn.
8. Codex goal behaviour does not change.

## Open questions

- None.

## Resolved questions

- 2026-09-12 — Which `/goal` actions may ShipIt answer out of band? Only the ones
  measured to need no model call. `get`, `pause` and `clear` answer locally at
  zero cost. `set` and `resume` both run Grok's planner, implementer and verifier,
  so they ride an ordinary turn (req 1, 4, 7). The Ops brief set the rule ("never
  run agent work outside a ShipIt turn") and the measurement decided which actions
  it covers.
- 2026-09-12 — May the shared goal contract change? No. `AgentGoal`,
  `AgentGoalCommand`, `AgentGoalCommandResult`, `handleGoalCommand`, the worker
  route and the goal chip stay as they are. The one addition, specified by Ops and
  shared with the parallel Claude Code work, is the optional `goalActions` field
  on `AgentCapabilities`.
- 2026-09-12 — Should ShipIt read the goal by watching the turn stream instead of
  spawning a process? It cannot. Grok emits a `goal_updated` update only under
  `--output-format streaming-json`; ShipIt's adapter reads
  `--output-format streaming-messages-json`, which drops it. Ops confirmed that
  changing the output format is out of scope, so a zero-cost `/goal status` read
  after a goal turn is the mechanism.
- 2026-09-12 — Measured: text **before** `/goal …` stops Grok reading it as its own
  command, so the turn becomes an ordinary model call and no goal is set; text
  **after** it is worse, folding the trailing context into the objective. May ShipIt
  leave that as a limitation? No — a path where the goal silently does not get set is
  the incident class docs/154 exists for, so req 1 is not met until it is fixed. The
  prompt for a `"turn"` goal action is the user's text and nothing else. Two
  conditions came with it — consume nothing that could not ride the prompt (the
  role's standing instructions above all, since reading them is a *take*), and refuse a
  `/goal` that carries attachments. The same defect for `/skill` on any harness is
  wider than this feature and is filed separately.
- 2026-09-12 — What happens to a `/goal` command sent while a turn is running?
  It is refused with a notice telling the user to wait. A control spawn during a
  live turn puts two processes on one session directory, and the goal state file
  was measured being written by both.
