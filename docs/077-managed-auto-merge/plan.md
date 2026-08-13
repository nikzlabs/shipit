---
issue: planning#119
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
| `src/server/orchestrator/pr-status-poller.ts` | `handleManagedAutoMerge()` merges via REST when CI passes; `setAutoMergeManaged()` setter forwards `reason`; `attachAutomationState()` projects it onto the SSE summary; `verifyMissingPr`'s terminal branch drops the arming |
| `src/server/orchestrator/services/pr-lifecycle.ts` | ready/open card emits include `reason` |
| `src/client/components/PrStatusControls.tsx` | `ManagedMergeInfo` tooltip renders the real `reason` |
| `src/client/stores/pr-store.ts` | `managed`, `settingsUrl`, `reason` on `PrCardState.autoMerge`; toggle response handler stores `reason`; `applyPrStatusUpdates` retires `autoMergeBySession` on a terminal `prState` |
| `src/client/stores/pr-store.ts` (selectors) | `selectActiveAutoMerge` / `useActiveAutoMerge` — the arming, but only while the session's PR is non-terminal |
| `src/client/components/PrActionsMenu.tsx` | reads `useActiveAutoMerge`; hides the toggle on a merged/closed card |
| `src/client/components/SessionSidebar/SessionStatusIndicators.tsx` | `AutoMergeBadge` reads `useActiveAutoMerge` |
| `src/client/components/pr-detail/PrStatusSection.tsx` | reads `useActiveAutoMerge`; auto-merge lines gated on the open phase |

## Edge cases

- **PR has merge conflicts**: Error shown, stays enabled, retries when conflicts resolve.
- **REST merge call fails**: Error surfaced, stays enabled, retries next poll cycle (3s).
- **CI re-runs**: Merge only triggers on `success`. If CI goes back to `pending`, no merge.
- **User disables auto-merge**: Clears `enabled` and `managed`, skips GitHub `disableAutoMerge` API call (nothing to disable).
- **PR reaches a terminal state (merged or closed-without-merge)**: the whole per-session auto-merge entry is **dropped** — `AutoMergeManager.delete()` from the poller's terminal branch in `verifyMissingPr`, alongside the auto-fix / auto-resolve / arbiter releases. See "Auto-merge is armed per PR, not per session" below.
- **Race with poller merge detection / spurious "needs attention" chime**: After REST merge succeeds the PR is *merging* but the poller still has the PR as open+green in `lastKnown`. Flipping `enabled=false` here used to make the manager's `onChange` re-broadcast that stale summary as open+green+auto-merge-**disabled**, which the attention logic (`computeAttentionReason`) reads as "Waiting for your input" → a spurious notification/sound fires a beat before the merged state lands. Fix: on success we mark `completed` and keep `enabled` true, so auto-merge keeps *owning* the move and the client stays silent until `prState` flips to `merged`. The `completed` guard prevents a second merge attempt (GitHub would reject the already-merged PR and set a sticky error); the state is released when the poller observes the terminal PR (below), and `setEnabled` clears `completed` so a re-enable can merge again. See `auto-merge-manager.test.ts` ("keeps auto-merge owning the session after a successful merge and does not re-merge").

## Auto-merge is armed per PR, not per session

`AutoMergeState` is keyed by **session**, but its lifetime is that of **one pull request**. When the poller observes a session's PR reach a terminal state (merged, or closed without merging), `verifyMissingPr`'s terminal branch calls `AutoMergeManager.delete(sessionId)` — the same place `autoFix` / `autoConflictResolveManager` / `remediationArbiter` are released.

The state used to be left behind, on the assumption (stated in this doc and in `auto-merge-manager.ts`) that `untrackSession` would release it at the terminal state. **Nothing in production calls `untrackSession`** — it has only ever been reached from tests — so the arming survived the merge indefinitely, and was wrong in both directions at once:

