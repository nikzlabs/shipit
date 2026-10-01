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

- `/persist` uses 18.0 GB in total. 14.4 GB is in 438 sessions that were used in
  the last 30 days. 3.6 GB is in 634 sessions that were not used for 30 days or
  more.
- Uploads use less than 0.2 GB in total.

Source: the request came from the production disk analysis on 2026-10-01. The
request gives the two directories and the limit to archived sessions. It gives
no period and no behaviour, so each of those is an open question below.

## Requirements

1. ShipIt keeps the `/persist` files and the uploads of an archived session for
   a retention period. When the period ends, ShipIt deletes them.
2. The retention period applies only to a session that the user archived. A
   session that is not archived keeps its `/persist` files and its uploads with
   no time limit. This includes a session whose checkout ShipIt reclaimed for
   disk but which the user did not archive.

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

The disk analysis found three related sets of data. They are not part of this
feature unless the user adds them.

- `/persist` of sessions that are evicted but not archived: 18.1 GB.
- The checkouts of 18 archived sandbox sessions that have no remote: 7.9 GB.
  These checkouts are the only copy of that work.
- Tool output of archived sessions in the SQLite database
  (`messages.tool_results`): approximately 3 GB.

## Open questions

- How long is the retention period?
- When does the period start: when the user archives the session, or at the
  session's last use? ShipIt does not record the archive time today, so the
  answer must also say what applies to sessions that were archived before this
  feature.
- Does ShipIt tell the user before it deletes the files? If so, how?
- What does restore do, and what does it show, when the files are gone?
- Can the period be changed? If so, by whom: the person who deploys ShipIt, or
  the user in Settings?
- Does the user want to add one of the three sets of data under "Not in scope"?

## Resolved questions

(none)
