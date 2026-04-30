# 113 — PR Mergeable State Checklist

## Phase 1: Wire up the tri-state
- [ ] Widen `PrStatusSummary.mergeable` in `src/server/shared/types/github-types.ts` to `"mergeable" | "conflicting" | "unknown"`
- [ ] Update mapping in `src/server/orchestrator/pr-status-poller.ts` (line 221) to map all three enum values
- [ ] Add unit coverage for the mapping in `pr-status-poller.test.ts`
- [ ] Verify `npm run typecheck` passes — no other consumer of `mergeable` should break (it's currently unused on the read side)

## Phase 2: Gate the merge button
- [ ] In `PrLifecycleCard.tsx` `OpenPhase`, read `mergeable` from `statusBySession`
- [ ] Update `canMerge`: `(isCiPassed || isCiNone) && mergeable !== "conflicting"`
- [ ] Confirm `"unknown"` does NOT gate the button (avoid post-push flicker)

## Phase 3: Inline conflict indicator
- [ ] Add `MergeConflictIndicator` component in `PrLifecycleCard.tsx`
  - Phosphor `WarningCircle` (size XS) + "Merge conflicts" label
  - `text-amber-400` for warning state
- [ ] Render next to `CiIndicator` when `mergeable === "conflicting"` and `rebaseStatus === "idle"`

## Phase 4: Resolve conflicts button
- [ ] Add `ResolveConflictsButton` component
  - Reads `activeRunnerSessions` from `useSessionStore`
  - Disabled with tooltip when agent is running
  - On click (when idle): `startRebase(sessionId, pr.baseBranch)` — no confirm, no chat prefill
- [ ] Render adjacent to `MergeConflictIndicator`

## Phase 5: Coordinate with RebaseBanner
- [ ] Hide conflict indicator + Resolve button when `rebaseStatus !== "idle"`
- [ ] (Follow-up) Update `RebaseBanner` to accept `baseBranch` from PR data instead of hardcoded `"main"`

## Phase 6: Tests
- [ ] Server: `parsePrNode` mappings (3 cases)
- [ ] Client: merge button hidden when conflicting
- [ ] Client: merge button visible when unknown (no flicker)
- [ ] Client: conflict indicator visibility (idle vs rebasing)
- [ ] Client: Resolve button disabled while agent running
- [ ] Client: Resolve button click calls `startRebase` with correct args, no toast/prefill
- [ ] Integration: `pr-mergeable.test.ts` — poller emits `conflicting` → store updates → card renders conflict UI → click triggers rebase route

## Phase 7: Quality gate
- [ ] `npm run lint` — clean
- [ ] `npm run typecheck` — clean
- [ ] `npm run test:dev` — all affected tests pass
- [ ] Update `plan.md` status to `done` and check off all items above
