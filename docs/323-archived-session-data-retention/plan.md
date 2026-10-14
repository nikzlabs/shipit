---
issue: planning#632
title: Retention period for archived session data — design
description: One hourly sweep measures the kept files of archived and done sessions, and deletes them when their retention period ends.
---

# 323 — Retention period for archived session data (design)

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## What is deleted

A session directory is `<sessions-root>/<id>/` with these children:

| Child | Mounted at | Deleted by this feature |
|---|---|---|
| `scratch/` | `/persist` | Its contents (req 1) |
| `uploads/` | `/uploads` | Its contents (req 1) |
| `workspace/`, `overlay/`, `state/` | `/workspace` and its caches | Only for an archived sandbox session that has no remote (req 10) |

`scratch/` and `uploads/` are emptied, not removed, so each path that mounts
them or lists them continues to find a directory with the correct owner. The
sandbox checkout goes through `reclaimRegenerableSessionDirs`, the function the
archive path and the disk ladder already use.

The sweep does nothing for a session whose `workspace_dir` is not exactly
`<sessions-root>/<id>/workspace`. Its siblings are then not the directories
above. It also does nothing with `scratch` or `uploads` when a symlink is there
in place of the directory. On the production host, each of the 1899 sessions
had that exact path on 2026-10-01.

## Which sessions, and when the period starts

`src/server/shared/session-retention.ts` holds the rule as pure functions, so
the list that the browser gets and the sweep cannot disagree about a date.

- A session is under retention when the user archived it, or when it is done
  (req 2, req 11). "Done" is `doneSessionTest` from
  `src/server/shared/session-resolution.ts`, built from the full session list,
  as `docs/316-done-sessions-return-memory` requires. A pinned session, a
  session with **Keep preview running**, and a session with a broken workspace
  are not done, so they are not under retention.
- Archived: the period starts at `archived_at` (req 4). `SessionManager.archive`
  sets it, and `unarchive` clears it, so a new archive starts a new period.
- Done and not archived: the period starts at the latest of the merge or close
  time, `last_used_at` and `last_viewed_at` (req 12). `last_viewed_at` is
  included because the disk ladder already counts a view as use
  (`diskIdleAgeMs` in `tier-escalation.ts`); without it, a session the user
  opened yesterday could lose its files today.
- No period starts before `retention_floor_at` (req 5, req 12). The migration
  writes the time it runs into that column for each session that exists then,
  and into `archived_at` for each session that is archived then. A session
  created later has no floor.

## Size and the two periods

The period is 14 days when the kept files use 100 MB or more, and 60 days
otherwise (req 3, req 13). The size is the total of the files the sweep would
delete for that session: file blocks under the directories of the table above.
Each file counts as 1 byte or more, so a session that has only empty files
still has files to delete.

The sweep measures the size and stores it in `retained_data_bytes`, with the
time in `retained_data_measured_at`. A stored size is stale, and is measured
again, when it is older than the start of the period. Thus a session that was
used again gets a new measurement, and a session that was not changed is
measured once.

A session with no kept files has size 0. It gets no date, no deletion and no
notice. On the production host that is most sessions.

