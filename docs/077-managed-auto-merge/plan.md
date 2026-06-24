---
issue: https://linear.app/shipit-ai/issue/SHI-117
description: ShipIt-managed auto-merge fallback (merges via REST when GitHub native auto-merge is unavailable), and the fix that keeps a CI-green managed merge silent until the PR is observed merged.
---

# Managed Auto-Merge

## Problem

GitHub's native auto-merge requires branch protection rules on the target branch. On private repositories, branch protection (both classic rules and rulesets) requires a GitHub Team plan ($4/user/month). Users on the Free/Pro plan who toggle auto-merge get an error and are left stuck.

## Solution

When GitHub's `enablePullRequestAutoMerge` GraphQL mutation fails, ShipIt falls back to **managed auto-merge** — it uses the existing 3-second PR status polling loop to detect when CI passes, then merges the PR directly via the REST API.

The fallback is transparent: the user toggles auto-merge, it activates, and the PR merges when CI is green — regardless of whether GitHub or ShipIt is doing the merging.

### How it works

1. User toggles auto-merge on.
2. ShipIt calls GitHub's `enablePullRequestAutoMerge` mutation.
3. If the mutation fails (missing branch protection or auto-merge not enabled in repo settings):
   - Instead of showing an error, ShipIt marks the auto-merge state as `managed: true`.
   - The toggle stays on — from the user's perspective, auto-merge is active.
4. The `PrStatusPoller` (which already polls every 3s) checks managed-merge sessions:
   - When `checks.state === "success"` and `mergeable === true`, calls `mergePullRequest()` REST API.
   - On success: marks the state `completed` (internal) and **keeps `enabled` true** until the poller observes the merged PR; the `completed` guard short-circuits any further merge attempt in the meantime.
   - On failure (conflicts, API error): surfaces error, stays enabled for retry.
5. An info icon appears next to the toggle with a tooltip explaining the fallback and linking to GitHub branch protection settings.

### UI indicator

When managed auto-merge is active, a small info icon (`InfoIcon` from Phosphor) appears next to the auto-merge toggle. Hovering shows a tooltip.

The tooltip surfaces **the real GitHub error** (`reason`) that blocked native auto-merge, rather than a fixed guess. `enableAutoMerge` maps GitHub's cryptic GraphQL errors to actionable text before returning them:

- *"Allow auto-merge" off in repo settings* (most common — fires even when branch protection / rulesets are already configured) → "**Allow auto-merge** is turned off for this repository. Enable it in Settings → General → Pull Requests."
- *Nothing gating the PR* (GitHub returns "Pull request is in clean status") → "No branch protection rule requires a status check or review on the base branch… Add a required check to the rule (or ruleset)."
- *Any other error* → passed through verbatim.

When `reason` is present the tooltip reads:

> GitHub couldn't enable native auto-merge:
> "{reason}"
> ShipIt will merge this PR itself when CI passes.
> [Configure in GitHub settings](link)

The settings link now points at the repo's **General** settings page (where "Allow auto-merge" lives and which links out to branch protection), not `/settings/branches`. When `reason` is absent (older state) the tooltip falls back to the original generic "requires branch protection rules" line.

`reason` is threaded through every broadcast channel so it survives a reload: the toggle HTTP response, the SSE `pr_status` summary (`attachAutomationState`), and the WS `pr_lifecycle_update` card. It is cleared when the user disables auto-merge.

Errors from the managed merge (e.g., "PR has merge conflicts") show as a warning line below the status, without the GitHub settings link (since the issue isn't about settings).

## Key files

| File | Role |
|------|------|
| `src/server/shared/types/github-types.ts` | `managed?`, `settingsUrl?`, `reason?` on `AutoMergeState`, `PrStatusSummary.autoMerge`, and `WsPrLifecycleUpdate.autoMerge` |
| `src/server/orchestrator/github-auth-prs.ts` | `enableAutoMerge()` maps GitHub's GraphQL errors to actionable `reason` text |
| `src/server/orchestrator/services/github.ts` | `toggleAutoMerge()` falls back to managed mode on GitHub API failure, threading `result.message` through as `reason` |
| `src/server/orchestrator/auto-merge-manager.ts` | `AutoMergeManager.setManaged(…, reason?)` stores `reason`; cleared on disable |
| `src/server/orchestrator/pr-status-poller.ts` | `handleManagedAutoMerge()` merges via REST when CI passes; `setAutoMergeManaged()` setter forwards `reason`; `attachAutomationState()` projects it onto the SSE summary |
| `src/server/orchestrator/services/pr-lifecycle.ts` | ready/open card emits include `reason` |
| `src/client/components/PrStatusControls.tsx` | `ManagedMergeInfo` tooltip renders the real `reason` |
| `src/client/stores/pr-store.ts` | `managed`, `settingsUrl`, `reason` on `PrCardState.autoMerge`; toggle response handler stores `reason` |

## Edge cases

- **PR has merge conflicts**: Error shown, stays enabled, retries when conflicts resolve.
- **REST merge call fails**: Error surfaced, stays enabled, retries next poll cycle (3s).
- **CI re-runs**: Merge only triggers on `success`. If CI goes back to `pending`, no merge.
- **User disables auto-merge**: Clears `enabled` and `managed`, skips GitHub `disableAutoMerge` API call (nothing to disable).
- **Race with poller merge detection / spurious "needs attention" chime**: After REST merge succeeds the PR is *merging* but the poller still has the PR as open+green in `lastKnown`. Flipping `enabled=false` here used to make the manager's `onChange` re-broadcast that stale summary as open+green+auto-merge-**disabled**, which the attention logic (`computeAttentionReason`) reads as "Waiting for your input" → a spurious notification/sound fires a beat before the merged state lands. Fix: on success we mark `completed` and keep `enabled` true, so auto-merge keeps *owning* the move and the client stays silent until `prState` flips to `merged`. The `completed` guard prevents a second merge attempt (GitHub would reject the already-merged PR and set a sticky error); the state is released by `untrackSession` at the terminal state, and `setEnabled` clears `completed` so a re-enable can merge again. See `auto-merge-manager.test.ts` ("keeps auto-merge owning the session after a successful merge and does not re-merge").
