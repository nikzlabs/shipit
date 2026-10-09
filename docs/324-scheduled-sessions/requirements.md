---
issue: planning#640
title: Scheduled sessions
description: Sessions that ShipIt starts by itself on a schedule the user sets, fully preconfigured with the target, model, role and prompt.
---

# Scheduled sessions

From the user's voice-dictated request on 2026-10-07: "Let's design sessions
that are automatically started by cron. For example, every day I want to do
something, and I should be able to configure it and ship it. A session could be
a sandbox with predefined access, or in a particular repository, model, or role.
It should all be preconfigured. … given that we may add more settings to the
session start UI and these current sessions should be consistent. I should be
able to collect all the regular parameters, the role, and maybe also the prompt
… it's not very convenient to create a role for every job. So I would say it
would be a separate prompt. For example, 'Check current security PRs and merge
them.'" Requirements 1–7 come from this request; 8 and later from the user's
answers on the same day (see "Resolved questions").

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
   session. (Req 20 says where runs are listed.)
8. The user sets up a schedule by asking the agent in chat, and can change a
   schedule the same way.
9. A schedule that the agent sets up or changes takes effect only after the user
   confirms it, so a run never gets more access than the user approved.
10. ShipIt has a view that lists every schedule, where the user can see each
    schedule and edit it.
11. In that view the user can set everything a schedule holds: the target,
    including a sandbox and its grants; every session-start parameter (req 4);
    the prompt; and the schedule's own options, such as when it runs.
12. Scheduling adds no prominent element to the message input panel.
    Scheduling is rare, and one would distract.
13. Each run has its own notes folder. A run can read the notes folders of the
    earlier runs of the same schedule.
14. A run that comes due while another run of the same schedule is still going
    is skipped, and the skip is recorded on the schedule.
15. When runs came due while ShipIt was down, one catch-up run starts when
    ShipIt is back, however many were missed.
16. The user sets when a schedule runs with a preset (hourly, daily, weekdays,
    weekly) or a cron expression, in their own time zone. A run set for 09:00
    runs at 09:00 local time all year, also across daylight-saving changes.
17. The times at which a schedule's runs come due are at least one hour apart.
    A catch-up run (req 15) or Run now (req 26) does not move or cancel the next
    scheduled run; only the overlap rule (req 14) can skip it. The hour applies
    to the times as the schedule gives them, without clock changes: on a
    daylight-saving day, a run that req 29 moves can come less than one hour
    before the next run.
18. When a run cannot start — for example for want of a credential or quota, or
    because its repository is untrusted or removed — the schedule shows the
    reason and is marked as needing the user.
19. The user can run a schedule now, pause and resume it, and edit it. An edit
    applies from the next run; a run in progress keeps what it started with.
20. Scheduled runs have their own section of the sidebar, opened by a control
    next to the "needs you" control. It is the same UI as the regular session
    list, for scheduled runs only: the runs that are not finished (req 22)
    grouped by repository the same way, and the finished runs under **Recently
    resolved**. Scheduled runs are not in the regular session list.
21. The "needs you" view also shows the scheduled runs that need the user.
22. A run that ended with nothing left for the user — no question, no manual
    step, no open PR — is finished.
23. A run that waits for the user's answer is not "still going" for req 14: the
    next run starts.
24. The view of all schedules (req 10) is a **Schedules** section in Settings,
    beside Roles. Each schedule lists its runs, newest first, with the time, a
    one-line result and a link to the run's session. Skipped runs and failed
    starts are listed there too.
25. A run's session shows which schedule started it, with a link to that
    schedule.
26. Run now has no restrictions: neither the overlap rule (req 14) nor the
    one-hour rule (req 17) holds it back, and it starts a run at once. When any
    run of the schedule is not finished (req 22) — still going, waiting for the
    user, or anything else — the user is warned before the new run starts. A run
    that Run now cannot start is handled as req 18 says.
27. The user can open and read each run's notes in ShipIt's UI.
28. An agent in a session that is not a run of the schedule can read the
    schedule's notes only after the user explicitly approves it for that
    session.
29. On a daylight-saving day, a run time that does not exist runs later by the
    size of the clock change — one hour in almost every time zone — and a run
    time that occurs twice runs once.
30. One approval (req 28) covers the notes of the one schedule the agent asked
    about. Another schedule's notes need their own approval.
31. A schedule that could not start (req 18), and a run that stopped on an
    error — for example, out of quota — show in the "needs you" view. A run that
    stopped on an error is not finished (req 22).
32. The user can delete a schedule. Deleting removes the schedule and its notes
    and keeps its run sessions; those sessions lose their link to the schedule
    (req 25) and their notes (req 27). Delete is refused while a run of the
    schedule is not finished.
33. The user can stop a run that is not finished. A run the user stops is
    finished, so it does not block Delete (req 32). The stop control inside the
    run's session stops the run too.

## Open questions

