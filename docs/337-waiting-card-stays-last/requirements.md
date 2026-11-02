---
issue: planning#715
title: A waiting question card stays at the end of the chat
description: After a turn that ran while a question or plan waits, the waiting card is still the last thing in the chat, and a card the agent asked again is read-only.
---

# A waiting question card stays at the end of the chat

From the follow-up the user approved on 2026-11-02, after
[docs/322](../322-question-holds-automatic-turns/requirements.md) req 2 let the
inbox turn run while a question or plan waits: "keep the pending card pinned
through the rows of automatic turns that passed the question hold", and "make a
question or plan card read-only once a newer answer card replaces it".

Today a waiting card moves to the end of the chat only when the chat ends with
it ([docs/303](../303-session-status-card/requirements.md) req 32). The inbox
turn adds a row and the agent's reply below the card, so the card that still
waits is no longer at the end. If the agent asks the question again, the old
card and the new card can both be answered.

1. While a question or plan card waits for the user's answer, a turn that ran
   without the user's reply (docs/322-question-holds-automatic-turns req 2:
   the inbox turn, an idle compaction) does not move the waiting card away from
   the end of the chat.
2. When a newer question or plan card follows an older one that waits, only the
   newer card can be answered. The older card is read-only.
3. Requirements 1 and 2 hold the same way after a page reload, a session
   switch, and on a second device that views the session.
4. A message the user types past a waiting question keeps today's behaviour:
   the card stays where it is in the chat.

## Open questions

- Requirement 1: where does the waiting card show when the agent did not ask
  again? Below the rows of that turn, as the last thing in the chat
  (recommended), or in its place with a pointer to it at the end?
- Requirement 2: what does a read-only older card show? The questions with a
  "Asked again below" label and no answer controls (recommended), or folded to
  one line?

## Resolved questions

None yet.

Requirement 3 comes from the approved follow-up, which names a persisted marker
on the transcript row. Requirement 4 restates the current behaviour that the
follow-up does not change; it is not a new rule.
