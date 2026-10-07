---
title: Scheduled sessions
description: Sessions that ShipIt starts by itself on a schedule the user sets, fully preconfigured with the target, model, role and prompt.
---

# Scheduled sessions

From the user's voice-dictated request on 2026-10-07: "Let's design sessions
that are automatically started by cron. For example, every day I want to do
something, and I should be able to configure it and ship it."

1. The user can set up a session that ShipIt starts by itself on a schedule the
   user chooses — for example, every day.
2. Everything a run needs is configured in advance. A run starts with no input
   from the user.
3. A scheduled session is either a sandbox with the access the user granted to
   it, or a session in a particular repository.
4. A schedule sets every parameter the user can set when they start a session
   by hand — for example the model and the role.
5. Scheduled sessions stay consistent with the normal session start: when ShipIt
   adds a parameter to session start, a schedule can set it too.
6. A schedule carries its own prompt, which is the task for each run — for
   example "Check current security PRs and merge them." The user does not have
   to create a role for each job.
7. Each run is a session that the user can open and work in like any other
   session.

## Open questions

- Where does the user create and edit a schedule? (A) The new-session composer
  gets a schedule mode — the same component, so req 5 holds by construction —
  and a Schedules group in the sidebar lists and manages them. (B) A separate
  Schedules page with its own form. (C) The user describes the schedule in chat
  and the agent creates it. Recommended: A.
- Where do runs appear, and what happens to a run that needs nothing from the
  user? Daily runs make about 250 sessions a year per schedule.
- What happens when a run is still going when the next one is due?
- What happens to a run that was due while ShipIt was down?
- How does the user state the time — presets, cron, plain words — and in which
  time zone?
- What does the user see when a run fails to start, and does a schedule that
  keeps failing stop by itself?
- Does a run know what earlier runs of the same schedule did?
- Can something other than the clock start a run — a GitHub event, a webhook?

## Resolved questions
