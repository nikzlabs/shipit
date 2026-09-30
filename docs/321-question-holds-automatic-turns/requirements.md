---
issue: planning#630
title: A question holds automatic turns
description: While the agent waits for the user's answer, ShipIt starts no automatic turn on that session.
---

# A question holds automatic turns

From the user's request on 2026-09-30: "if an agent asks a question, it
shouldn't be interrupted by rebase, fix ci, and any other automatic turns".

1. When an agent turn ends by waiting for the user — a question card, or a plan
   that waits for approval — ShipIt starts no automatic turn on that session
   until the user responds.
2. An automatic turn is any turn the user did not start in that session: an
   automatic rebase or conflict resolution, an automatic CI fix, a merge notice,
   a child session's report, a message from a parent session, a finished consult,
   a quota continuation, and any turn of this kind that is added later.
3. The user responds by starting any turn in the session: an answer on the card,
   a plan approval or rejection, or any message they type.
4. Automatic work that comes due while the agent waits is held, not dropped.
   When the user's turn ends without a new question, the held work runs as it
   would have run without the question.
5. The hold stays in effect when the session's container is reclaimed and when
   ShipIt restarts.
6. Work the user starts by hand is not automatic and is not held — for example
   the Sync button or the Fix CI button. A message the user sends or queues never
   waits behind held automatic work.

## Open questions

None.

## Resolved questions

None yet. Requirements 2–6 spell out the words of the request: "automatic" is
the class requirement 2 lists, and "shouldn't be interrupted" is about *when*
the work runs, so the work is held (req 4) rather than cancelled — the automatic
features stay on.
