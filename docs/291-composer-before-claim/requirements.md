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
3. *(withdrawn 2026-09-07 — Send goes on waiting for the workspace; see Resolved
   questions)*
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

**Reqs 3 and 5 were mine, not the report's, and are withdrawn.** They read: *"the user can
type and send a first message in that window, delivered as soon as the session is ready"*
and *"a message held for a session that never arrives is rolled back and the user is
told"*. Both came from reading the report's "start typing" as *compose and send* rather
than *type into the box* — typing already worked before this change; only Send was barred.
See the receipt below.

## Open questions

- None.

## Resolved questions

- **2026-09-07 — Should Send also work before the claim lands, holding the message until
  the session is ready?** Answer: **no — ship the role fix as it stands.** Reqs 3 and 5
  are withdrawn and Send goes on waiting for the workspace.

  The question was raised because the held-send half had been built and then found to
  carry six defects inherent to holding a message across an unbounded wait, none of them
  implied by what was reported: a second send silently replaces the first; leaving via
  Home or the repository picker can deliver the message into a *different repository's*
  session; a claim failure followed by another send waits forever; Stop does not cancel a
  held message; and a network-mode pick made *after* the send bypasses the
  container-rebuild barrier `docs/285-network-mode-at-session-creation` puts in front of
  the first turn. Closing those means ownership, capacity, cancellation and claim-scoping
  rules — a queue.

  **Constraint this carries:** a future request to make Send work during the claim is a
  new feature with its own requirements, not a resumption of this one. The withdrawn code
  is in this branch's history if it is ever wanted as a starting point, but the six
  defects above are its requirements list, not its bug list.
