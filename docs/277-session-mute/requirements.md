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
6. Only a session that is asking for the user's attention, and whose agent is
   not working, can be muted.
7. A mute is stored with the session, not with the browser: a session muted on
   one device is muted on every other one.
8. A muted session carries no mute mark in the session list. It looks like a
   session with nothing pending.

## Open questions

_(none — see the receipts below)_

## Resolved questions

- **2026-08-20 · Q4 — can a session be muted before it asks for anything?** No.
  Nik: *"only a session which agent is not active can be muted"*, *"only while
  it needs attention"* → requirement 6. The two halves are one rule in this
  product: a session whose agent is working never needs attention in the first
  place, and a session held at a permission prompt has a working agent, so
  neither can be muted.
- **2026-08-20 · Q2 — does a mute follow the user or the browser?** The user.
  Nik: *"On the server, per session"* → requirement 7.
- **2026-08-20 · Q3 — is a muted session marked as muted?** No. Nik: *"No
  visible mark"* → requirement 8.
- **2026-08-20 · Q1 — what does a mute silence?** Everything. Not asked again
  after the answers above: requirement 2 is the human's own opening sentence
  ("so it doesn't require attention"), and requirement 8 settles the rest — a
  row that kept its amber marker would be wearing a visible mark of exactly the
  kind requirement 8 rules out.
