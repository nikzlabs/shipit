---
description: Gate PR merge eligibility on GitHub's review-approval status and surface that status inline on the PR card.
---

# PR approval status in merge eligibility (TRACKER-64)

## Problem

ShipIt decides whether a PR can be merged purely from CI state and
GitHub-reported mergeability. The review/approval dimension is missing entirely:

```ts
// PrLifecycleCard.tsx (and PrStatusSection.tsx), today
const canMerge = (isCiPassed || isCiNone) && !isConflicting;
```

Consequences:

- On a repo whose base branch **requires reviews** (branch protection), ShipIt
  shows an enabled **Merge** button even when the PR has no approval — or has an
  outstanding *changes requested*. Clicking it fails: GitHub's REST merge
  rejects with a 405, surfaced as a confusing toast. The button promises
  something GitHub won't honor.
- The ShipIt-managed auto-merge loop (`AutoMergeManager.handleManaged`) fires a
  REST merge as soon as CI is green, ignoring approval. On a protected repo that
  call is rejected every poll tick — a quiet retry storm against the GitHub API
  until someone approves.
- The review/approval state is never shown on the card, so the user can't see
  *why* a merge is or isn't possible without leaving ShipIt for the GitHub tab
  — a direct violation of product principle §1/§2 (inline beats link-out).

## Goal

Fold PR approval status into the merge-eligibility decision **and** render it
inline on the PR lifecycle card and the PR detail panel, so the merge button's
enabled/disabled state matches what GitHub will actually allow, and the user can
read the review state without leaving ShipIt.

## The GitHub signal: `reviewDecision`

GitHub's GraphQL `PullRequest.reviewDecision` (`PullRequestReviewDecision` enum)
is exactly the right primitive:

| GraphQL value       | Meaning                                                        |
|---------------------|---------------------------------------------------------------|
| `APPROVED`          | Review requirement satisfied — approved.                      |
| `CHANGES_REQUESTED` | A reviewer requested changes — merge blocked.                |
| `REVIEW_REQUIRED`   | Base branch requires a review that hasn't been given yet.     |
| `null`              | The base branch has **no** review requirement.               |

Why this field and not a full review fetch:

1. **It mirrors GitHub's own enforcement exactly.** `reviewDecision` is non-null
   only when branch protection requires reviews — i.e. only when GitHub itself
   would block the merge. Gating on it means ShipIt's merge button enables
   precisely when GitHub's does. We never show a button GitHub would reject, and
   never hide one it would accept.
2. **It is a single scalar.** It drops into the existing bulk
   `pullRequests(first: N)` light query with zero pagination and negligible
   payload — critical because that query runs on the hot poll path for every
   open PR on the repo (`pr-status-parser.ts`, `PR_LIGHT_FIELDS`).
3. **It is backward-compatible for the common ShipIt case.** Most ShipIt users
   work solo on repos with no branch protection, where `reviewDecision` is
   `null`. We map `null → "none"` and treat it as *not blocking*, so the solo
   flow is unchanged — no merge button suddenly disabled because nobody
   reviewed a one-person repo.

### Deliberate scope cut

On a repo **without** required-review branch protection, a reviewer who clicks
"Request changes" does **not** move `reviewDecision` off `null`. So v1 will not
surface *changes requested* on unprotected repos. Doing so would require
fetching `latestOpinionatedReviews(first: N)` and counting verdicts, which adds
payload to the hot bulk poll and — more importantly — would let ShipIt *block* a
merge that GitHub itself permits (no protection ⇒ GitHub allows the merge). We
deliberately keep the gate aligned with GitHub's actual enforcement. Surfacing
informational approval counts on unprotected repos is a possible later
enhancement, noted in `checklist.md`, not part of this issue.

## New eligibility rule

```ts
const isReviewBlocked =
  reviewDecision === "review_required" || reviewDecision === "changes_requested";
const canMerge = (isCiPassed || isCiNone) && !isConflicting && !isReviewBlocked;
```

`"approved"` and `"none"` both allow merge (approved = requirement met; none = no
requirement). This rule is applied in **three** places that must stay in lockstep
(the existing CI/mergeable rule already lives in all three):

1. `PrLifecycleCard.tsx` `OpenPhase` — the inline card merge button.
2. `pr-detail/PrStatusSection.tsx` — the PR detail panel merge button.
3. `auto-merge-manager.ts` `handleManaged` — the ShipIt-managed merge loop.

## Type model

`PrReviewDecision` mirrors the GraphQL enum, lower-cased, with `null → "none"`:

```ts
// github-types.ts
export type PrReviewDecision =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";
```

Add a required `reviewDecision: PrReviewDecision` field to `PrStatusSummary`
(`github-types.ts:268`). Because the client store types `statusBySession` as
`Record<string, PrStatusSummary>` directly (`pr-store.ts:105`), the field flows
to the client for free — the card already reads `mergeable` the same way
(`statusBySession[sessionId]?.mergeable`), and `reviewDecision` rides the same
channel. No new client store field is required.

