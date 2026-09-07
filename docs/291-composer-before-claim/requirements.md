---
title: The composer works before the session is warmed up
issue: planning#516
description: On a repository's new-session view the role and the other composer settings are live before the claim lands, and the session starts on what they showed.
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
3. *(withdrawn — see Open questions)*
4. Whatever was chosen before the session existed is what the session actually
   **starts on** — the role, and the harness/model/level it sets. Including the case where
   the user left a role by adjusting one of its parameters.
5. *(withdrawn with req 3)*

## Non-requirements

- Nothing changes for a composer bound to an existing session. There, a pick has to
  reach the server over the WebSocket, and a closed socket still bars it.
- Nothing changes about *when* a role stops being choosable: the session's first turn
  still locks it (`docs/272-user-selectable-roles` req 4).

## Requirement provenance

Req 1 is the report's own words. Reqs 2 and 4 are not: they are what req 1 needs in order
to be true rather than separate asks — the three parameters are what a role *is*, and a
control the user can operate that does not decide anything is not "working".

**Reqs 3 and 5 were withdrawn during implementation, and the withdrawal is the open
question below.** They read: *"the user can type and send a first message in that window,
delivered as soon as the session is ready"* and *"a message held for a session that never
arrives is rolled back and the user is told"*. Both came from reading the report's "start
typing" as *compose and send* rather than *type into the box* — typing already worked
before this change; only Send was barred. That reading was mine, not the report's.

## Open questions

- **Should Send also work before the claim lands, holding the message until the session
  is ready?** Built and then withdrawn. It works for the ordinary case, but an
  independent review found six defects inherent to holding a message across an unbounded
  wait, none of which the feature as reported implies: a second send silently replaces the
  first; leaving via Home or the repo picker can deliver the message into a different
  repository's session; a claim failure followed by another send waits forever; Stop does
  not cancel a held message; and a network-mode pick made *after* the send bypasses the
  container-rebuild barrier docs/285 put in front of the first turn. Closing those means
  ownership, capacity, cancellation and claim-scoping rules — a queue — which is a large
  mechanism to infer from two words. **The question for the human: is waiting for the
  workspace before you can press Send actually a problem, or was the role control the
  whole of it?**

## Resolved questions

- (none yet)
