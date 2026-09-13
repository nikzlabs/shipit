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
| Interrupted / failed turn | Often never collapses, because its rows keep stale active flags | Collapses; its error rows stay (req 3, 11) |
| Attach during a turn | Whole transcript stays full | Earlier turns collapse (req 4) |
| Cards | All 24 types stay | Hidden, unless the card still needs the user (req 5, 12) |
| Expand control | Ghost text button | A real button (req 8) |

## What a turn is, and the one signal this design trusts

A turn has no identity in storage. Verified at `database.ts:13-28`: the
`messages` table has `session_id`, `role`, `content`, `in_progress` and no turn
column. A **display turn** is the span from one user row to the next, which is
how the client already derives a run (`compact-turns.ts:20`).

**The newest display turn is never collapsed. That is the whole live-turn
rule.** The classifier reads no `inProgress` and no `streaming` flag.

That is deliberate, and it is a change from an earlier draft of this document.
The per-row flags cannot identify a live execution:

- Ordinary live appends set `streaming`, not `inProgress`, and the merge rebuilds
  the row without carrying `inProgress` forward (`agent-event.ts:185-195`).
- An attach snapshot marks **every** row of the execution `inProgress`
  (`turn-snapshot.ts:9`).

So the same rows carry different flags for a viewer who watched the turn and a
viewer who reconnected, and a design keyed on those flags shows the two viewers
different transcripts. Position does not have that problem: both derive the
newest display turn from the same user rows.

A row being streamed is always inside the newest display turn, so it is already
protected. An execution that a steered message splits into several display turns
collapses its earlier ones, which is exactly what requirement 1 asks for — and
it removes the steering exception the earlier draft invented without a user
decision.

## What a collapsed turn shows

Keep a row when any of these holds:

1. `role === "user"` — requirement 5, with its attachments.
2. `isError`, or `notice === true` — requirement 11.
3. A card that still needs the user — requirement 12, see the next section.
4. It is the display turn's **last agent prose**: an assistant row with
   non-empty text that is not a card carrier, not a notice, not an error and not
   rolled back. This is `lastProse` in `compact-turns.ts:43`, unchanged — its
   `isError` and `rolledBack` exclusions matter, or an appended error row
   displaces the ordinary reply.
5. It is in the newest display turn.

Everything else is hidden.

**A code-rollback notice survives its row being hidden.** Verified at
`rewind-complete.ts:8-12` and `TranscriptRow.tsx:161-167`: a code-only rewind
sets `rolledBack` on every row from the gap and `codeRollbackHash` on the first
of them, and the "Code rolled back to …" pill renders inside that row, beside
its bubble rather than within it. It sets neither `notice` nor `isError`, so
rule 2 does not keep it. Render the pill even when the row's content is hidden,
the same way docs/296 keeps the rewind gap outside the hidden bubble. Otherwise
rewinding code at the start of a multi-message response hides the explanation
while leaving the reply that describes the reverted changes on screen — a
requirement 11 failure.

**A kept prose row must not bring its tools with it.** Verified at
`chat-card-persistence.ts:60-71` and `agent-event.ts:185-195`: one row carries
`text`, `toolUse` and `toolResults` together. For *groupable* tools the renderer
already splits them — `buildVisualElements` emits a `message` element with
`hideTools: true` plus a separate `tool-group` element
(`visual-elements.ts:198-210`). For a **standalone** tool it does not: verified
at `visual-elements.ts:223-243`, a row with prose plus only `AskUserQuestion`,
`ExitPlanMode`, `present` or a task-list tool stays one message element with its
tools attached.

So for that branch, hiding the element loses the reply (requirement 5) and
keeping it shows the tool (requirement 2). Neither removing a classifier
exception nor adding one can satisfy both. **Render the kept prose element with
`hideTools: true` when its turn is collapsed.** The renderer already honours
that flag (`TranscriptRow.tsx:155`), so this needs no new element kind and no
change to `buildVisualElements`.

That is also where the shipped feature fails requirement 2 twice:
`isCompactDetail` keeps a whole tool group when any item has an error result
(`compact-turns.ts:50`), and keeps a message whole when it carries a tool that
was not folded into a group (`compact-turns.ts:54`). Both carve-outs go.

## Cards that still need the user (req 12)

"The card's own resolved state decides" is not an existing contract, and the
earlier draft asserted it without checking. What the code actually offers:

- **Bug reports have authoritative state, but not on the message.** The
  transcript row carries only `{ cardId }` (`bug-report-card.ts:24`); the phase
  lives in the card store, which `loadSessionHistory` seeds on every load
  (`session-data.ts:303-330`). So the classifier can honour requirement 12 for
  bug reports by reading the store, not the row.
- **Action checklists have no resolved state at all**, so this feature adds one.
  Verified at `chat.ts:71`: the card is documented as an "immutable, reusable
  message composer; submitting actions does not lock the card", and it has no
  `submitted` field. Submission changes component-local selection and a
  five-second acknowledgement (`ActionChecklistCard.tsx:71`), so after a reload
  the classifier cannot tell a submitted checklist from an untouched one. The
  user chose to add and persist the flag; the design is below.
- **Issue writes have no undo expiry.** Verified at `issue.ts:96` and
  `IssueWriteCard.tsx:198`: the states are `available`, `undoing`, `undone` and
  `failed`, and Undo is offered indefinitely. The earlier draft treated an
  available Undo as "still needs the user", which would retain every provenance
  card in the session forever. **That exception is deleted.** An optional
  reversal of a completed operation is not an unfinished interaction.

### Recording that a checklist was submitted

`ActionChecklistCard` gains one optional field, `submittedAt: string`, set the
first time the user submits anything from that card. The classifier hides a
checklist that has it.

