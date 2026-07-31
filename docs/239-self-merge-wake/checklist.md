# Self-merge wake — checklist

The existing merge-watch pointed back at the same session. No new column, no parallel
manager, no chain object, no card lifecycle. If an item here looks like a subsystem,
it has been cut — see the plan's "Resolved decisions".

## Prerequisite

- [x] **SHI-262** — the finished turn's commit completes before a queued turn starts ✅ merged
- [x] **SHI-263** — a dispatch that throws during setup settles `errored`, restores the runner,
      and releases the queue (`dispatchOnRunner`), so a failed delivery reaches the SHI-258
      supervisor instead of looking permanently in flight

## Watch

- [x] Optional `{ kind: "self", watchId, prNumber }` on `SessionMergeWatch`; `parentSessionId === sessionId`
- [x] Self-arm refused when the row holds a genuine parent→child watch
- [x] Arming always replaces an existing self-watch, including one delivering

## Arm / cancel

- [x] `shipit session notify-on-merge --self` — no payload
- [x] Live open-PR lookup (`findPullRequest`); store the PR number
- [x] One refusal: no open PR for the current branch
- [x] Cancel carries `watchId`; clears the watch and acknowledges
- [x] Container-accessible route golden test

## Delivery

- [x] Fire from `onMergeDetectedCb` after `markMergedAndPruneExcess` resolves
- [x] Read PR facts from the persisted snapshot — no callback signature change
- [x] Merged PR number ≠ anchor → append a note, clear the watch, no turn
- [x] Closed-without-merge from `onPrTerminalState` → note, clear, no turn
- [x] `watchId` checked on asynchronous settlement
- [x] `reconcilePending` branches on `kind`
- [x] `wakeSessionWithTurn` restores the checkout when missing

## Reset command

- [x] `shipit branch reset-to-base` — explicit mode over the existing reset core
- [x] Ignores `getAutoResetMergedBranch()`
- [x] Idempotent: already-at-base → exit 0 "proceed", checked **before** the `mergedHeadSha` gate
- [x] Force-push failure reported as failure
- [x] `handWorkspaceBackToWorker` in a `finally`
- [x] Exit 0 for reset/already-at-base; nonzero with a reason otherwise
- [x] Refusal copy says why and forbids a hand-rolled reset
- [x] Successful explicit reset clears composer eligibility, re-arms the PR
      lifecycle, and persists the same branch-updated card as docs/218

## Prompt + card

- [x] `orchestrator/prompts/self-merge-wake.md`: merged; run reset first; stop if it refuses; continue the earlier request unless redirected; re-arm if work remains
- [x] Arm card via `emitChatCard`, with Cancel
- [x] Notes (not cards) for closed / mismatch / delivery failure

## Tests

- [x] Arm refused with no open PR; live lookup after `gh pr create` anchors to the new PR
- [x] Arm card persists and round-trips; stale-`watchId` Cancel doesn't cancel a newer watch
- [x] Fires after merge bookkeeping
- [x] Anchor mismatch → note, no turn
- [x] Closed-without-merge → note, no turn
- [x] Old settlement doesn't mark a newly-armed watch delivered
- [x] Wake against a missing checkout restores it
- [x] Reset: refuses on dirty tree / moved HEAD / detached / sequencer
- [x] Reset: second invocation → already-at-base; runs with the docs/218 setting off
- [x] Reset: force-push failure is not success; agent can edit files afterwards
- [x] SHI-263: a dispatch whose setup throws settles `errored` and is retried to
      `delivery-failed` without an orchestrator restart

## Docs

- [x] `shipit-docs/sessions.md` — `--self`, re-arming, the reset command
- [x] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant
