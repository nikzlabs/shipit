---
issue: planning#536
title: Collapsed turns — design
description: Collapse every turn but the newest to the request and the reply, so a long conversation can be scrolled and understood.
---

# Design

See [requirements](./requirements.md). This replaces the display rules of
[docs/296-compact-conversation](../296-compact-conversation/plan.md).

**Implemented.** Key files: `src/client/components/MessageList/compact-turns.ts`
(the display-turn split and the keep/hide rule),
`hooks/useCompactConversation.ts` (the row views, the pending-card table and the
one-way protection guard), `MessageList.tsx` (the expand button and the hoisted
rollback notice), `TranscriptRow.tsx` (`collapseTools`), and, for the checklist's
submitted state, `ws-handlers/send-message.ts` and `chat-history.ts`.

Loading speed is designed separately, in
[docs/300-transcript-load-speed](../300-transcript-load-speed/plan.md). That
work can only stop sending what these rules already hide, so it depends on this
one.

The display rules are client-side. One piece of server work comes with them: a
checklist has to record that it was submitted, which requirement 12 needs and
the card does not have today.

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

The per-row flags cannot identify a live execution. Ordinary live appends set
`streaming`, not `inProgress`, and the merge rebuilds the row without carrying
`inProgress` forward (`agent-event.ts:185-195`); an attach snapshot marks
**every** row of the execution `inProgress` (`turn-snapshot.ts:9`). A classifier
keyed on them gives a viewer who watched the turn and a viewer who reconnected
different answers for the same rows.

### Where position is not identical either

Position is a better signal, not a perfect one, and the difference is worth
stating rather than assuming. A steer during uninterrupted prose is recorded by
`recordSteeredMessage` (`agent-message-builder.ts:95`), which computes an
`afterGroupIndex` but does **not** arm `needsNewMessageGroup`. Later prose
therefore merges into the preceding group (`accumulateAssistantGroups`, the
final `else` at `agent-message-builder.ts:44`), while the watching client has
already inserted the user row and appends its prose after it. Reconstructed
history can then place that prose **before** the steer, which moves a display
turn boundary. A second divergence: `message-steered.ts:10` suppresses a
repeated identical user text for another viewer.

So the claim this design makes is the narrow one: **the boundary is derived from
the rows, so two viewers agree whenever their rows agree** — which the flags
never did, at any time. Making the rows themselves agree means arming the group
boundary on a steer, which changes turn persistence and belongs in its own
change, with tests for a steer during streaming prose. Until then, a steered
execution is the known case where a watcher and a reconnector can disagree, and
the verification list below covers it.

## What a collapsed turn shows

Keep a row when any of these holds:

1. `role === "user"` — requirement 5, with its attachments.
2. `isError`, or `notice === true` — requirement 11.
3. It still needs the user — requirement 12, defined below.
4. It is the display turn's **last agent reply**: the last assistant row with
   text, images or files, that is not a card carrier, not a notice, not an error
   and not rolled back.
5. It is in the newest display turn.

Everything else is hidden.

Rule 4 is `lastProse` (`compact-turns.ts:43`) **widened**: that predicate
requires non-empty text, so an answer that ends with a diagram or an attached
file would be skipped and an earlier paragraph shown in its place — requirement
5 says the last agent message. Its `isError` and `rolledBack` exclusions stay,
or an appended error row displaces the reply. docs/296 already retained
media-bearing messages whole; this keeps that.

**A code-rollback notice survives its row being hidden.** Verified at
`rewind-complete.ts:8-12` and `TranscriptRow.tsx:161-167`: a code-only rewind
sets `rolledBack` on every row from the gap and `codeRollbackHash` on the first
of them, and the "Code rolled back to …" pill rendered inside that row, beside
its bubble rather than within it. It sets neither `notice` nor `isError`, so
rule 2 does not keep it. The pill moves out of the row altogether, into the same
between-rows position `MessageList` already uses for the rewind gap — one place
rather than a copy on each side of a condition, and `shouldShowGapBefore`
returns false for a rolled-back row so the two never compete. Otherwise
rewinding code at the start of a multi-message response hides the explanation
while leaving the reply that describes the reverted changes on screen.

## Tools inside a kept row: hide, never unmount

