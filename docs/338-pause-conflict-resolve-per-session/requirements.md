---
issue: planning#716
title: Pause conflict auto-resolve per session — requirements
description: A per-session switch for "Auto-resolve conflicts when the base branch moves", like the per-session Auto-fix CI switch.
---

# Pause conflict auto-resolve per session

Requested 2026-11-03: *"'Auto-resolve conflicts when the base branch moves' this
should be togglable per-session, too, similar to the CI."* Requirements 2–4 are
what "similar to the CI" means: the docs/186 Auto-fix CI switch behaves that way.

1. Each session has its own switch for auto-resolving conflicts when the base
   branch moves, beside the workspace setting *"Auto-resolve conflicts when the
   base branch moves"*.
2. The switch sits in the pull request's ⋮ menu, as the Auto-fix CI switch does,
   and appears only when the workspace setting is on and the session has a remote.
3. The session's choice survives a page reload and an orchestrator restart.
4. The workspace setting stays the master: off in the session stops automatic
   conflict resolution for that session only, and the session switch can never
   start it while the workspace setting is off.
5. An attempt that has already started when the user pauses finishes; no new
   attempt starts while the session is paused, and the next poll after a resume
   can start one.

## Open questions

## Resolved questions
