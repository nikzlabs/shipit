---
issue: planning#640
title: Scheduled sessions
description: Sessions that ShipIt starts by itself on a schedule the user sets, fully preconfigured with the target, model, role and prompt.
---

# Scheduled sessions

From the user's voice-dictated request on 2026-10-07: "Let's design sessions
that are automatically started by cron. For example, every day I want to do
something, and I should be able to configure it and ship it." Requirements 8
and later come from the user's answers on the same day; see "Resolved
questions".

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
8. The user sets up a schedule by asking the agent in chat, and can change a
   schedule the same way.
9. A schedule that the agent sets up or changes takes effect only after the user
   confirms it, so a run never gets more access than the user approved.
10. ShipIt has a view that lists every schedule, where the user can see each
    schedule and edit it.
11. In that view the user can set everything a schedule holds: the target,
    including a sandbox and its grants; every session-start parameter (req 4);
    the prompt; and the schedule's own options, such as when it runs.
12. Scheduling adds no control to the message input panel. Scheduling is rare,
    and a control there would distract.
13. Each run has its own notes folder. A run can read the notes folders of the
    earlier runs of the same schedule.
14. A run that comes due while the previous run of the same schedule is still
    going is skipped, and the skip is recorded on the schedule.
15. A run that came due while ShipIt was down runs once when ShipIt is back.
16. The user sets when a schedule runs with a preset (hourly, daily, weekdays,
    weekly) or a cron expression, in their own time zone. A run set for 09:00
    runs at 09:00 local time all year, also across daylight-saving changes.
17. A schedule's runs are at least one hour apart.
18. When a run cannot start — for example for want of a credential or quota, or
    because its repository is untrusted or removed — the schedule shows the
    reason and is marked as needing the user.
19. The user can run a schedule now, pause and resume it, and edit it. An edit
    applies from the next run; a run in progress keeps what it started with.

## Open questions

Prior art and the ShipIt facts behind these: [research.md](./research.md).

The user asked to think the runs question through carefully: "What happens if
a run needs my action? Would they be grouped per repository? How to see all
runs?" The first three bullets are that question, split up.

- Where does a run appear in the sidebar, and what happens to a run that ended
  with nothing for the user? Recommended: in its repository's group (or the
  Sandbox group) like any session, marked as a scheduled run and named after
  its schedule and date. A run that ends with no question, no manual step for
  the user and no open PR counts as **done** (docs/316-done-sessions-return-memory):
  it moves under **Recently resolved**, the sidebar cap hides it later, and its
  container stops after 10 minutes. A run that needs the user shows in the
  attention list and sends a voice note, as any session does.
- A run is waiting for the user's answer when the next run is due. Is the
  waiting run "still going" (req 14, so the next run is skipped)? Recommended:
  no — the next run starts, so a task such as merging security fixes is not
  held up by one open question.
- Where is the view of all schedules (req 10), and how does the user see all
  runs? Recommended: **Settings → Schedules**, beside Roles. Each schedule lists
  its runs, newest first, with the time, a one-line result and a link to the
  run's session; skipped and failed starts are listed there too.

## Resolved questions

- 2026-10-07 — *Where does the user create and edit a schedule: a schedule mode
  in the composer, a separate page, by chat, or a file in the repository?* The
  user chose chat: "Ask the agent in chat, the UI needs to support: sandbox
  mode, additional options not in the input panel now (e.g. the schedule
  itself), an ability to view all schedules and edit them. This use-case is rare
  so adding one more prominent UI element to the input panel would be
  distracting." Carried by reqs 8, 10, 11 and 12. The chat option, as offered,
  said the user confirms the schedule on a card; req 9 carries that.
- 2026-10-07 — *Does a run know what earlier runs did?* The user: "need to be
  some kind of notes, one folder per run. A single file is inflexible and
  eventually will grow too much." Carried by req 13.
- 2026-10-07 — *The smaller defaults (overlap, missed runs, time, minimum
  interval, failed starts, Run now / Pause / Edit, triggers)?* The user accepted
  all of them as offered. Carried by reqs 14–19. "The clock is the only trigger
  for now" limits scope only, so it is recorded here and not as a requirement.