Verified at `chat-card-persistence.ts:60-71` and `agent-event.ts:185-195`: one
row carries `text`, `toolUse` and `toolResults` together. For *groupable* tools
the renderer splits them — `buildVisualElements` emits a `message` element with
`hideTools: true` plus a separate `tool-group` element
(`visual-elements.ts:198-210`). For a **standalone** tool it does not: verified
at `visual-elements.ts:223-243`, a row with prose plus only `AskUserQuestion`,
`ExitPlanMode`, `present` or a task-list tool stays one message element with its
tools attached. Hiding that element loses the reply; keeping it shows the tool.

**Do not reach for the existing `hideTools` flag.** Verified at
`TranscriptRow.tsx:264`, it is a conditional render: `{!hideTools && msg.toolUse
&& …}` removes the whole tool subtree from the tree. `AskUserQuestion` keeps its
selections, its free-text answers and its submitted state in component state
(`AskUserQuestion.tsx:145-150`), so a user who types an answer, collapses the
turn and expands it again loses what they typed. That would contradict this
design's own promise that nothing holding user input is remounted.

**A hidden subtree still changes the row's height, so the reading anchor has to
see it.** `CompactLayout` compares a per-row visibility string and does nothing
when it is unchanged; a turn whose reply is kept and whose tools are hidden
moves nothing in the row-hidden half. The string therefore carries three states
per row rather than two.

Instead, wrap the tool subtree in an element that carries the `hidden`
attribute, exactly as the transcript already hides whole rows while leaving them
mounted. The subtree keeps its state, and a collapse costs nothing.

## What "still needs the user" means (req 12)

An explicit set, each with the state that decides it. Nothing here is a
judgement about importance; a card is kept when the product is waiting on a
person.

| Kept while | Source |
|---|---|
| A permission prompt is pending | `phase === "pending"` (`PermissionRequestCard.tsx:29`) |
| An egress prompt is pending | `phase === "pending"` (`EgressPromptCard.tsx:21`) |
| A release is proposed but not confirmed | `phase === "proposed"` (`ReleaseLifecycleCard.tsx:173`) |
| A bug report is not filed | the card store, seeded on every load (`session-data.ts:331`) |
| An action card, always | the card's presence — `isCompactDetail` keeps it whether or not `submittedAt` is set (req 12) |

**No tool is ever kept, and requirement 2 has no exception.** An earlier draft
carved one out for an unanswered question, reading "the tool has no result" as
"still waiting on a person". Two things killed it. The signal does not exist on
both harnesses: for Codex the worker emits the question card itself and the
adapter drops the matching result (`codex-event-handler.ts`, the
`isAskUserQuestionTool` early return), so **every** answered question would be
pinned open for the life of the session — the retain-forever failure that
removed the issue-write exception below. And the reading was wrong anyway: a
question, or an unresolved plan approval, reaches a collapsed turn only after
the user sent a later message, which is what ended the turn it sits in. The
product is not waiting on it any more. Every case in the table above reads a
source of truth that says *pending*; the absence of a result is not one.

Two card kinds were considered and rejected. An **issue write** offers Undo
indefinitely — verified at `issue.ts:96` and `IssueWriteCard.tsx:198`, the
states are `available`, `undoing`, `undone`, `failed`, with no expiry — so
treating an available Undo as unfinished would retain every provenance card in
the session forever. Optional reversal of a completed operation is not an
unfinished interaction. A **presented artifact** is output, not a request.

## Recording that a checklist was submitted

Verified at `chat.ts:71`, `ActionChecklistCard` is documented as an "immutable,
reusable message composer; submitting actions does not lock the card", and it
has no submitted field; submission changes only component-local state and a
five-second acknowledgement (`ActionChecklistCard.tsx:71`). The user chose to
add and persist one.

`ActionChecklistCard` gains one optional `submittedAt: string`.

**No migration and no new column.** Verified at `chat-history.ts:203` and
`:354`: the card is already persisted as JSON in its own `action_checklist`
column, so the field rides inside that JSON and an older row reads as never
submitted, which is the correct default.

