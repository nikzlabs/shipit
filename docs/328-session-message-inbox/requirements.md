---
issue: planning#688
title: Session message inbox
description: Messages from other sessions wait in an inbox that the agent reads together, instead of one turn for each message.
---

# Session message inbox

From the user's request on 2026-10-11, dictated. The problem: "when a parent is
busy with something, messages from children pile up. The parent processes them
one by one, even though the first ones may not be relevant anymore or may need
to be read all together." The proposal: "messages between sessions not going as
turns. Instead, the session would just get a small turn, something like 'you got
a message', and then the session would be able to read the message queue for
this session, which would contain all the messages that were ever sent to this
session. […] when a session tries to read the next message, it would get all the
remaining" messages.

1. A message from another session does not start a turn of its own in the
   session that receives it.
2. ShipIt keeps every message that was sent to a session, and the session's
   agent can read them.
3. When a session has messages that its agent has not read, the agent gets a
   short turn that tells it so.
4. When the agent reads its messages, it gets all the messages that it has not
   read yet, together.
5. A session that received several messages while it was busy deals with them
   together, so that it can ignore a message that a later one made out of date.
6. The notices that ShipIt sends to a session about its child's pull request —
   merged, or closed without a merge — are messages of this kind. Requirements
   1 to 5 apply to them.
7. ShipIt can tell the agent that messages wait while the agent's turn is in
   progress. The agent does not have to wait for the end of its turn to learn
   of them.

## Open questions

None.

## Resolved questions

- 2026-10-11 — Do the notices that ShipIt sends about a child's pull request
  (merged, or closed without a merge) use the inbox too? The user: yes, include
  them. Recorded as req 6.
- 2026-10-11 — Can the "you have messages" notice arrive while the agent's turn
  is in progress? The user: yes, during a turn. Recorded as req 7. This replaces
  docs/233-child-session-report req 9, which said that a child report must not
  preempt a running parent turn.

## Earlier requirements that this changes

Requirement 1 replaced the wake turn in docs/233-child-session-report req 8
("start or queue a parent wake turn"), and requirement 7 replaced its req 9.
That document carries both changes, with their receipts.
