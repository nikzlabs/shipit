---
title: Broken-workspace sessions stay visible
description: A session whose checkout ShipIt cannot put into a safe state is never dropped from the sidebar and asks for the user.
---

# Broken-workspace sessions stay visible

The user's words: *"I want sessions that have issues, for example not being able
to be evicted, to always be on a sidebar."*

"For example" is read literally. The evict-blocked case is the instance that has
to work, but the signal is a general **"this session's workspace is in a broken
state"** condition, so a future condition joins it without a second mechanism.

1. A session whose workspace ShipIt cannot put into a safe state is always
   listed in the sidebar. The per-repository cap on resolved sessions must not
   drop it, however old its merge is and however many newer resolved sessions
   the repository has.
2. The condition is a general broken-workspace state, not an evict-specific
   flag: a second cause is added by producing the same signal, not by adding a
   second visibility rule.
3. Such a session asks for the user the same way every other blocked session
   does — the attention marker on its row, and membership in the "Needs you"
   view — and the reason names the problem.
4. An agent turn running in the session does not hide the marker. A broken
   workspace does not fix itself, so "the session will speak again on its own"
   is not true of it.
5. A muted session stays silent. A mute is the user's own statement that the
   session is not theirs to look at now, and it outranks this reason as it
   outranks every other.
6. The state clears on its own once the workspace is no longer broken. No user
   action exists to dismiss it, so a marker that outlived its cause would be
   worse than the silence it replaced.

## Open questions

_None._

## Resolved questions

- 2026-09-12 — *Which surface tells the user?* The user asked for the sidebar.
  The "Needs you" view (docs/260-attention-sidebar-view) takes the sidebar's
  visible sessions as its input, so req 1 is a precondition for req 3 rather
  than an alternative to it; both are in scope.