- (none)

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
- 2026-10-07 — *The smaller defaults?* Offered as: "Overlap: skip and record.
  Missed while ShipIt was down: run once when back. Time: presets or cron, in
  your time zone, stable across daylight saving. Runs at least 1 hour apart.
  Failed start: shown on the schedule as needing you. Run now, Pause, Edit (from
  next run). Clock is the only trigger for now." The user chose "Accept all".
  Carried by reqs 14–19. "The clock is the only trigger
  for now" limits scope only, so it is recorded here and not as a requirement.
- 2026-10-07 — *Where does a run appear in the sidebar, and what happens to a
  run that ended with nothing for the user (no question, no manual step, no open
  PR)?* The user: "I'd say it is a separate section, next to 'needs you' button.
  It would show all cron runs that currently active, grouped per repo same way as
  regular sessions, with an ability to see finished runs in 'recently resolved'.
  Essentially the exact same UI but for cron sessions. But the 'needs you'
  section should show cron sessions that need me, too." Carried by reqs 20–22.
  Req 22 takes "finished" from the case the question named. Req 20's "not in
  the regular session list" reads "a separate section" together with "the
  'needs you' section should show cron sessions … too", which only needs saying
  if runs are not in the regular list.
- 2026-10-07 — *A run waits for the user's answer when the next run is due:
  start the next run, or skip it?* The user chose "next run starts". Carried by
  req 23.
- 2026-10-07 — *Where is the view of all schedules, and how does the user see all
  runs?* The user chose Settings → Schedules, as offered: a section beside
  Roles, each schedule with its run history, newest first (time, one-line
  result, link;
  skipped runs and failed starts too), and a banner in each run's session that
  links back to its schedule. Carried by reqs 24 and 25.
- 2026-10-07 — *Does req 17's one-hour minimum also limit Run now?* The design
  first applied it to Run now as well. The user: "'run now' shouldn't have any
  restrictions. The user should be warned though if there are already runs in
  progress." Req 17 now covers only runs that come due; req 26 carries Run now.
- 2026-10-07 — *Does Run now also warn about a run that only waits for the
  user's answer?* The user: "yes warning if any existing runs are not done".
  Carried by req 26.
- 2026-10-07 — The design let only the schedule's own runs see the notes, so
  the user could not browse them. The user: "yes make them visible in the UI,
  also for the agents (requires an explicit user approval per session)."
  Carried by reqs 27 and 28. The remark answered the agent's statement that
  only the schedule's own runs (req 13) can read the notes, so "also for the
  agents" means agents in other sessions; req 28 covers those. An approval
  covers the schedule the agent asked about; that is the design's reading of
  "per session", later confirmed by req 30.
- 2026-10-07 — Four questions from the second review round, each answered with
  the recommended option:
  - *A run time that does not exist, or occurs twice, on a daylight-saving day?*
    "Hour later, once." The option said "This is what the cron library already
    does"; the library moves a missing time by the size of the clock change,
    which is one hour except in a zone such as Lord Howe Island (30 minutes).
    Req 29 says that. Carried by req 29.
  - *Does one notes approval cover one schedule or all?* "One schedule."
    Carried by req 30.
  - *Do a schedule that could not start and a run that stopped on an error show
    in "needs you", and is such a run not finished?* "Yes to both." Carried by
    req 31.
  - *Can the user delete a schedule?* "Yes, when runs are finished": Delete
    removes the schedule and its notes, keeps its run sessions, and is refused
    while a run is not finished. Carried by req 32.
- 2026-10-07 — Right after choosing req 32, the user: "but I should be able to
  stop a run". Carried by req 33. That a stopped run counts as finished is the
  reading of the remark in the context of req 32, where an unfinished run blocks
  Delete. The agent put that reading to the user ("If you meant only 'stop the
  agent's work', tell me"); the user's reply asked only about the stop button:
  "also if I open that run session and press stop, right?" — the last sentence
  of req 33.
- 2026-10-07 — Two questions from the third review round, each answered with
  the recommended option:
  - *ShipIt missed three daily runs: one catch-up run or one per missed run?
    And if the catch-up starts at 08:59, does the 09:00 run still start?* "One
    catch-up, 09:00 runs": the hour counts scheduled times, and 09:00 is skipped
    only if the catch-up is still going. Carried by reqs 15 and 17.
  - *Should scheduled runs stay out of the regular session list?* "Yes, keep
    them out." Confirms req 20's last sentence.
- 2026-10-07 — During implementation, the storage and timing slice found that
  reqs 17 and 29 conflict in a zone with a 30-minute clock change (Lord Howe
  Island): on the spring day, an hourly schedule's moved run comes 30 minutes
  before the next run, and a check over the next 100 run times refused or
  accepted the same schedule depending on the date it was saved. Offered:
  ignore the shift, refuse such schedules all year, or skip the early run. The
  user chose "Ignore the shift": the check uses the run times as the schedule
  gives them, without clock changes, and the overlap rule (req 14) still skips
  the next run while the moved run is going. Carried by req 17.
