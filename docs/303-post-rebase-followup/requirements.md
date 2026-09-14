---
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

## Open questions

- **What decides that follow-up work runs?** The agent arms it during the
  conflict-resolution turn (the `shipit session notify-on-merge --self` shape from
  docs/239-self-merge-wake), ShipIt always runs one after a rebase that had
  conflicts, or ShipIt asks the user.
- **Does the idle auto-resolve path (docs/146-auto-resolve-conflicts-on-idle) wake
  the session?** That path runs while the user is away, so follow-up work there is
  an unattended turn on a session the user left.
- **Does the follow-up carry a note the agent wrote for itself, or only the fact
  that the rebase concluded?** docs/239-self-merge-wake deliberately carries no
  payload: it is the same session, so the agent re-reads its own conversation.

## Resolved questions

- (none yet)

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
