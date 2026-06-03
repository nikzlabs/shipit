# SHI-64 — PR approval in merge eligibility

## Types
- [x] Add `PrReviewDecision` type to `github-types.ts`
- [x] Add `reviewDecision: PrReviewDecision` to `PrStatusSummary`
- [x] Add `reviewDecision` to `WsPrStatus.pr`

## Server
- [x] `PR_LIGHT_FIELDS`: select `reviewDecision`
- [x] `GraphQLPrNode`: add `reviewDecision: string | null`
- [x] `parsePrNode`: map enum → `PrReviewDecision` (`null → "none"`) via `mapReviewDecision`
- [x] `prStatusEqual`: include `reviewDecision` so changes rebroadcast
- [x] `AutoMergeManager.handleManaged`: skip merge when review-blocked
- [x] Merge route: pre-merge review guard
- [x] Backfill `reviewDecision: "none"` on synthetic poller/REST placeholder summaries

## Client
- [x] `PrLifecycleCard`: read `reviewDecision`, add `isReviewBlocked` to `canMerge`
- [x] `PrLifecycleCard`: add `ReviewIndicator` badge in the action row
- [x] `PrStatusSection`: same eligibility + `ReviewSummary` status row

## Tests
- [x] `pr-status-poller.test.ts`: `parsePrNode` reviewDecision mapping + `prStatusEqual`
- [x] `auto-merge-manager.test.ts`: review-blocked skip / approved merge
- [x] `PrLifecycleCard` component test: button gating + indicator labels
- [x] Fixture backfill across affected test files

## Quality
- [x] `npm run lint:dev` clean
- [x] `npm run typecheck` clean
- [x] Affected test files green (200 passed)

## Possible follow-ups (not this issue)
- [ ] Approval counts on unprotected repos via `latestOpinionatedReviews`
- [ ] Merge-route integration test exercising the review guard end-to-end
