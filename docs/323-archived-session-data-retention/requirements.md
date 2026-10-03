---
issue: planning#632
title: Retention period for archived session data
description: ShipIt keeps the /persist files and the uploads of an archived session for a retention period, then deletes them.
---

# 323 — Retention period for archived session data

ShipIt keeps two directories of user data for each session outside git:

- the `/persist` directory (`<workspace-root>/sessions/<id>/scratch/`), and
- the uploads directory (`<workspace-root>/sessions/<id>/uploads/`).

Archive deletes the session's checkout, its dependency overlay and its state
directory. It keeps these two directories, with no time limit, so that restore
brings them back. That was a decision: `docs/217-persistent-session-scratch`
(Lifecycle) says "retain until full reset", and says to revisit it when real
disk pressure from `/persist` shows up.

Measured on the production host on 2026-10-01 (290 GB disk), for archived
sessions:

- `/persist` uses 18.0 GB in total, in 1075 sessions. 14.4 GB is in sessions
  that were used in the last 30 days. 3.6 GB is in sessions that were not used
  for 30 days or more.
- The size is very unequal. 1014 sessions have less than 10 MB each, and
  0.1 GB together. 30 sessions have 100 MB or more each, and 16.6 GB together.
  5 of those have 1 GB or more each, and 7.1 GB together. No session has 5 GB.
- Uploads use less than 0.2 GB in total.

Source: the request came from the production disk analysis on 2026-10-01. The
request gives the two directories and the limit to archived sessions. The user
gave the other answers on the same day; see "Resolved questions".

## Requirements

1. ShipIt keeps the `/persist` files and the uploads of an archived session for
   a retention period. When the period ends, ShipIt deletes them.
2. The retention period applies to a session that the user archived, and to a
   done session (requirement 11). Each other session keeps its `/persist` files
   and its uploads with no time limit.
3. The retention period is 60 days. A session with much data has a shorter
   period (requirement 13).
4. The period starts when the user archives the session. When the user restores
   a session and archives it again, a new period starts.
5. A session that was archived before this feature counts from the day the
   feature starts to run. Thus ShipIt deletes nothing during the first period.
6. The person who deploys ShipIt can change the two periods and the size limit
   of requirement 13 with environment variables. There is no row for them in
   Settings.
7. The row of an archived session in **All sessions** shows the date on which
   ShipIt will delete the session's files.
8. Restore of an archived session works after ShipIt deleted its files. The
   restored session has an empty `/persist` and no uploads.
9. After such a restore, the transcript has a notice that says which files
   ShipIt deleted, and on which date. The agent gets the same fact.
10. The retention period also applies to the checkout of an archived sandbox
    session that has no remote. Requirements 7, 8 and 9 apply to it: the row
    shows the date, restore works with an empty workspace, and the notice names
    the checkout.
11. The retention period also applies to a done session that the user did not
    archive. "Done" has the one definition that the browser and the server
    share (`docs/316-done-sessions-return-memory` req 1 and req 2). This feature
    does not make its own definition. Thus a pinned session, which is not done,
    keeps its files.
12. For a done session that is not archived, the period starts at its last use,
    or when its pull request merged or closed, the later of the two. It does
    not start before the day the feature starts to run (requirement 5). A
    message in the session starts a new period. Requirements 7, 8 and 9 apply:
    the row shows the date, the session opens with an empty `/persist` and no
    uploads, and the transcript has the notice.
13. A session whose files use 100 MB or more has a retention period of 14 days.
    The size is the total of the session's files that the retention deletes.

## Requirements of other features that this one touches

These are not new. They are here because this feature changes what they mean in
practice.

- `docs/317-compose-persist-mount` req 2: data that a Compose service writes
  through a `persist` mount has the same lifecycle as `/persist`. Thus the
  retention period also deletes that data.
- `docs/317-compose-persist-mount` req 8: the agent-facing documentation states
  what happens to `/persist` on archive and on restore. Today it says "Kept".
  That text must change together with this feature.

## Not in scope

- Tool output of archived sessions in the SQLite database
  (`messages.tool_results`): approximately 3 GB.

## Open questions

(none)

## Resolved questions

- 2026-10-01 — How long is the retention period? The user: "60 days, env var".
  Requirement 3.
- 2026-10-01 — Can the period be changed, and by whom? The user: an environment
  variable, no row in Settings. Requirement 6.
- 2026-10-01 — When does the period start? The user: at archive time. The answer
  includes: restore and a new archive start a new period, and sessions archived
  before the feature count from the day the feature ships. Requirements 4 and 5.
- 2026-10-01 — Does ShipIt tell the user before it deletes the files, and what
  does restore show when the files are gone? The user: the date on the archived
  row, and a notice on restore. The answer includes: restore continues to work,
  and the agent gets the same fact. Requirements 7, 8 and 9.
- 2026-10-01 — Does the user want to add related data to the scope? The user
  added the checkouts of archived sandbox sessions that have no remote (18
  sessions, 7.9 GB, the only copy of that work). Requirement 10. The user did
  not add the tool output in the database, so it stays out of scope. For the
  third set, sessions that are evicted but not archived, the user asked what
  these sessions are; that question stays open above.
- 2026-10-01 — Are there two periods, a short one for a session with much data
  and a long one for a session with little data? The user asked this ("if it is
  5 GB, it makes sense to delete early, whereas 20 MB could be kept for
  longer"). The measurement showed that 30 of the 1075 archived sessions hold
  16.6 GB of the 18.0 GB, and that no session has 5 GB. The user then chose:
  100 MB or more gets 14 days, each other session gets 60 days, the size is the
  total of the files that the retention deletes, and the size limit and the two
  periods are environment variables. Requirements 3, 6 and 13.
- 2026-10-01 — Does the feature also apply to finished sessions that the user
  did not archive? Measured: 742 sessions are evicted but not archived, and
  their `/persist` uses 18.1 GB. 737 of them are sessions whose pull request
  merged or closed. The sidebar shows only the newest 5 resolved sessions for
  each repository, so most of them are visible only in **All sessions**. The
  user: "yes, add them. There should be a notion of a 'done' session consistent
  between server and client, use it." The answer includes: the period starts at
  the last use or at the merge or close, the later of the two, and not before
  the day the feature ships; a message starts a new period; a pinned session
  keeps its files; the same row date and notice apply. Requirements 2, 11 and
  12.