**No migration and no new column.** Verified at `chat-history.ts:203` and
`:354`: the card is already persisted as JSON in its own `action_checklist`
column, so an optional field rides inside that JSON. An older row simply lacks
it and reads as never submitted, which is the correct default.

**The persistence path already exists, for another card.** Verified at
`chat-history.ts:700-719`: `updateIssueWriteCard(sessionId, cardId, patch)`
finds the row carrying that `cardId`, merges the patch into the card, and
rewrites the row inside a transaction. Verified at
`issue-write-handlers.ts:52-78`: the handler emits a `issue_write_update`
message to every attached viewer and persists the same transition. Mirror both:

- a client-to-server `action_checklist_submitted { cardId }`, sent from
  `handleSubmit` once the message is delivered (`ActionChecklistCard.tsx:71`);
- a handler that calls a new `updateActionChecklistCard` and emits
  `action_checklist_update { sessionId, cardId, submittedAt }`;
- a client handler that patches the row, with the new message type added to
  `TRANSCRIPT_SCOPED_MESSAGES` (`message-handlers/index.ts`), because it names
  one session's transcript and must be dropped by any other.

**The card stays reusable.** `submittedAt` records that the user acted; it locks
nothing and disables nothing, so the documented contract at `chat.ts:71` still
holds. Expanding the turn brings the card back in full working order.

**The accepted cost.** A user who ticks one action now and means to tick another
later finds the card collapsed after the first submission. Any finer rule —
recording which action ids were submitted, and keeping the card visible while
one is unclaimed — keeps a partly-used checklist on screen for the life of the
session, which is exactly the retain-forever failure that removed the
issue-write exception above. One submission means acted upon.

## Client

`useCompactConversation` is rewritten. The `activeFrom` boundary of
`useCompactConversation.ts:20-28` is deleted: requirement 4 removes the case it
defends against, and the newest-display-turn rule replaces it with a signal both
viewers compute the same way.

**Keep every protection the shipped feature has.** The focus and selection
guard (`useCompactConversation.ts:29-69`), the reading-anchor restoration
(`CompactLayout.tsx`), and search reveal (`useCompactConversation.ts:96`) all
stay. Automatic collapse still happens while the user reads, because another
viewer or a queued message can start the next turn.

**Keep hidden rows mounted and counted**, as docs/296 does, so a collapse or an
expansion never moves a card to a different DOM parent and never remounts it.
Requirement 12 makes that load-bearing: the cards that survive a collapse are
exactly the ones that may hold unsent user input.

In-app search keeps its current behavior: it matches message text, including
text inside a collapsed turn, and opens a turn that matches.

Put the display-turn split and the keep/hide rule in the client, beside the code
it replaces. docs/300 needs the same rule on the server and will promote it to
`src/server/shared/` then; writing it there now would be a boundary for a caller
that does not exist.

### The stale in-progress flags are a separate bug

`agent-interrupted.ts:10` and `error.ts:9` clear `isLoading` but not the per-row
`inProgress` flag, and `session-data.ts:297` turns a persisted in-progress row
into `streaming: true`. Today that pins a run open forever, which is why the
shipped feature sometimes shows no expand control at all. (`agent_result` is the
usual place the flag is cleared, `agent-event.ts:299-311`, though a
`turn_snapshot` with `final: true` clears it too — the current attach path sends
running snapshots.)

This design does not depend on that fix, because its classifier reads no flags.
The bug is still worth fixing: it breaks the shipped feature until this work
lands, and docs/300 does use the persisted `in_progress` column.

## The expand control (req 8)

One real button per collapsed turn, above the turn's content: a `Button` with
`variant="secondary"` and a `CaretDown` icon at `ICON_SIZE.SM`, not the current
ghost text (`MessageList.tsx:331`). It keeps `aria-expanded` and
`aria-controls`. No hidden-row count, and no failure status beside it —
requirement 11 already keeps the error row on screen.

Follow the `design-language` skill: semantic color tokens only, no hardcoded
palette values, `@phosphor-icons/react` for the icon.

The Settings help text must change with it. It currently promises "Show the last
agent message and all cards", which this design contradicts
(`AdvancedTab.tsx`).

## Non-goals

- No change to what the server sends. That is docs/300.
- No truncation of the kept agent message.
- No change to the persisted history, the agent lifecycle, or the turn-event
  buffer.
- No change to `turn_snapshot` or the live WS append path.
- No new database column. The one new piece of persisted state, a checklist's
  `submittedAt`, rides inside the card JSON that is already stored.

## Simpler alternatives considered

- **Keep the shipped classifier and fix only the newest-turn rule.** Rejected:
  three of the four reported problems are in the classifier, not in the
  boundary.
- **Key the live-turn rule on the per-row flags.** Rejected above: the flags
  disagree between a watching viewer and a reconnecting one.
- **A turn id column.** Rejected: user-row boundaries already define a display
  turn, and a new column would need a backfill migration.

## Verification

- Newest turn full; the previous turn collapses when a new turn starts.
- A steered execution collapses its earlier display turns, and a viewer who
  reconnects mid-execution sees the same thing as the viewer who watched it.
- Tool groups hidden whether or not a tool failed.
- A prose row that also carries a standalone tool keeps its prose and hides the
  tool.
- An appended error row does not displace the turn's ordinary reply.
- A code rollback notice stays visible when its row is hidden.
- Error rows and notices kept; an unsent bug report kept, with its state.
- An interrupted turn and a failed turn both collapse.
- Expanding and collapsing never remounts a card: type into a bug-report card,
  toggle an older turn, and the draft survives.
- Search matches text inside a collapsed turn and opens it.
- Setting off: the view is exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- `lint:dev`, `typecheck`, affected tests, and browser checks in a light and a
  dark theme, narrow and wide.
