---
title: The composer works before the session is warmed up
issue: planning#516
description: On a repository's new-session view the role and the other composer settings are live, and a first message can be sent, before the claim lands.
---

# The composer works before the session is warmed up

Reported from use: starting a new session in a repository that has **no warm session**
ready leaves the composer's role control dead until the claim finishes — a cold clone,
so tens of seconds. "It doesn't make sense to me as a user."

1. On a repository's new-session view (`/{repo}/new`), the **role** can be chosen from
   the moment the view appears — before the session has been claimed, cloned, or started.
2. The composer settings a role is made of — **harness, model, reasoning level** — are
   live in that same window. They are the controls the role's "Adjust parameters…" opens,
   so they cannot be dead while the role control is live.
3. The user can **type and send** a first message in that window. The message is
   delivered as soon as the session is ready; the user does not have to notice that it
   was ready and press Send again.
4. Whatever was chosen before the session existed is what the session actually
   **starts on** — the role, and the harness/model/level it sets.
5. A message held for a session that never arrives is not lost in silence. If the claim
   fails, or the user leaves for another repository's new-session view, the held message
   is rolled back and the user is told — it is never delivered into a different session.

## Non-requirements

- Nothing changes for a composer bound to an existing session. There, a pick has to
  reach the server over the WebSocket, and a closed socket still bars it.
- Nothing changes about *when* a role stops being choosable: the session's first turn
  still locks it (`docs/272-user-selectable-roles` req 4).

## Requirement provenance

Reqs 1 and 3 are the report's own words ("choose a different role and start typing before
anything is warmed up"). Reqs 2, 4 and 5 are not: they are what reqs 1 and 3 need in order
to be true rather than separate asks, and they are recorded here so review can see the
difference.

One reading was supplied rather than stated. **"Start typing" is read as *compose and
send*, not merely type into the box.** Typing into the composer was already possible
before this change — only Send was barred — so the complaint is only coherent if it
covers the send. If that reading is wrong, req 3 and req 5 are the ones to drop; reqs 1,
2 and 4 stand on their own.

## Open questions

- None.

## Resolved questions

- (none yet)
