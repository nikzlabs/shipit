---
issue: planning#553
title: Follow-up work after ShipIt concludes a rebase
description: The agent continues on its own after an orchestrator-driven rebase finishes, instead of waiting for the user to say "the rebase is done".
---

# Follow-up work after ShipIt concludes a rebase

ShipIt drives the rebase: it fetches, starts it, hands the agent a
conflict-resolution turn, then stages and continues the rebase itself. The agent's
turn therefore ends *before* the rebase is finished. When the agent wants to do
something once the rebase lands — re-run the tests over the merged result, fix a
semantic conflict the markers did not show, update the PR body — nothing happens.
The user has to send a message saying the rebase is finished.

## Requirements

1. When ShipIt concludes a rebase it drove, work the agent means to do afterwards
   starts without the user sending a message to say the rebase is finished.
2. The trigger lives in ShipIt. It is not a convention the user must remember or
   repeat for each session.
3. A rebase that does not conclude — aborted, refused, interrupted — starts no
   follow-up work. The branch is unchanged, so there is nothing to follow up.
4. The agent asks for the follow-up itself, with a command, while it is resolving
   the conflicts. When the agent does not ask, nothing extra runs.
5. The follow-up runs whichever path concluded the rebase. A rebase the user
   started from Sync and a rebase the idle auto-resolver started behave the same,
   including on a session the user has walked away from.
6. The agent supplies a note when it asks. ShipIt gives that note back to the agent
   in the follow-up turn.

## Open questions

- (none)

## Resolved questions

- 2026-09-14 — **What decides that follow-up work runs?** The agent arms it with a
  command during the conflict-resolution turn, the same opt-in shape as
  docs/239-self-merge-wake. Rejected: ShipIt always running one after a rebase that
  had conflicts, and ShipIt posting a button for the user to click. → req 4
- 2026-09-14 — **Does the idle auto-resolve path
  (docs/146-auto-resolve-conflicts-on-idle) also start follow-up work?** Yes, the
  same as the manual path, accepting that a session the user left can start an
  unattended turn. Consistent with the docs/239-self-merge-wake ruling that manual
  and automatic merges must not diverge. → req 5
- 2026-09-14 — **Does the follow-up carry a note the agent wrote, or only the
  outcome?** The agent writes itself a note when it arms, and ShipIt plays it back.
  Chosen over docs/239-self-merge-wake's no-payload shape because the conversation
  may be compacted between resolving the conflicts and the rebase concluding. → req 6

## What exists today

| Path | Agent told the rebase concluded? | When |
|---|---|---|
| Manual sync, conflicts resolved | Yes — `pendingAgentNotice` | Only when the user next sends a message |
| Manual sync, clean rebase | Yes — `pendingAgentNotice` | Only when the user next sends a message |
| Idle auto-resolve | No | — |

`setPendingAgentNotice` (`src/server/orchestrator/services/rebase-driver.ts:129`)
is set only on the manual-sync path (`recordSyncCard: true`), and it is consumed by
the *next user turn* (`src/server/orchestrator/ws-handlers/agent-execution.ts:407`).
That is exactly the manual step this feature removes.
