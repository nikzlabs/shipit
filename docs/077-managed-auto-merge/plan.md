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
| `src/server/orchestrator/services/github.ts` | `toggleAutoMerge()` falls back to managed mode on GitHub API failure, threading `result.message` through as `reason`; `prWentTerminalDuringCall()` guards both arming writers |
| `src/server/orchestrator/auto-merge-manager.ts` | `AutoMergeManager.setManaged(…, reason?)` stores `reason`; cleared on disable |
| `src/server/orchestrator/pr-status-poller.ts` | `handleManagedAutoMerge()` merges via REST when CI passes; `setAutoMergeManaged()` setter forwards `reason`; `attachAutomationState()` projects it onto the SSE summary; `verifyMissingPr`'s terminal branch drops the arming |
| `src/server/orchestrator/services/pr-lifecycle.ts` | ready/open card emits include `reason` |
| `src/client/components/PrStatusControls.tsx` | `ManagedMergeInfo` tooltip renders the real `reason` |
| `src/client/stores/pr-store.ts` | `managed`, `settingsUrl`, `reason` on `PrCardState.autoMerge`; toggle response handler stores `reason`; `applyPrStatusUpdates` retires `autoMergeBySession` on a terminal `prState` |
| `src/client/stores/pr-store.ts` (selectors) | `armedForPrNumber` provenance; `selectActiveAutoMerge` / `useActiveAutoMerge`; toggle write-back race guard |
| `src/client/components/PrActionsMenu.tsx` | reads `useActiveAutoMerge`; still offers the toggle on a merged/closed card, for the next PR |
| `src/client/components/SessionSidebar/SessionStatusIndicators.tsx` | `AutoMergeBadge` reads `useActiveAutoMerge` |
| `src/client/components/pr-detail/PrStatusSection.tsx` | reads `useActiveAutoMerge`; auto-merge lines gated on the open phase |
| `src/client/components/PrLifecycleCard/` (`phases/OpenPhase.tsx`, `PrStatusActions.tsx`) | the open card's toggle/merge row reads `useActiveAutoMerge` |

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

### …and the arming is retired by provenance, not by a remembered transition

Both clears above are **event-driven**: they fire when the terminal transition is *observed*. That left the whole rule resting on one SSE `pr_status` update reaching one browser tab — and when it didn't, the arming was stranded ON forever on a merged PR (reported against v0.3.2: the overflow toggle and the detail panel's "Will merge when CI passes." line both kept reading armed). Nothing self-heals afterwards, because every later broadcast for that session is *also* terminal and terminal summaries carry no `autoMerge` field, which the reducer reads as "unchanged".

**The write-back races are how the state survived the clear.** Every arming write lands *after* an awaited GitHub round-trip, and a green PR can merge inside that very window:

- `toggleAutoMerge()` and `activatePendingAutoMergeForPr()` (`services/github.ts`) called `setAutoMergeEnabled` unconditionally after `enableAutoMerge` returned — **re-creating** the state the poller had just deleted. That is worse than a stale toggle: `activatePendingAutoMergeForPr` reads a lingering `enabled` as a deliberate pre-arm, so the session's *next* PR would merge without the user asking — the exact footgun this doc says was fixed. Both now bail via `prWentTerminalDuringCall()`, which compares **PR numbers**: the last-known summary is legitimately a terminal *older* PR right after `gh pr create` on a chained session (`self-merge-watch.test.ts`), and a bare "is it terminal?" check would refuse to arm the new one. The enable path returns `{ enabled: false }` there, so the client converges on the truth.
- The client had the same shape: `pr-store.toggleAutoMerge`'s response handler wrote the arming back after the terminal `pr_status` had already retired it — and that write is the **last word**, since no later update carries an `autoMerge` for a merged PR. It now drops the entry instead, but only when the toggle was made *for the PR that has since gone terminal* (see provenance below).

**And the surfaces derive it rather than remembering.** `selectActiveAutoMerge` / `useActiveAutoMerge` (`pr-store.ts`) return the arming only while it can still act; every surface that renders "auto-merge is on" reads it — `AutoMergeBadge` (sidebar), `PrActionsMenu`, `OpenPhase` / `PrMergeActions` (the open card), `PrStatusSection` (detail panel). The server does the same on its side: `attachAutomationState` never attaches `autoMerge` onto a terminal summary — the same belt-and-suspenders the auto-fix block above it applies.

**What decides is provenance, not phase.** An arming carries `armedForPrNumber` — client-side only, stamped when it arrives on an open PR's summary or when the user toggles it while a PR is live. An arming stamped for a PR that is no longer the live one is dead; an **unstamped** one is a pre-arm and survives. Phase alone was the obvious rule and it is wrong twice over:

- It would hide a deliberate pre-arm made from a merged card — a real flow, and the *only* one available to a reused session, because with auto-create-PR on there is no `ready` phase to arm from (`pr-lifecycle.ts` goes creating → open).
- It would miss the docs/202 re-arm, where the ready card carries the old `autoMerge` forward and `reArm` has already deleted the poller status, so **neither** half says "terminal" any more. The stamp still retires it.

`computeAttentionReason` gets the same floor: it short-circuits on a terminal PR — reading **both** `status.prState` and `card.phase`, since the optimistic merge path flips one before the other — above the auto-merge branch, so a merged PR carrying a stale `autoMerge.error` no longer flags "Auto-merge needs repo configuration".

Tests: `github-auto-merge-arming.test.ts` (both server races, plus the chained-session case the number comparison protects), `pr-status-poller.test.ts` ("never attaches auto-merge state onto a merged/closed summary"), `pr-store.test.ts` (`selectActiveAutoMerge` + the toggle write-back races), `SessionSidebar.test.tsx`, `PrActionsMenu.test.tsx`, `PrDetailPanel.test.tsx`, `useAttentionInfo.test.ts`.
