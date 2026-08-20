---
issue: planning#461
title: Mute a session
description: Silence a session's attention signals until its next turn starts, without archiving it.
---

# Requirements — mute a session

Human-owned. Numbered statements are what the feature must do, in observable
terms. Design lives in `plan.md`.

## Requirements

1. The user can mute a session.
2. A muted session does not need the user's attention. For as long as it is
   muted, the product does not present it as needing attention.
3. Muting changes nothing else about the session. It stays active, it stays in
   the session list, and the user can open it and work in it as before.
4. A mute ends when a new turn starts in that session, whatever started that
   turn. From that moment the session needs attention again by the usual rules.
5. The user can unmute a session before that.

## Open questions

- **Q1 — What does a mute silence?** Everything that says "this session needs
  you" (the amber row marker, the "Needs you" count and view, the browser
  notification and the voice note), or only the interruptions (notification and
  voice note), keeping the marker on the row?
- **Q2 — Does a mute follow the user, or the browser?** Stored with the session
  on the server (the same session looks muted on a phone and on a laptop), or
  stored in this browser only (each device mutes for itself)?
- **Q3 — Is a muted session marked as muted?** A quiet icon on the row, or no
  visible mark at all?
- **Q4 — Can the user mute a session that is not asking for anything yet?** For
  example while its agent still runs, so that it stays quiet when it stops.

## Resolved questions

_(none yet)_