**One message, recorded where the action is accepted.** The submission already
sends the composed text as an ordinary message; it carries the card id as
`actionChecklistCardId`, and `handleSendMessage` sets `submittedAt` at each of
its three acceptance points — the steer, the queue and the ordinary dispatch.
Not once, earlier: the paths do not share a later point, and every refusal after
such a point (an attachment that will not resolve, a workspace that has gone
away) would permanently hide a checklist whose message never reached the agent.
Recording at acceptance fails safe in the other direction — a path that forgot
the call would leave the card visible, which is requirement 12's default. The first submission wins — the field records
that the user acted, not how often — and an `action_checklist_update` broadcast
keeps every attached viewer in step without a reload. Do **not** add a
second "I submitted" frame from the client: `handleSubmit`'s boolean means only
that bytes reached an open socket — `useWebSocket.ts:18` disclaims server
receipt — so the server can reject the action at its authentication gate
(`send-message.ts:32`) while the separate state frame succeeds, and a
disconnection between the two frames leaves an accepted submission recorded as
untouched.

**Persist through `persistCardTransition`, not a bare database write.** Verified
at `chat-card-persistence.ts:155`, that helper patches `runner.recordedCards`
as well as the database, and its own comment states why: "Patch recorded state
too, or the next turn rebuild will undo a database-only update."
`issue-write-handlers.ts:14` is the existing caller. A checklist submitted while
its producing execution is still running is exactly the case that a
database-only write loses, at the next persistence boundary or snapshot.

**The card stays reusable.** `submittedAt` records that the user acted; it locks
nothing, so the documented contract at `chat.ts:71` still holds. Expanding the
turn brings the card back in full working order.

**The flag no longer hides the card (req 12, 2026-09-16).** It was written to
decide that, and the cost it carried — a user who ticks one action now and means
to tick another later finding the card gone — is what the user rejected on
seeing it. An action card is now kept unconditionally, which removes the cost
without the finer rule that was rejected with it (recording which action ids
were claimed keeps a partly-used checklist on screen for the life of the
session, the retain-forever failure that removed the issue-write exception
above). `submittedAt` stays: it is still set at acceptance, persisted and
broadcast, as the record that the user acted — nothing reads it to decide
visibility any more.

## Client

`useCompactConversation` is rewritten. The `activeFrom` boundary of
`useCompactConversation.ts:20-28` is deleted: requirement 4 removes the case it
defends against, and the newest-display-turn rule replaces it.

**Keep hidden rows mounted and counted**, as docs/296 does, so a collapse or an
expansion never moves a card to a different DOM parent and never remounts it.
Requirement 12 makes that load-bearing: the cards that survive a collapse are
exactly the ones that may hold unsent user input, and so are the tool subtrees
above.

