---
issue: planning#715
title: A waiting question card stays at the end of the chat — design
description: A saved marker on the user row of a turn that ran while a question waits lets the chat step over that turn; only the newest answer card can be answered.
---

# A waiting question card stays at the end of the chat — design

Implements [requirements.md](requirements.md).

## The marker (req 1, req 3)

A turn that passes the question hold
([docs/322](../322-question-holds-automatic-turns/requirements.md) req 2) is
known at one place: `runDispatchedTurn` computes `passedAnswerHold` (an
automatic turn while `runner.answerHold` is set). That turn's user row is saved
with `whileAnswerWaits: true` (`PersistedMessage`, column `while_answer_waits`),
and the `system_user_message` echo carries the same flag, so a live viewer and a
reload see the same row. Only the user row is marked: every row of a turn
follows its user row, so the client does not need a mark on each of them. An
idle compaction is silent and writes no user row; its compaction card is a card
row, which the scan already steps over.

## The pin (req 1, req 4)

`pendingAnswerElementIndex` (`src/client/components/MessageList/pending-answer.ts`)
scans back from the end of the chat. It still steps over card rows, task panels
and sub-agent chips. Any other row is "unclaimed" until the scan reaches the
user row that started it: a marked row claims the rows below it and the scan
goes on; an unmarked user row (the user's reply, req 4) ends the scan with no
pin. The scan pins an answer card only when it is pending and no unclaimed row
is below it, so prose that the question's own turn wrote below the card still
leaves the card in place, as before. `MessageList` already moves the pinned card
to the end of the flow (docs/303 req 32), so nothing changed there.

## The read-only card (req 2)

`MessageList` knows every answer card by row (`answerCardElements`). Each card
from a message older than the newest card's message gets `askedAgain` — by
message, not row, because a grouped tool in the same message splits its
questions into rows of their own. The flag which goes through `TranscriptRow` and
`MessageToolElement` to `ToolUseItem`. There it becomes `replaced` on
`AskUserQuestion` and `PlanApproval` while the tool has no result. A replaced
card shows its questions or its plan with an "Asked again below" label, and no
answer controls. An answered card keeps its answered view. Two answer tools in
one agent message are one card, not a card asked again: the agent waits on both
at once, and docs/303 req 32 keeps the row pending until each has an answer. The rule reads only
the transcript order and the tool results, so it holds after a reload with no
saved state.

## Key files

- `src/server/orchestrator/dispatched-turn.ts`, `turn-executor.ts` — the marker on the row and the echo
- `src/server/orchestrator/chat-history.ts`, `src/server/shared/database.ts` — the saved field
- `src/client/components/MessageList/pending-answer.ts` — the pin scan
- `src/client/components/MessageList/MessageList.tsx`, `AskUserQuestion.tsx`, `PlanApproval.tsx` — the read-only card
