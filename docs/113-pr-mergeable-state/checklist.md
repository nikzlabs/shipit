# 113 — PR Mergeable State Checklist

## Phase 1: Wire up the tri-state
- [x] Widen `PrStatusSummary.mergeable` in `src/server/shared/types/github-types.ts` to `"mergeable" | "conflicting" | "unknown"`
- [x] Add exported `PrMergeableState` type alias for downstream consumers
- [x] Apply same widening to `WsPrStatus.pr.mergeable`
- [x] Update mapping in `src/server/orchestrator/pr-status-poller.ts:221` to map all three enum values
- [x] Add unit coverage for the mapping in `pr-status-poller.test.ts` (mergeable / conflicting / unknown / defensive default)
- [x] Update existing consumers that read `mergeable`:
  - `pr-status-poller.ts` `handleManagedAutoMerge` — only short-circuit on `"conflicting"`, defer on `"unknown"`
  - `pr-status-poller.ts` catchUpProbe — fill in `"unknown"` for merged/closed PRs (mergeability is moot)
  - `services/github.ts:getPrStatus` — fill in `"unknown"` (one-shot fetch doesn't query the field)
  - `SessionSidebar.tsx` attention rule — only flag attention on `"conflicting"`
- [x] Update fixtures in `pr-store.test.ts` and `PrLifecycleCard.test.tsx`

## Phase 2: Gate the merge button
- [x] In `PrLifecycleCard.tsx` `OpenPhase`, read `mergeable` from `statusBySession`
- [x] Update `canMerge`: `(isCiPassed || isCiNone) && mergeable !== "conflicting"`
- [x] Confirm `"unknown"` does NOT gate the button (avoid post-push flicker) — covered by unit test

## Phase 3: Inline conflict indicator
- [x] Add `MergeConflictIndicator` component in `PrLifecycleCard.tsx`
  - Phosphor `WarningIcon` (size SM) + "Merge conflicts" label
  - `text-(--color-warning)` for warning state
  - Tooltip explains the situation and points at the Resolve action
- [x] Render next to `CiIndicator` when `mergeable === "conflicting"` and `rebaseStatus === "idle"`

## Phase 4: Resolve conflicts button
- [x] Add `ResolveConflictsButton` component
  - Reads `activeRunnerSessions` from `useSessionStore`
  - Disabled with tooltip when agent is running
  - Local `starting` flag to prevent double-clicks while the request flies
  - On click (when idle): `startRebase(sessionId, pr.baseBranch)` — no confirm, no chat prefill
- [x] Render adjacent to `MergeConflictIndicator` (gated by same `showConflictUi` flag)

## Phase 5: Coordinate with RebaseBanner
- [x] Hide conflict indicator + Resolve button when `rebaseStatus !== "idle"` (`showConflictUi` derived flag)
- [ ] (Follow-up — not blocking) Update `RebaseBanner` to accept `baseBranch` from PR data instead of hardcoded `"main"`. Tracked separately; not required for this feature to ship correctly because the inline button already passes `pr.baseBranch`.

## Phase 6: Tests
- [x] Server: `parsePrNode` mappings (4 cases including defensive default)
- [x] Client: merge button hidden when conflicting
- [x] Client: merge button visible when unknown (no flicker)
- [x] Client: conflict indicator and Resolve button render together when conflicting
- [x] Client: conflict UI hidden during rebase (`rebaseStatus !== "idle"`)
- [x] Client: Resolve button disabled while agent running
- [x] Client: Resolve button click calls `startRebase(sessionId, pr.baseBranch)` directly — no toast/prefill
- [x] Client: defensive — Resolve does not fire `startRebase` even if click handler is invoked while disabled
- [x] Integration: `pr-mergeable.test.ts` — poller broadcasts the new tri-state on the SSE wire (mergeable / conflicting / unknown)

## Phase 7: Quality gate
- [x] `npm run lint` — clean
- [x] `npm run typecheck` — clean
- [x] `npm run test:dev` — affected tests pass (199 passed)
- [x] Update `plan.md` status to `done`

## Notes / out of scope
- Manual conflict resolution UI: covered by the existing 094 agent-driven loop.
- GitHub web-editor link: deliberately not added (CLAUDE.md §1–2).
- Auto-firing the rebase when the poller observes `CONFLICTING`: rejected — preserves user control of agent's time.
- `RebaseBanner` baseBranch hardcoding: noted as a small follow-up; not blocking.