`dataRetentionConfigFromEnv` (`data-retention-config.ts`) reads the three
values (req 6). They are passed to the orchestrator container in
`deployment/vps/docker-compose.yml`. A value that is not a complete number, or
is negative, gives the default, so a typing error cannot make a period shorter.

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_DATA_RETENTION_DAYS` | 60 | The period. `0` keeps the files of each session with no time limit, also of a large session. |
| `SESSION_DATA_RETENTION_LARGE_DAYS` | 14 | The period for a large session. `0` gives a large session the normal period. |
| `SESSION_DATA_RETENTION_LARGE_MB` | 100 | The size from which a session is large. |

## The sweep

`sweepRetainedSessionData` (`data-retention-sweep.ts`) runs in the disk
escalation pass (`kickDiskEscalation` in `startup-monitors.ts`), after the tier
ladder and the cache reclaim. That pass runs at startup, on each session
activation and each hour, with one pass at a time. The archive route
(`DELETE /api/sessions/:id`) also starts a pass, so the date of a session is
there soon after the user archives it. The two other archive paths (removal of
a repository, and the rollback handler) get the date from the next pass. The
pass does not run in local runtime mode, which has no containers.

A session is **live** when it has a runner, a container or a Compose service
manager, or when a restore of it is in progress (`isRestoreInFlight` in
`services/session.ts`; a session keeps its archived flag until the restore is
complete). A live session can have the directories in use, so the sweep does not
measure it and does not delete from it. The sweep does not depend on another
mechanism to stop the session first: it checks, and tries again in the next
pass.

For each session under retention:

1. Measure the size when it is missing or stale, unless the session is live.
2. Calculate the deletion time. Stop when there is none, or it is in the future.
3. Stop the session's Compose stack by project name. A stack that an earlier
   orchestrator process started is in no map of this process, and could have
   `/persist` mounted. When the stop fails, the files stay. This is the step
   that `reclaimToEvicted` (`tier-escalation.ts`) does before it deletes a
   workspace.
4. Measure the files again, store that size, and list the entries to delete.
   Thus the period comes from what is on disk now, not from an earlier
   measurement.
5. Take the decision again from the session list as it is now: still under
   retention, still due with the new size, not live. No `await` is between
   this check and the first deletion.
6. Delete the listed entries, write the notices, and set the stored size to 0.

The check is repeated after each step that waits (steps 3 and 4), because the
user can restore or open the session during the wait. A file that a session
creates after step 4 is not in the list, so it is not deleted.

When a part of the deletion fails, the notice names only the parts that were
deleted, the stored size becomes the size of what is left, and a later pass
deletes the rest and writes a second notice.

## What the user sees

- **The date on the row (req 7, req 12).** `SessionManager.list()` and
  `listAll()` put `dataDeletesAt` on each session that has a deletion time.
  `SessionItem` shows it, with a tooltip that says what is deleted. The same
  component renders the rows of **All sessions** and of the sidebar, so a done
  session under **Recently resolved** shows the date too.
- **The notice (req 9, req 12).** At deletion time the sweep appends a notice to
  the session's persisted chat history (`persistNoticeUnattached`). It names
  the files that were deleted, the size, the date and the reason. It is the last
  row of the transcript when the user restores or opens the session.
- **The agent (req 9).** The sweep also appends a pending agent notice
  (`appendPendingAgentNotice`), which the next turn of the session delivers to
  the agent once. The two notices are written separately, so a failure of one
  does not stop the other.
- **An open All sessions dialog.** The `session_list` event has no archived
  rows. When the dialog is open, the browser fetches all sessions again on that
  event, so the date appears when the sweep has measured the session.

Known limit (planning#633): a manual branch reset and the rebase driver replace the pending
agent notice (`setPendingAgentNotice`). When the user does one of these in a
session before the first message after a deletion, the agent does not get the
fact. The notice in the transcript stays.

## Restore (req 8, req 10)

Restore needs no change for `/persist` and uploads: the directories are still
there, and they are empty.

`unarchiveSession` re-creates the workspace of a sandbox session that has no
remote when the directory is gone. Without this, activation fails with "Session
workspace is gone and has no remote to restore from" (`restoreSessionWorkspace`).
A new sandbox workspace is an empty directory, so the re-created one is too.

## Documentation

`docs/317-compose-persist-mount` req 8 requires the agent-facing docs to state
what happens to `/persist` on archive. `environment.md` ("What survives what"),
`compose.md` and the wiki page `sessions.md` now give the two periods.

## Key files

- `src/server/shared/session-retention.ts` — the rule: start of the period,
  stale size, deletion time.
- `src/server/orchestrator/data-retention-config.ts` — the three variables.
- `src/server/orchestrator/data-retention-sweep.ts` — measure, delete, notify.
- `src/server/orchestrator/sessions.ts` — `archive`, `unarchive`,
  `setRetainedData`, and `dataDeletesAt` on the lists.
- `src/server/shared/database.ts` — the migration.
- `src/server/orchestrator/startup-monitors.ts` — the sweep in the pass.
- `src/server/orchestrator/services/session.ts` — `unarchiveSession` re-creates
  a sandbox workspace.
- `src/client/components/SessionSidebar/SessionStatusIndicators.tsx` — the date
  on the row.
