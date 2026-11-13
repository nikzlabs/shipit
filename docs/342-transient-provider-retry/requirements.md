---
issue: planning#720
title: Continue automatically after a temporary provider error
description: An off-by-default setting that resumes the same agent conversation after a Cloudflare block page, an overloaded model or a 5xx ends a turn.
---

# Continue automatically after a temporary provider error

Source: the Ops session's request after Anthropic's 2026-11-13 incident, when model
calls intermittently got `403 Attention Required | Cloudflare` from api.anthropic.com,
mostly on the call right after a tool result. Typing "continue" in the same session
worked; signing in again never did.

1. A ShipIt setting, off by default, shown in the Settings dialog and in
   `shipit settings list` / `get`. With it off, a turn behaves as before.
2. A Cloudflare block page (a 403 with "Attention Required" or Cloudflare HTML), an
   overloaded model (529) and a 5xx are classified as temporary provider errors,
   separately from auth failures, on Claude Code and on OpenCode 2.
3. On Claude Code, a Cloudflare 403 is never read as a login failure, whether the
   setting is on or off.
4. With the setting on, when such an error ends a turn, ShipIt does not send the
   original prompt again. It continues the SAME agent conversation with a short ShipIt
   continuation prompt.
5. Continuations back off — 30 seconds, 2 minutes, 5 minutes — then stop with a clear
   message. Each automatic continuation shows a visible notice. A new user message, or
   the user stopping the turn, cancels what is pending.
6. This path never touches auth state: no forced token refresh, no `auth_failed`
   marking, no account failover.
7. The commit, lease and post-turn ordering that any new turn needs is kept.
8. A real 401 still goes to auth recovery.

## Open questions

## Resolved questions

- 2026-11-13 — Should the number of attempts be a setting too? The request made it
  optional. Decided in the implementing session: no; the schedule is fixed at three
  attempts (req 5), which keeps the setting a single switch. A later request can add it.
