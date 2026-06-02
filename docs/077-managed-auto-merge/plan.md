
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
   - On success: disables auto-merge, poller detects merge next cycle.
   - On failure (conflicts, API error): surfaces error, stays enabled for retry.
5. An info icon appears next to the toggle with a tooltip explaining the fallback and linking to GitHub branch protection settings.

### UI indicator

When managed auto-merge is active, a small info icon (`InfoIcon` from Phosphor) appears next to the auto-merge toggle. Hovering shows a tooltip:

> GitHub auto-merge requires branch protection rules. ShipIt will merge this PR when CI passes.
> [Configure in GitHub settings](link)

Errors from the managed merge (e.g., "PR has merge conflicts") show as a warning line below the status, without the GitHub settings link (since the issue isn't about settings).

## Key files

| File | Role |
|------|------|
| `src/server/shared/types/github-types.ts` | `managed?: boolean` and `settingsUrl?: string` on `AutoMergeState` and `PrStatusSummary.autoMerge` |
| `src/server/orchestrator/services/github.ts` | `toggleAutoMerge()` falls back to managed mode on GitHub API failure |
| `src/server/orchestrator/pr-status-poller.ts` | `handleManagedAutoMerge()` merges via REST when CI passes; `setAutoMergeManaged()` setter |
| `src/client/components/PrLifecycleCard.tsx` | `ManagedMergeInfo` tooltip component, updated error display |
| `src/client/stores/pr-store.ts` | `managed` and `settingsUrl` on `PrCardState.autoMerge` |

## Edge cases

- **PR has merge conflicts**: Error shown, stays enabled, retries when conflicts resolve.
- **REST merge call fails**: Error surfaced, stays enabled, retries next poll cycle (3s).
- **CI re-runs**: Merge only triggers on `success`. If CI goes back to `pending`, no merge.
- **User disables auto-merge**: Clears `enabled` and `managed`, skips GitHub `disableAutoMerge` API call (nothing to disable).
- **Race with poller merge detection**: After REST merge succeeds, `enabled` is set to false immediately. Next poll cycle sees PR gone from OPEN results and triggers normal merged flow.
