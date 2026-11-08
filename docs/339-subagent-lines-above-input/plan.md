---
issue: planning#717
title: Sub-agent lines above the input
description: Running sub-agents get one line each above the chat input; finished ones fold into a "Finished subagents" block; a click opens the full dialog. Replaces the in-chat sub-agent cards.
---

# Sub-agent lines above the input

Implements [`requirements.md`](./requirements.md). Visual reference:
[`mockup.html`](./mockup.html), "Quiet box" style (req 10).

## Shape

One component, `SubagentLines`, sits in the stack above the composer in
`App.tsx`, right under the "Working…" line (req 1). It is drawn only when the
session has run at least one sub-agent.

- **One line per running sub-agent** (req 5): kind icon (green robot for an
  Agent-tool sub-agent, purple chat for a `shipit agent run` sub-agent — req 2),
  name, grey detail, time, spinner. No label (req 4).
- **Finished subagents · N** (req 6) folds every finished sub-agent of the
  session, newest first, so the running lines plus the count answer "which are
  active, how many ran" without a click (req 7). It counts no failures
  (req 11): a failed one shows its red ✗ only in the opened list. It opens in
  place; a long list scrolls.
- The lines sit in a quiet box (req 10): the queued-messages box's faint
  border and tint, so they read as one group.
- **A click opens `SubagentRunDialog`** (req 9), the shared `Dialog`:
  - Agent-tool sub-agent: **Work** (every step, live), **Prompt** (fetched on
    demand when the transcript projection left it out, docs/244), **Report**
    (the whole report, fetched on open — see below).
  - `shipit agent run` sub-agent: **Output** (the report, with status detail)
    and **Prompt** (req 12), under the run-on line, with time and cost. The
    card stores the prompt the sub-agent was sent, role instructions included,
    from the moment it is admitted, so the tab works while the run is pending.

Child sessions are not read at all (req 3).

## Where the data comes from

Nothing new is stored. `deriveSubagentRuns` (`utils/subagent-runs.ts`) walks the
session's `messages` — the same persisted history the cards rendered from — so
the lines survive a reload and a session switch, and the dialog updates live as
nested events and results land:

| Kind | Source | Running | Failed |
|---|---|---|---|
| Agent tool (`Task`, `Agent` — `SUBAGENT_REPORT_TOOL_NAMES`) | top-level `toolUse` + `toolResults` + `subagentEvents` | no result yet while the turn is live, or a background-launch acknowledgement not yet retired (docs/109 reqs 10–11) | an error result, no result once the turn that launched it has ended, or a background run retired as stopped (`STOPPED_TEXT`) — all "stopped" but the first |
| `shipit agent run` | `subAgentConsult` card; before the card exists, the transient spawn chip | `pending` | `error`, `timeout`, `cancelled` |

A launch's turn is live while a turn is in flight (`activeRunnerSessions`, not
`isLoading`, which background work alone also sets) and no turn-starting user
row follows it. A user row starts a turn unless it is queued, sent or steered
into the running turn (`steered`: set at send when a turn is in flight and by
`message_steered`), or one of the running turn's own rows (`inProgress`, after a
reload or snapshot: the server marks a steer that way, never the message that
started the turn). A row that does start a turn — the dequeue restore, the
`system_user_message` echo — loses both marks. `streaming` is not used: only the newest assistant group
keeps it, while a Codex sub-agent runs on as the turn moves on. Time is the tool's `startedAt` / the card's
`createdAt` ticking while running, and the reported duration once finished.

## What the transcript carries

Nothing draws a report without a click now, so `sliceSubagentReport` ships a
report's text **empty** (docs/244 req 1), marked `truncated` so the dialog
fetches it from `/tool-results/:toolUseId` on open (docs/109 req 8: nothing is
lost). It keeps what a line reads: the footer (duration, tool count), non-text
blocks, and the texts that decide status — a background-launch
acknowledgement is kept whole, and the stopped note is under the strip floor.
A consult already ships only its one-line preview. Its prompt past the strip
floor is left out too, marked `promptTruncated`; the Prompt tab fetches it from
`/sub-agent-consults/:cardId?part=prompt` (the bare route returns only the
output, so each tab moves only its own body). `shipit agent result` strips the
prompt: the caller wrote it. Cards from before req 12 have no prompt and say so.

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
| `src/client/components/SubagentLines.tsx` | The lines and the "Finished subagents" block |
| `src/client/components/SubagentRunDialog.tsx` | The full dialog: Work / Prompt / Report, or the consult report |
| `src/client/components/SubagentReport.tsx` | `SubagentFullReport` — the whole report, fetched when truncated |
| `src/client/components/MessageList/cards/SubAgentCards.tsx` | `describeRun` (run-on attribution) and the consult output fetch |
| `src/client/components/visual-elements.ts` | Keeps sub-agents out of the transcript |