`WsPrStatus.pr` (`github-types.ts:111`) is the legacy single-PR WS shape; add
`reviewDecision` there too for completeness if it is still emitted, but the live
path is the SSE `PrStatusSummary[]` broadcast consumed by
`applyPrStatusUpdates`.

## Data flow (unchanged shape, one field added)

```
GitHub GraphQL  ──reviewDecision──▶  parsePrNode()
   PR_LIGHT_FIELDS                        │
                                          ▼
                            PrStatusSummary.reviewDecision
                                          │ SSE pr_status
                                          ▼
                    pr-store.applyPrStatusUpdates → statusBySession
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
                 PrLifecycleCard                   PrStatusSection
                 (canMerge + ReviewIndicator)      (canMerge + review row)
```

## UI

A small `ReviewIndicator` badge mirroring the existing `CiIndicator`
(`PrLifecycleCard.tsx:197`), placed in the same action/badge row next to the CI
indicator, and as a status row in `PrStatusSection`:

| `reviewDecision`    | Badge                                            |
|---------------------|--------------------------------------------------|
| `approved`          | `--color-success`, check icon, "Approved"        |
| `changes_requested` | `--color-error`, X icon, "Changes requested"     |
| `review_required`   | `--color-warning`, clock/eye icon, "Review required" |
| `none`              | render nothing (no review requirement)           |

Rendering nothing for `none` keeps the solo / no-protection card visually
identical to today. When the merge button is hidden because of a review block,
the badge is the explanation — the user reads "Review required" instead of
wondering where the button went, all without leaving ShipIt (§1/§2). Icons come
from `@phosphor-icons/react` with `ICON_SIZE.SM`, per the design language skill.

## Server-side merge guard (defense-in-depth)

The merge endpoint `POST /api/sessions/:id/pr/merge`
(`api-routes-github.ts:576`) already guards against a stale-tab merge while CI is
pending. Add a parallel review guard: if the poller's latest
`PrStatusSummary.reviewDecision` is `review_required` or `changes_requested`,
return `{ success: false, message: "Waiting for required review approval" }`
rather than attempting a merge GitHub will reject. This mirrors the existing
CI-not-started guard and is consistent with "the client disables the button, but
enforce on the server too."

## Auto-merge loop

In `AutoMergeManager.handleManaged` (`auto-merge-manager.ts:96`), after the CI
gate and before the REST merge, bail when `isReviewBlocked`. Unlike the conflict
case we do **not** set a sticky `error` — "awaiting approval" is a normal
transient waiting state, not a misconfiguration, so we simply return and let the
next poll re-evaluate once an approval lands (same shape as the
`mergeable === "unknown"` early-return already there). GitHub **native**
auto-merge already gates on approval internally, so only the managed loop needs
this change.

## Key files

| File | Change |
|------|--------|
| `src/server/shared/types/github-types.ts` | Add `PrReviewDecision` type; `reviewDecision` field on `PrStatusSummary` (+ `WsPrStatus.pr`). |
| `src/server/orchestrator/pr-status-parser.ts` | Add `reviewDecision` to `PR_LIGHT_FIELDS`; add to `GraphQLPrNode`; map in `parsePrNode`; compare in `prStatusEqual`. |
| `src/server/orchestrator/auto-merge-manager.ts` | Review gate in `handleManaged`. |
| `src/server/orchestrator/api-routes-github.ts` | Pre-merge review guard in the merge route. |
| `src/client/components/PrLifecycleCard.tsx` | Read `reviewDecision`; add `isReviewBlocked` to `canMerge`; new `ReviewIndicator`. |
| `src/client/components/pr-detail/PrStatusSection.tsx` | Same eligibility + review row. |

## Testing

- `pr-status-parser.test.ts`: `parsePrNode` maps each `reviewDecision` enum value
  (incl. `null → "none"`); `prStatusEqual` returns `false` when only
  `reviewDecision` differs (so a fresh approval broadcasts).
- `auto-merge-manager.test.ts`: managed loop does **not** call
  `mergePullRequest` when `reviewDecision` is `review_required` /
  `changes_requested` even with CI green; merges when `approved` or `none`.
- `PrLifecycleCard` component test: merge button hidden for
  `review_required` / `changes_requested`, shown for `approved` / `none`;
  `ReviewIndicator` renders the right label per state and nothing for `none`.
- Merge-route integration test: review-blocked POST returns
  `{ success: false }` without attempting the merge.

## Out of scope

- Approval counts / per-reviewer state on unprotected repos (see scope cut).
- Requesting reviewers or submitting approvals from ShipIt (write-back).
- Required-reviewer / CODEOWNERS introspection beyond `reviewDecision`.
