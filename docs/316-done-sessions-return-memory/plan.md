---
issue: planning#616
title: Done sessions return their memory — design
description: One shared "done" test for the sidebar, the sidebar cap and the idle enforcer; the enforcer stops done sessions 10 minutes after their PR resolves.
---

# 316 — Done sessions return their memory (design)

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## One definition (reqs 1, 2, 7)

Before this change, "resolved" was computed four ways: the sidebar sort and the
group renderer each built their own child context for `isResolvedForGrouping`,
the sidebar cap used `isTerminalPrResolved` with its own exemption list, and
the idle enforcer did not ask at all.

Now `src/server/shared/session-resolution.ts` owns it:

- `isSessionDone(session, { hasUnfinishedDescendant })` — PR resolved and not
  used since, not pinned, no workspace block, no **Keep preview running**
  reservation (req 7), and no unfinished descendant.
- `doneSessionTest(sessions)` — builds the descendant context from the session
  list itself. Only a non-archived descendant whose own work is not finished
  counts: it marks its root (`rootSessionId`) and each non-archived ancestor up
  its `parentSessionId` chain, and the walk stops at an archived ancestor. So a
  spawn tree whose every session is merged is done.
- The server list holds rows the browser never gets: archived rows and done
  rows the cap hides. None of them can mark another session, so the browser
  and the server give the same answer for every row the browser gets (req 1).
- The browser builds the test **once, from the whole session list**, in
  `SessionSidebar.tsx`, and passes it to `computeRepoGroups` and each
  `RepoGroup`. A test built from one repo's rows, or from the repos not
  hidden, did not see a child in another repo, and put a parent the server
  kept visible under **Recently resolved**.

`filterVisibleInSidebar` shows a session when it is not done, or it is in the
top five, or it is a member whose root is shown for one of those reasons. So a
hidden session is always done (req 2), and a done root outside the top five no
longer stays visible only because it has spawned sessions. The ranking of the
top five is unchanged.

`child-sessions.ts` calls `isSessionDone` directly, because its "finished"
walks live descendants; it checks "agent busy" beside the test, not inside it.
The old optional `isRunning` input is gone, because only that caller set it.

## Reclaim (reqs 3–6, 8, 9)

`idle-enforcer.ts` runs `reclaimDoneSessions` on every pass (every 30 s and
whenever a runner goes idle), **before** the memory-budget check, so it runs
below the budget too (req 6). A session is stopped when:

- it is done, per `doneSessionTest(sessionManager.listAll())`;
- `DONE_SESSION_RECLAIM_AFTER_MS` (10 min, fixed — reqs 4, 9) has passed since
  `doneWaitFrom`, the pass that first saw it done. It is not `mergedAt`,
  because a session can become done long after its PR resolved (a pin removed,
  a reservation cleared);
- it passes `isReclaimable` with `ignoreViewers` — an open session is stopped
  too (req 8) — agent not busy, not ShipIt's own cleanup session. The
  memory-budget tiers still skip a session with a viewer.

It disposes the runner (without `preserveComposeOnDispose`), stops the Compose
services, and destroys the container (req 3). A declined dispose skips the
session. The user is told through the existing `session_status` /
`broadcastLog` surfaces, with a done-specific log line.

`doneWaitFrom` is in memory, so an orchestrator restart starts the wait again,
and a session that stops being done and becomes done again between two passes
(30 s) keeps its earlier start.
If `compose down` fails for a session with no agent container, `ServiceManager`
suppresses the error and nothing retries — the same limit the docs/284 tier-2
path has.

A message after the merge sets `lastUsedAt` after `mergedAt`, so the session is
no longer done (req 5) and the next turn starts a fresh container.

## Key files

- `src/server/shared/session-resolution.ts`
- `src/server/orchestrator/idle-enforcer.ts` (+ `idle-enforcer.test.ts`)
- `src/server/orchestrator/sessions.ts` — `filterVisibleInSidebar`
- `src/client/components/SessionSidebar/useSessionGrouping.ts`, `SessionGroup.tsx`
