---
issue: planning#640
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

Prior art and the ShipIt facts behind these: [research.md](./research.md).
UI sketch of the recommended answer to the first one:
[mockup.html](./mockup.html).

- Where does the user create and edit a schedule? (A) The new-session composer
  gets a schedule mode — it is already one component for new session, chat and
  Quick Capture — and a Schedules group in the sidebar lists them. (B) A
  separate Schedules page with its own form. (C) The user describes it in chat
  and the agent creates it. (D) A file in the repository, shipped by PR.
  Recommended: A.
- Where do runs appear, and what happens to a run that needed nothing from the
  user? A daily schedule makes about 250 sessions a year. Recommended: runs nest
  under their schedule; a run that ends with no question and no PR folds into
  the schedule's history, out of the main list.
- Does a run know what earlier runs of the same schedule did? Recommended: no;
  each run starts fresh and reads live state, such as the open PRs.
- Smaller defaults, recommended as a set:
  - A run that comes due while the previous run is still going is skipped,
    and the skip is recorded.
  - A run that came due while ShipIt was down runs once when ShipIt is back.
  - The user picks the time from presets (hourly, daily, weekdays, weekly) or
    writes cron, in their own time zone; 09:00 stays 09:00 across daylight
    saving.
  - Runs are at least one hour apart.
  - A run that cannot start (credential, quota, untrusted repository, removed
    repository) shows on the schedule with the reason, as needing the user.
  - Each schedule has Run now, Pause and Edit. An edit applies from the next
    run.
  - The clock is the only trigger for now.

## Resolved questions