- **It re-armed the next PR silently.** `activatePendingAutoMergeForPr` (the docs/175 "armed before a PR exists" path, called from both `POST /pr/quick` and the agent's `gh pr create`) reads a lingering `enabled: true` as a deliberate pre-arm and enables auto-merge on the session's *next* PR. That is precisely the remembered-toggle footgun docs/175 refuses ("it would silently ship a PR the user actually meant to review").
- **…and then the arming didn't work.** `completed: true`, set when the managed REST merge succeeded and deliberately *not* cleared at the merge, rode along with it. `activatePendingAutoMergeForPr`'s failure branch calls only `setAutoMergeManaged` — never `setEnabled`, the one setter that clears `completed` — so on a managed-fallback repo `handleManaged` short-circuited on the stale `completed` forever: the toggle read ON and nothing ever merged.

Dropping the state at the terminal transition fixes both. A re-armed session (docs/202 / docs/216) therefore starts from OFF, and arming auto-merge for the next task is a fresh, conscious toggle. Deliberately **not** cleared in `PrStatusPoller.reArm`: by then the terminal release has already run, and the user may have re-armed auto-merge for the *next* task in between (the pre-PR toggle / quick-capture checkbox) — clearing there would wipe a live arming.

**The client mirrors the same rule.** `AutoMergeManager.delete()` fires no `onChange`, and the terminal `pr_status` summary carries no `autoMerge` field — which everywhere else in `applyPrStatusUpdates` means "unchanged" — so `pr-store` retires `autoMergeBySession[sessionId]` (and the card's `autoMerge`) off the terminal `prState` instead. Without that, `PrActionsMenu` — which reads `autoMergeBySession[id] ?? card.autoMerge`, and shows the toggle exactly in the non-open phases — would keep the merged card's toggle ON for a PR that no longer exists. Deleting rather than broadcasting `enabled: false` also keeps the docs/077 chime fix intact: no extra broadcast of the stale open+green summary races the merged state.

Tests: `pr-status-poller.test.ts` ("clears auto-merge arming when the PR goes terminal", merged + closed), `pr-store.test.ts` ("clears auto-merge arming when the PR goes merged/closed").

### …and the UI derives it, rather than remembering the transition

Both clears above are **event-driven**: they fire when the terminal transition is *observed*. That left the whole rule resting on one SSE `pr_status` update reaching one browser tab — and when it didn't, the arming was stranded ON forever on a merged PR (reported against v0.3.2: the overflow toggle and the detail panel's "Will merge when CI passes." line both kept reading armed). Nothing self-heals afterwards, because every later broadcast for that session is *also* terminal and terminal summaries carry no `autoMerge` field, which this reducer reads as "unchanged".

So the rule is now enforced at **read** time as well, on both sides:

- **Server** — `attachAutomationState` never attaches `autoMerge` onto a summary whose `prState` is `merged`/`closed`. Same shape as the auto-fix guard directly above it in that function: the manager's state is bookkeeping, not a display flag, and a terminal PR has nothing to auto-merge. A state that outlives its PR can no longer reach any client.
- **Client** — `selectActiveAutoMerge` / `useActiveAutoMerge` (`pr-store.ts`) return the arming only while the session's current PR is non-terminal, reading BOTH the card phase and `statusBySession.prState` (they converge on different transports; either saying "terminal" is enough). Every surface that renders "auto-merge is on" goes through it: `AutoMergeBadge` (sidebar), `PrActionsMenu`, `PrStatusSection` (detail panel).

Two consequences worth stating:

- `PrActionsMenu` no longer offers the auto-merge toggle on a **merged/closed** card — only pre-PR (no card, `creating`, `ready`), where the arming has a next PR to act on. Rendering a toggle whose ON state the selector deliberately suppresses would snap back on click. A session that merged and then picks up new work returns to `ready` (docs/202), where the toggle is available again.
- `computeAttentionReason` short-circuits on a terminal `prState` *above* the auto-merge branch, so a merged PR carrying a stale `autoMerge.error` no longer flags "Auto-merge needs repo configuration". It previously relied on the sidebar grouping's `resolved` flag, which is computed on a different path.

Tests: `pr-status-poller.test.ts` ("never attaches auto-merge state onto a merged/closed summary"), `pr-store.test.ts` (`selectActiveAutoMerge`), `SessionSidebar.test.tsx`, `PrActionsMenu.test.tsx`, `PrDetailPanel.test.tsx`, `useAttentionInfo.test.ts`.
