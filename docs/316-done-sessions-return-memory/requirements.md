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
7. A session that has **Keep preview running** set is not done. It is not under
   **Recently resolved**, and ShipIt does not stop it because of this feature.
8. ShipIt does not stop a done session that the user has open. It stops the
   session after the user leaves it, when the wait is also complete.
9. The wait is a fixed 10 minutes. It is not a setting.

## Open questions

- (none)

## Resolved questions

- 2026-09-24 — *A done session has Keep preview running set: reclaimed after the
  wait, or not done?* The user chose "not done". Carried by req 7.
- 2026-09-24 — *The wait ends while the user has the session open: reclaim, or
  wait until they leave?* The user chose to wait until they leave. Carried by
  req 8.
- 2026-09-24 — *Fixed 10 minutes, or a setting?* The user chose fixed. Carried by
  req 9.

- 2026-09-24 — *When a done session is reclaimed, does ShipIt stop only the agent
  container or the preview too?* The user asked that done sessions "not use
  RAM", which the agent container alone does not give. Carried by req 3.
- 2026-09-24 — *Reclaim immediately or after a grace period?* The user: "within
  some short time period (10 minutes, for example). Not immediately so the user
  has a chance to continue work." Carried by reqs 4 and 5.
