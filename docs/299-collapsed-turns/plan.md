---
issue: planning#536
title: Collapsed turns — design
description: Collapse every turn but the newest to the request and the reply, so a long conversation can be scrolled and understood.
---

# Design

See [requirements](./requirements.md). This replaces the display rules of
[docs/296-compact-conversation](../296-compact-conversation/plan.md), which stay
in place until this work ships.

Loading speed is designed separately, in
[docs/300-transcript-load-speed](../300-transcript-load-speed/plan.md). That
work can only stop sending what these rules already hide, so it depends on this
one. Everything here is client-side.

## What changes against the shipped feature

| Behavior | docs/296 today | This design |
|---|---|---|
| Newest turn | Collapses as soon as it settles | Always full (req 1) |
| Tool group with one error | Stays fully visible | Hidden (req 2) |
| Interrupted / failed turn | Never collapses | Collapses; its error rows stay (req 3, 11) |
| Attach during a turn | Whole transcript stays full | Earlier turns collapse (req 4) |
| Cards | All 24 types stay | Hidden, unless the card still needs the user (req 5, 12) |
| Expand control | Ghost text button | A real button (req 8) |

## Display turn, execution turn

A turn has no identity in storage. Verified at `database.ts:13-28`: the
`messages` table has `session_id`, `role`, `content`, `in_progress` and no turn
column. A **display turn** is the span from one user row to the next, which is
how the client already derives a run (`compact-turns.ts:20`). No migration is
needed.

An **execution** is not the same span. Verified at
`chat-card-persistence.ts:35`: a steered user message is interleaved into one
execution, so one execution can contain several display turns.

The rule that reconciles them: **never collapse a row whose `inProgress` is set,
and never collapse the newest display turn.** A steered live execution therefore
keeps its earlier display turns open until it settles. That is bounded to one
execution and is the deliberate price of leaving the live path alone.

Put the split and the keep/hide rule in one shared module,
`src/server/shared/collapsed-turns.ts`. The client already imports from
`server/shared/` (`visual-elements.ts:3`), so this needs no new boundary, and
docs/300 needs the same rule on the server.

## What a collapsed turn shows

Keep a row when any of these holds:

1. `role === "user"` — requirement 5, with its attachments.
2. `isError`, or `notice === true` — requirement 11.
3. A card that still needs the user — requirement 12. The card's own resolved
   state decides: an action checklist not yet submitted, a bug report not yet
   filed, an issue write still inside its undo window.
4. It is the display turn's **last agent prose**: an assistant row with
   non-empty text that is not a card carrier and not a notice. This mirrors
   `lastProse` in `compact-turns.ts:43`.
5. It is in the newest display turn, or `inProgress` is set.

Everything else is hidden.

**A kept prose row must not bring its tools with it.** Verified at
`chat-card-persistence.ts:60-71` and `agent-event.ts:185-195`: one row carries
`text`, `toolUse` and `toolResults` together, and the live merge concatenates
prose and tool blocks into the same row. The renderer already splits them —
`buildVisualElements` emits a `message` element with `hideTools: true` plus a
separate `tool-group` element (`visual-elements.ts:198-210`) — so the display
side works, provided the classifier hides the tool element in every case.

That is where the shipped feature fails requirement 2 twice:
`isCompactDetail` keeps a whole tool group when any item has an error result
(`compact-turns.ts:50`), and it keeps a message whole when the message carries a
tool that was not folded into a group (`compact-turns.ts:54`). Both carve-outs
are removed.

## Client

`useCompactConversation` is rewritten. The `activeFrom` boundary of
`useCompactConversation.ts:20-28` is deleted: requirement 4 removes the case it
defends against, because what is collapsed no longer depends on what the viewer
observed.

**Keep the focus and selection protection** of `useCompactConversation.ts:29-69`
and the reading-anchor restoration of `CompactLayout.tsx`. Automatic collapse
still happens while the user reads — another viewer or a queued message can
start the next turn.

**Keep hidden rows mounted and counted**, as docs/296 does, so a collapse or an
expansion never moves a card to a different DOM parent and never remounts it.
Requirement 12 makes that load-bearing: the cards that survive a collapse are
exactly the ones that may hold unsent user input.

In-app search keeps its current behavior: it matches message text, including
text inside a collapsed turn, and opens a turn that matches
(`useCompactConversation.ts:96`).

### Stale in-progress flags

Only `agent_result` clears the per-row `inProgress` flag
(`agent-event.ts:299-311`); `agent-interrupted.ts:10` and `error.ts:9` do not,
and `session-data.ts:297` turns a persisted in-progress row into
`streaming: true`. Today that pins a run open forever, which is why the shipped
feature sometimes shows no button at all. Rule 5 above keeps in-progress rows
full, so a stale flag would keep a dead turn permanently open here too. Fix the
flags as their own small change, before or with this work.

## The expand control (req 8)

One real button per collapsed turn, above the turn's content: a `Button` with
`variant="secondary"` and a `CaretDown` icon at `ICON_SIZE.SM`, not the current
ghost text (`MessageList.tsx:331`). It keeps `aria-expanded` and
`aria-controls`. No hidden-row count, and no failure status beside it —
requirement 11 already keeps the error row on screen.

Follow the `design-language` skill: semantic color tokens only, no hardcoded
palette values, `@phosphor-icons/react` for the icon.

## Non-goals

- No change to what the server sends. That is docs/300.
- No truncation of the kept agent message.
- No change to the persisted history, the agent lifecycle, or the turn-event
  buffer.
- No change to `turn_snapshot` or the live WS append path.

## Simpler alternatives considered

- **Keep the shipped classifier and fix only the newest-turn rule.** Rejected:
  three of the four reported problems are in the classifier, not in the
  boundary.
- **A turn id column.** Rejected: user-row boundaries already define a display
  turn on both sides, and a new column would need a backfill migration.

## Verification

- Newest turn full; the previous turn collapses when a new turn starts.
- Tool groups hidden whether or not a tool failed; a prose row that also carried
  tools renders without them.
- Error rows and notices kept; an unresolved action card and an unsent bug
  report kept, with their state.
- Attach during a running turn, including after a steer: the whole live
  execution stays full, earlier turns are collapsed.
- An interrupted turn and a failed turn both collapse.
- Expanding and collapsing never remounts a card: type into a bug-report card,
  toggle an older turn, and the draft survives.
- Search matches text inside a collapsed turn and opens it.
- Setting off: the view is exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- `lint:dev`, `typecheck`, affected tests, and browser checks in a light and a
  dark theme, narrow and wide.
