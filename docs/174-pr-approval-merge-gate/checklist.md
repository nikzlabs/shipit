# SHI-64 — PR approval in merge eligibility

## Types
- [ ] Add `PrReviewDecision` type to `github-types.ts`
- [ ] Add `reviewDecision: PrReviewDecision` to `PrStatusSummary`
- [ ] Add `reviewDecision` to `WsPrStatus.pr` (if still emitted)

## Server
- [ ] `PR_LIGHT_FIELDS`: select `reviewDecision`
- [ ] `GraphQLPrNode`: add `reviewDecision: string | null`
- [ ] `parsePrNode`: map enum → `PrReviewDecision` (`null → "none"`)
- [ ] `prStatusEqual`: include `reviewDecision` so changes rebroadcast
- [ ] `AutoMergeManager.handleManaged`: skip merge when review-blocked
- [ ] Merge route: pre-merge review guard

## Client
- [ ] `PrLifecycleCard`: read `reviewDecision`, add `isReviewBlocked` to `canMerge`
- [ ] `PrLifecycleCard`: add `ReviewIndicator` badge in the action row
- [ ] `PrStatusSection`: same eligibility + review status row

## Tests
- [ ] `pr-status-parser.test.ts`: mapping + `prStatusEqual`
- [ ] `auto-merge-manager.test.ts`: review-blocked skip / approved merge
- [ ] `PrLifecycleCard` component test: button gating + indicator
- [ ] Merge-route integration test: review-blocked rejection

## Quality
- [ ] `npm run lint:dev` clean
- [ ] `npm run typecheck` clean
- [ ] Update this checklist + `plan.md` if the design shifts during build

## Possible follow-ups (not this issue)
- [ ] Approval counts on unprotected repos via `latestOpinionatedReviews`
