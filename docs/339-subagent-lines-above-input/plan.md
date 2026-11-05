---
issue: planning#717
title: Sub-agent lines above the input
description: Running sub-agents get one line each above the chat input; finished ones fold into a Done block; a click opens the full dialog. Replaces the in-chat sub-agent cards.
---

# Sub-agent lines above the input

Implements [`requirements.md`](./requirements.md). Visual reference:
[`mockup.html`](./mockup.html), guide-line style.

## Shape

One component, `SubagentLines`, sits in the stack above the composer in
`App.tsx`, right under the "Working…" line (req 1). It is drawn only when the
session has run at least one sub-agent.

- **One line per running sub-agent** (req 5): kind icon (green robot for an
  Agent-tool sub-agent, purple chat for a `shipit agent run` sub-agent — req 2),
  name, grey detail, time, spinner. No label (req 4).
- **Done · N** (req 6) folds every finished sub-agent of the session, newest
  first, and adds "· N failed" in red, so the running lines plus the count
  answer "which are active, how many ran" without a click (req 7). It opens in
  place; a long list scrolls.
- While the main agent works, a thin guide line hangs the lines under its
  "Working…" spinner; when it is idle the lines stand alone.
- **A click opens `SubagentRunDialog`** (req 9), the shared `Dialog`:
  - Agent-tool sub-agent: **Work** (every step, live), **Prompt** (fetched on
    demand when the transcript projection left it out, docs/244), **Report**
    (the whole report, fetched when the transcript carries only its clamped
    head — docs/109 req 8 still holds because this view is the one click away).
  - `shipit agent run` sub-agent: the report, with the run-on line, status
    detail, time and cost. The card carries no prompt, so there is no Prompt
    tab.

Child sessions are not read at all (req 3).

## Where the data comes from

Nothing new is stored. `deriveSubagentRuns` (`utils/subagent-runs.ts`) walks the
session's `messages` — the same persisted history the cards rendered from — so
the lines survive a reload and a session switch, and the dialog updates live as
nested events and results land:

| Kind | Source | Running | Failed |
|---|---|---|---|
| Agent tool (`Task`, `Agent` — `SUBAGENT_REPORT_TOOL_NAMES`) | top-level `toolUse` + `toolResults` + `subagentEvents` | no result yet while the turn is live, or a background-launch acknowledgement not yet retired (docs/109 reqs 10–11) | an error result, or no result once the turn that launched it has ended ("stopped") |
| `shipit agent run` | `subAgentConsult` card; before the card exists, the transient spawn chip | `pending` | `error`, `timeout`, `cancelled` |

Time is the tool's `startedAt` / the card's `createdAt` ticking while running,
and the reported duration once finished.

## Removing the cards (req 8)

- `buildVisualElements` emits no `subagent` element for a report tool (a
  `Skill` call still renders), and no element for a message whose only content
  is a `subAgentConsult` card. `subAgentConsult` stays in
  `CARD_MESSAGE_FIELDS`: that list also drives persistence and the
  terminal-entry merge guard, and both still apply.
- `MessageList` no longer draws the spawn chip; `MessageCards` no longer draws
  the consult card. `SubagentCall` (the card) is gone; its step renderer moved
  into the dialog.

## Key files

| File | Role |
|---|---|
| `src/client/utils/subagent-runs.ts` | `deriveSubagentRuns` — the session's sub-agents, status, name, detail, time |
| `src/client/components/SubagentLines.tsx` | The lines and the Done block |
| `src/client/components/SubagentRunDialog.tsx` | The full dialog: Work / Prompt / Report, or the consult report |
| `src/client/components/SubagentReport.tsx` | `SubagentFullReport` — the whole report, fetched when truncated |
| `src/client/components/MessageList/cards/SubAgentCards.tsx` | `describeRun` (run-on attribution) and the consult output fetch |
| `src/client/components/visual-elements.ts` | Keeps sub-agents out of the transcript |
