---
issue: planning#483
title: Network mode at session creation
description: Fold network containment into the composer's existing permission-mode control, for new and running sessions alike.
---

# Network mode at session creation

1. The regular new-session UI (the `/{owner}/{repo}/new` composer) lets me set the
   new session's network mode before I send its first message.
2. The Quick Capture (quick session) UI lets me set the new session's network mode
   before I send its first message.
3. The mode I pick is in force for the session's **first** turn. I never have to
   start the session, stop it, change Session settings, and continue it.
4. "Network mode" is the same choice the session's own Session settings dialog
   offers — Inherit workspace / Contained / Open. It is not the host allowlist,
   which stays where it is (Settings → Network, and the blocked-egress card).
5. The choice does **not** get its own control in the composer row. It is needed
   rarely and must not take prominent space, so it shares the control that already
   holds the permission mode (Plan / Guarded / Auto).
6. That combined control changes both settings for **new and already-running**
   sessions, and is the **same control on desktop and on mobile**.
7. A session's network mode is changed in exactly one place. Folding it into the
   composer control means no second control describes the same session's egress.
8. The pick never carries over to the next new session — every new session starts
   at "Inherit workspace".
9. The composer's settings menu never keeps a level of nesting that exists only to
   hold one or two rows. With the mode gone from it, a session running under a role
   opens straight onto the role list instead of a root row that opens another panel.
10. The control states what it will do before I commit to it: which mode the session
    will run in, and — when that is not the inherited default — that it is a
    deliberate change from the workspace setting.

## Open questions

- (none)

## Resolved questions

- 2026-08-28 — *Where should the Network control sit in Quick Capture: its own pill
  in the composer toolbar, or a line in the footer beside auto-merge?* Neither. Both
  are too prominent for something needed this rarely. Fold it into the existing
  permission-mode control instead, as one menu covering mode **and** network, the
  same on desktop and mobile and for new and existing sessions — and take the mode
  out of the parameters menu, which removes a nesting level there. → reqs 5, 6, 7, 9.
- 2026-08-28 — *Should the pick carry over to the next new session, like the model
  seed does?* No — reset every time, as the Quick Capture auto-merge checkbox does.
  → req 8.