**Protection becomes one-way.** The shipped guard
(`useCompactConversation.ts:29-69`) opens a turn when focus or a selection
enters it and closes it the moment they leave, synchronously — the existing test
`compact-conversation.test.tsx:97` asserts that clearing a selection hides the
protected row at once. A press inside the transcript collapses the selection and
moves focus on **`mousedown`**, so rows hide and the list shrinks between
`mousedown` and `mouseup`: no `click` fires on the intended target, and
`CompactLayout` re-anchors the scroll afterwards. That is the reported defect
(planning#540).

So opening stays automatic and closing does not: a turn opened because the user
had focus or a selection in it stays open until they collapse it with its own
button. Nothing hides under a pointer that is already down. Requirement 1's
automatic collapse still governs a turn the user has not touched; a turn they
have touched is theirs until they say otherwise, which is the same principle as
the manual expansion the requirement already allows.

The guard must also cover a tool subtree inside a retained row, not only rows
classified as hidden detail — an unfinished question lives there.

Reading-anchor restoration (`CompactLayout.tsx`) and search reveal
(`useCompactConversation.ts:96`) stay unchanged. In-app search keeps matching
message text, including text inside a collapsed turn, and opens a turn that
matches.

Put the display-turn split and the keep/hide rule beside the code it replaces,
in the client. docs/300 needs the same rule on the server and will promote it to
`src/server/shared/` then; writing it there now would be a boundary for a caller
that does not exist.

## The expand control (req 8)

One button per collapsed turn, above the turn's content: a `Button` with
`variant="ghost"`, `size="icon"` and a caret at `ICON_SIZE.SM`, and **no visible
text**. It keeps `aria-expanded`, `aria-controls` and the accessible name that
used to be the label ("Show full turn: <the user's message>"), which is also the
tooltip — so the words are still there for a screen reader and on hover. No
hidden-row count, and no failure status beside it — requirement 11 already keeps
the error row on screen.

The first form was a bordered `variant="secondary"` button carrying that text,
which is what the shipped ghost *text* control (docs/296) was replaced with. It
read as too heavy next to a turn's own prose; the chevron keeps the hit target
and the semantics and drops the weight.

docs/296's "Turn ended without an agent reply." note survives, on a narrower
condition: a turn that keeps **nothing**, so its collapsed form is the button
alone. The shipped rule showed it whenever the turn had no assistant *text*,
which put the note beside a turn whose reply was an image — and suppressed it
for a turn whose only content was an error row, where it was redundant anyway.
Both are decided by the same classification that hides the rows, so the note
cannot disagree with what is on screen.

The rewind anchor for the gap the turn opens on is **hoisted to the run's first
row** and drawn above the control (req 14): the anchor closes the user's
message, the control opens the reply. Hoisting rather than reordering one row is
what makes the two agree when the run does not begin with a bubble — the anchor
belongs to the run's first *message*, while the control sits on its first
*element*, which can be a tool group. The row that owns the gap then suppresses
its own copy, in both the collapsed path (`renderRewindPoint` beside the row)
and the expanded one (`TranscriptRow`'s `showGapBefore`), so hoisting never
leaves a second anchor behind.

Follow the `design-language` skill: semantic color tokens only, no hardcoded
palette values, `@phosphor-icons/react` for the icon.

The Settings help text must change with it. It currently promises "Show the last
agent message and all cards", which this design contradicts
(`AdvancedTab.tsx`).

## Non-goals

- No change to what the server sends. That is docs/300.
- No truncation of the kept agent message.
- No new database column. The one new piece of persisted state, a checklist's
  `submittedAt`, rides inside the card JSON that is already stored.
- No change to the agent lifecycle, the turn-event buffer, `turn_snapshot`, or
  the live WS append path.
- No change to how a steer is grouped. That divergence is named above and is its
  own change.

## Simpler alternatives considered

- **Keep the shipped classifier and fix only the newest-turn rule.** Rejected:
  three of the four reported problems are in the classifier, not in the
  boundary.
- **Key the live-turn rule on the per-row flags.** Rejected: the flags disagree
  between a watching viewer and a reconnecting one at all times, where the rows
  disagree only after a steer.
- **Reuse `hideTools` for tools in a retained row.** Rejected: it unmounts the
  subtree and destroys unfinished input.
- **Keep an unanswered question visible in a collapsed turn.** Rejected: the
  Codex path records no result for an answered question, so the rule would pin
  every question in the session open — and a question the user has already sent
  a later message past is not one the product is waiting on.
- **A turn id column.** Rejected: user-row boundaries already define a display
  turn, and a new column would need a backfill migration.

## Verification

- Newest turn full; the previous turn collapses when a new turn starts.
- A viewer who watched a turn and one who reconnects see the same turns
  collapsed — including the steered case, which is expected to fail until the
  grouping change lands and must be asserted as a known difference rather than
  left untested.
- Tool groups hidden whether or not a tool failed.
- A prose row that also carries a standalone tool keeps its prose and hides the
  tool, and the tool keeps its state: type into a question's free-text field,
  collapse the turn, expand it, and the text is still there.
- Expanding a turn whose only hidden content is a tool subtree restores the
  reading position.
- A turn whose last agent message is an image or a file keeps that message.
- An appended error row does not displace the turn's ordinary reply.
- A code rollback notice stays visible when its row is hidden.
- Every card in the "still needs the user" table stays visible in its pending
  state and hides once resolved, including after a reload.
- A checklist submitted during a running turn still reads as submitted after the
  turn finishes and after a reload.
- Pressing a control in a transcript that has a protected turn performs the
  action, and the scroll does not move.
- An interrupted turn and a failed turn both collapse.
- Search matches text inside a collapsed turn and opens it.
- Setting off: the view is exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- `lint:dev`, `typecheck`, affected tests, and browser checks in a light and a
  dark theme, narrow and wide.
