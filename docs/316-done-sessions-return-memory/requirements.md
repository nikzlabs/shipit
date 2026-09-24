---
issue: planning#616
title: Done sessions return their memory
description: One definition of a "done" session for the sidebar and the server, and done sessions stop their containers a short time after they become done.
---

# 316 — Done sessions return their memory

A session whose pull request has merged or closed looks finished in the
sidebar: it moves under **Recently resolved**, or the sidebar hides it. But
ShipIt keeps its agent container and its preview stack running until memory
goes over the budget (docs/284-idle-preview-survives-agent-stop). The user
expects a finished session to use no memory.

1. ShipIt has **one** definition of a "done" session. The browser and the server
   use the same definition, so the two cannot disagree about a session.
2. A session under **Recently resolved** is done, and a session the sidebar
   hides because of the resolved-session cap is done. A session that is not
   done is never in either place.
3. A done session returns its memory: ShipIt stops its agent container and its
   whole Compose stack. Its workspace, branch and chat stay.
4. ShipIt does not do this immediately. It waits a short time after the session
   becomes done — about **10 minutes** — so the user can continue work in it.
5. When the user continues work in a done session during that time, the session
   stops being done, and requirement 3 does not apply to it.
6. The docs/284-idle-preview-survives-agent-stop rule that an idle session keeps
   its preview while memory is below the budget applies to sessions that are
   **not** done. It does not protect a done session.

## Open questions

- A done session that has **Keep preview running** set: is it reclaimed after
  the wait, or is the reservation a reason for the session to be not done (so it
  leaves **Recently resolved**)?
- A done session that the user has **open** when the wait ends: is it reclaimed,
  or does ShipIt wait until the user leaves it?
- Is the wait a fixed 10 minutes, or a setting the user can change?

## Resolved questions

- 2026-09-24 — *When a done session is reclaimed, does ShipIt stop only the agent
  container or the preview too?* The user asked that done sessions "not use
  RAM", which the agent container alone does not give. Carried by req 3.
- 2026-09-24 — *Reclaim immediately or after a grace period?* The user: "within
  some short time period (10 minutes, for example). Not immediately so the user
  has a chance to continue work." Carried by reqs 4 and 5.
