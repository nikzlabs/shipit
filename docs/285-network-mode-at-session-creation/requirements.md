---
issue: planning#483
title: Network mode at session creation
description: Choose a new session's network containment before its first message, from the new-session composer and from Quick Capture.
---

# Network mode at session creation

1. The regular new-session UI (the `/{owner}/{repo}/new` composer) lets me set the
   new session's network mode before I send its first message.
2. The Quick Capture (quick session) UI lets me set the new session's network mode
   before I send its first message.
3. The mode I pick is in force for the session's **first** turn. I never have to
   start the session, stop it, change Session settings, and continue it.
4. "Network mode" is the same choice the session's own Session settings dialog
   offers — Inherit global / Contained / Open. It is not the host allowlist, which
   stays where it is (Settings → Network, and the blocked-egress card).
5. The control states what it will do before I commit to it: which mode the session
   will start in, and — when the mode is not the inherited default — that it is a
   deliberate change from the workspace setting.
6. A session that is already running keeps exactly one control over its network
   mode (Session settings). The creation-time control does not become a second,
   competing one after the first turn.

## Open questions

- Does the pick **stick** to the next new session (like the model and harness
  seeds), or reset to "Inherit global" every time (like the Quick Capture
  auto-merge checkbox, which is deliberately never persisted)?
- On Quick Capture, does the control belong in the **composer toolbar** (beside
  the permission mode, which docs/260 req 19 already pulls out into that row) or
  on the **footer line** beside "Auto-merge when ready", where the overlay's other
  creation-time choice already lives?

## Resolved questions

- (none yet)
