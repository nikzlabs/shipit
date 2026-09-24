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

- `isSessionDone(session, { hasLiveChild })` — PR resolved and not
  used since, not pinned, no workspace block, no **Keep preview running**
  reservation (req 7), no live child.
- `doneSessionTest(sessions)` — builds the child context from the session list
  itself (a non-archived session whose `parentSessionId` is this one). Every
  list-level caller uses it, so no caller can supply a different context:
  `useSessionGrouping.ts` and `SessionGroup.tsx` in the browser,
  `filterVisibleInSidebar` and the idle enforcer on the server.

`filterVisibleInSidebar` hides a session only when `doneSessionTest` says done
and it is outside the top five and outside a live spawn tree, so a hidden
session is always done (req 2). The ranking of the top five is unchanged.

`child-sessions.ts` calls `isSessionDone` directly, because its "finished"
walks live descendants; it checks "agent busy" beside the test, not inside it.
The old optional `isRunning` input is gone, because only that caller set it.

## Reclaim (reqs 3–6, 8, 9)

`idle-enforcer.ts` runs `reclaimDoneSessions` on every pass (every 30 s and
whenever a runner goes idle), **before** the memory-budget check, so it runs
below the budget too (req 6). A session is stopped when:

- it is done, per `doneSessionTest(sessionManager.listAll())`;
- `DONE_SESSION_RECLAIM_AFTER_MS` (10 min, fixed — reqs 4, 9) has passed since
  the **later** of: the pass that first saw it done (`doneSeenAt`), and the
  runner's `lastViewerDetachAt`. The first clock is not `mergedAt`, because a
  session can become done long after its PR resolved (a pin removed, a
  reservation cleared). The second restarts the wait when the user leaves, and
  after a dropped WebSocket, which also detaches the viewer (req 8);
- it passes `isReclaimable` — no viewer (req 8), agent not busy, not ShipIt's
  own cleanup session.

It disposes the runner (without `preserveComposeOnDispose`), stops the Compose
services, and destroys the container (req 3). A declined dispose skips the
session. The user is told through the existing `session_status` /
`broadcastLog` surfaces, with a done-specific log line.

`doneSeenAt` is in memory, so an orchestrator restart starts the wait again.
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
