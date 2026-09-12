# `/goal` on Claude Code

Plan: [plan.md](plan.md).

1. On a Claude Code session the user can set a goal by typing `/goal <condition>`
   in chat, and the CLI works toward that condition.
2. While a Claude Code session has a goal, the chat shows it; when the CLI's goal
   ends — achieved, cleared or abandoned — the chat stops showing it.
3. The user can read the goal with `/goal` (or `/goal status`) and remove it with
   `/goal clear`. Neither starts a turn.
4. A `/goal` action Claude Code has no equivalent for is answered with a notice
   that says so, and is never sent to the CLI as an ordinary prompt.
5. The `/` menu offers a Claude Code session only the goal commands Claude Code
   supports.
6. The goal shown is correct after an orchestrator restart, a page reload and a
   session switch.
7. Serving a goal command never makes the agent do work outside a ShipIt turn.
8. Codex sessions keep the goal vocabulary and the behaviour they have today.
9. The backend-support table in
   [docs/154](../154-native-goal-command/plan.md) says what each pinned backend
   actually offers.

## Open questions

- None.

## Resolved questions

- 2026-09-12 — Must `/goal <condition>` be answered out of band, as Codex's is?
  No. Measured on the pinned CLI: `/goal <condition>` makes Claude Code start
  working toward the condition in the same process at once, so running it
  between turns would produce edits with no ShipIt turn, no transcript and no
  commit. The spawn brief fixed the answer: `set` rides the normal turn path and
  ShipIt learns the goal from the turn's own output. Recorded as reqs 1 and 7.
- 2026-09-12 — What happens to `/goal pause` and `/goal resume`, which Claude
  Code does not have? They are refused with a notice before they reach the CLI.
  Letting them through would be worse than useless: the CLI's clear keywords are
  `clear stop off reset none cancel`, so `pause` is read as a *condition* and
  would set a goal called "pause". Recorded as req 4.
- 2026-09-12 — Should ShipIt drive the chip from the agent's event stream rather
  than asking the CLI? It cannot. Measured: the stream reports a goal only at the
  moment it is set, and says nothing when the goal is evaluated, achieved,
  auto-cleared or restored on resume. Recorded as req 2; the mechanism is in
  plan.md.
- 2026-09-12 — Numeric goal fields Claude Code does not have (token budget,
  tokens used, time used) are reported as `null`/`0`, and `status` stays the
  CLI's own word. Fixed by the spawn brief.
