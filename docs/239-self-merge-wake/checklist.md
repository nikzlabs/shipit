# Self-merge wake — checklist

The existing merge-watch pointed back at the same session. No new column, no parallel
manager, no chain object, no card lifecycle. If an item here looks like a subsystem,
it has been cut — see the plan's "Resolved decisions".

## Prerequisite

- [x] **SHI-262** — the finished turn's commit completes before a queued turn starts ✅ merged

## Watch

- [ ] Optional `{ kind: "self", watchId, prNumber }` on `SessionMergeWatch`; `parentSessionId === sessionId`
- [ ] Self-arm refused when the row holds a genuine parent→child watch
- [ ] Arming always replaces an existing self-watch, including one delivering

## Arm / cancel

- [ ] `shipit session notify-on-merge --self` — no payload
- [ ] Live open-PR lookup (`findPullRequest`); store the PR number
- [ ] One refusal: no open PR for the current branch
- [ ] Cancel carries `watchId`; clears the watch and acknowledges
- [ ] Container-accessible route golden test

## Delivery

- [ ] Fire from `onMergeDetectedCb` after `markMergedAndPruneExcess` resolves
- [ ] Read PR facts from the persisted snapshot — no callback signature change
- [ ] Merged PR number ≠ anchor → append a note, clear the watch, no turn
- [ ] Closed-without-merge from `onPrTerminalState` → note, clear, no turn
- [ ] `watchId` checked on asynchronous settlement
- [ ] `reconcilePending` branches on `kind`
- [ ] `wakeSessionWithTurn` restores the checkout when missing

## Reset command

- [ ] `shipit branch reset-to-base` — explicit mode over the existing reset core
- [ ] Ignores `getAutoResetMergedBranch()`
- [ ] Idempotent: already-at-base → exit 0 "proceed", checked **before** the `mergedHeadSha` gate
- [ ] Force-push failure reported as failure
- [ ] `handWorkspaceBackToWorker` in a `finally`
- [ ] Exit 0 for reset/already-at-base; nonzero with a reason otherwise
- [ ] Refusal copy says why and forbids a hand-rolled reset

## Prompt + card

- [ ] `orchestrator/prompts/self-merge-wake.md`: merged; run reset first; stop if it refuses; continue the earlier request unless redirected; re-arm if work remains
- [ ] Arm card via `emitChatCard`, with Cancel
- [ ] Notes (not cards) for closed / mismatch / delivery failure

## Tests

- [ ] Arm refused with no open PR; live lookup after `gh pr create` anchors to the new PR
- [ ] Arm card persists and round-trips; stale-`watchId` Cancel doesn't cancel a newer watch
- [ ] Fires after merge bookkeeping
- [ ] Anchor mismatch → note, no turn
- [ ] Closed-without-merge → note, no turn
- [ ] Old settlement doesn't mark a newly-armed watch delivered
- [ ] Wake against a missing checkout restores it
- [ ] Reset: refuses on dirty tree / moved HEAD / detached / sequencer
- [ ] Reset: second invocation → already-at-base; runs with the docs/218 setting off
- [ ] Reset: force-push failure is not success; agent can edit files afterwards

## Docs

- [ ] `shipit-docs/sessions.md` — `--self`, re-arming, the reset command
- [ ] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant
