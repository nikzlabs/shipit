---
status: planned
---
# 113 — Surface PR Mergeable State Inline

## Summary

When a PR's base branch moves forward after the feature branch was pushed, GitHub flags the PR as `CONFLICTING` ("This branch has conflicts that must be resolved"). ShipIt currently does not detect this state — the PR card shows CI status only and offers an active "Squash and merge" button. Clicking it produces a 405 error from the GitHub API.

This feature plumbs GitHub's tri-state `mergeable` field through to the UI, surfaces a conflict indicator inline in the PR card, gates the merge button on it, and adds a one-click "Resolve conflicts" affordance that fires the existing rebase driver from feature 094 — without requiring the user to confirm in chat.

## Motivation

This case is not covered by feature 094 (merge conflicts via push rejection). 094 detects divergence at push time: if `git push` fails with non-fast-forward, it emits `git_push_rejected` and the user can click "Update branch" in the `RebaseBanner`. That covers the case where the local branch diverges from origin *before* the push.

The case in this feature is different: the push succeeded cleanly when the user opened the PR. Then `main` moved forward (e.g., another PR landed) and *now* the PR is unmergeable. There was no failed push, so the existing detector never fires. The signal lives only on GitHub, in the PR's `mergeable` field, which the poller already fetches but discards.

Today the data flow is:

1. `pr-status-poller.ts` fetches `mergeable` as `MERGEABLE | CONFLICTING | UNKNOWN` (line 92).
2. It collapses to a boolean at line 221: `mergeable: node.mergeable === "MERGEABLE"`. `CONFLICTING` and `UNKNOWN` both become `false`.
3. The boolean reaches the client in `PrStatusSummary` but is never read by `PrLifecycleCard`.
4. The merge button visibility is gated on CI state alone (`canMerge = isCiPassed || isCiNone`), so it shows even when the PR is unmergeable.
5. Clicking the button hits `POST /api/sessions/:id/pr/merge`, GitHub returns 405, the error surfaces as a toast — too late to be useful.

## Design

### Phase 1: Preserve mergeable as a tri-state on the wire

**Change `PrStatusSummary.mergeable` from `boolean` to `"mergeable" | "conflicting" | "unknown"`.**

`src/server/shared/types/github-types.ts`:

```typescript
export interface PrStatusSummary {
  // ... existing fields ...
  mergeable: "mergeable" | "conflicting" | "unknown";
  // ... existing fields ...
}
```

`src/server/orchestrator/pr-status-poller.ts:221`:

```typescript
mergeable:
  node.mergeable === "MERGEABLE" ? "mergeable" :
  node.mergeable === "CONFLICTING" ? "conflicting" :
  "unknown",
```

This change is purely additive on the client side — `mergeable` was previously unused there, so widening the type does not break any existing reader. Server-side, no current consumer reads `mergeable` either (search confirms it's only written by the poller and serialized by the WS layer). The discriminated union forces every future consumer to handle the `"unknown"` window explicitly, which is the right default.

### Phase 2: Plumb mergeable into the card render

`PrLifecycleCard.tsx` already reads `usePrStore((s) => s.statusBySession[sessionId])` for deployments at line 391 (per the survey). Read `mergeable` from the same selector inside `OpenPhase` rather than duplicating it onto `PrCardState`. Single source of truth, no extra plumbing in the store reducer.

```typescript
const mergeable = usePrStore((s) => s.statusBySession[sessionId]?.mergeable);
```

### Phase 3: Gate the merge button

Update line 407 in `PrLifecycleCard.tsx`:

```typescript
const canMerge = (isCiPassed || isCiNone) && mergeable !== "conflicting";
```

**Do not gate on `"unknown"`.** GitHub returns `UNKNOWN` for a brief window after each push while it computes mergeability. Treating it as un-mergeable would flicker the button off-on every time the user pushes. The cost of leaving the button visible during this ~1–3s window is bounded: if the user clicks during the gap, the merge attempt either succeeds (no actual conflict) or fails with the same 405 toast we already show.

### Phase 4: Inline conflict indicator

Render a `MergeConflictIndicator` next to the existing `CiIndicator` in the PR card header row (`PrLifecycleCard.tsx:428`):

```tsx
<CiIndicator checks={card.checks} />
{mergeable === "conflicting" && <MergeConflictIndicator />}
```

The indicator is a Phosphor `WarningCircle` icon (size XS) plus the text "Merge conflicts" in `text-amber-400` — matching the design language for warning state (gray-950 background, amber for "needs attention but not destructive"). It sits between `CiIndicator` and the merge button slot.

**Visibility rules:**
- Show when `mergeable === "conflicting"`.
- Hide when a rebase is in progress (`rebaseStatus !== "idle"` from `git-store`). The existing `RebaseBanner` takes over the surface during the rebase; the indicator reappears if the rebase aborts back to a conflict state.
- Don't render at all for `"mergeable"` or `"unknown"` (no positive "ready to merge" badge — the visible merge button is the affordance).

### Phase 5: "Resolve conflicts" button

Render a `ResolveConflictsButton` next to the indicator when `mergeable === "conflicting"`. The button fires the existing rebase driver from feature 094.

```tsx
{mergeable === "conflicting" && rebaseStatus === "idle" && (
  <ResolveConflictsButton sessionId={sessionId} baseBranch={pr.baseBranch} />
)}
```

**Click behavior:**

```typescript
function ResolveConflictsButton({ sessionId, baseBranch }: Props) {
  const startRebase = useGitStore((s) => s.startRebase);
  const isAgentRunning = useSessionStore((s) =>
    s.activeRunnerSessions.has(sessionId)
  );

  const handleClick = () => {
    if (isAgentRunning) return; // disabled state — see below
    startRebase(sessionId, baseBranch);
  };

  return (
    <Button
      variant="warning"
      size="sm"
      disabled={isAgentRunning}
      title={isAgentRunning ? "Wait for agent to finish before resolving" : undefined}
      onClick={handleClick}
    >
      Resolve conflicts
    </Button>
  );
}
```

**No confirmation, no chat prefill.** This is a deliberate exception to the "chat is the input surface" principle — see [Chat-input exception](#chat-input-exception) below.

**Agent-idle gate.** When the agent is in a turn, the button is disabled with a tooltip. Reasons:
- The rebase driver spawns its own agent turn for conflict resolution (per 094 phase 6). Trying to start one while another is running is rejected by the driver with a 409, and we'd surface that as a toast — confusing UX.
- The agent's current turn may itself be writing files that would conflict with the rebase. Waiting is correct.
- We don't queue the rebase to fire after the current turn — the user can click again when the agent finishes. Queuing introduces stale-intent risk (the conflict may have been resolved by other means in the interim).

The button passes `pr.baseBranch` (from the PR data) — not the hardcoded `"main"` that `RebaseBanner` currently uses for the push-rejected path. Both call sites should ultimately use `pr.baseBranch` from the PR card state; updating `RebaseBanner` to do the same is a small follow-up that falls out naturally during this work.

### Phase 6: Coordinated UI between PR card and RebaseBanner

The `RebaseBanner` already renders rebase progress (`in_progress`, `conflicts`, `resolving`) in its own surface near the top of the chat panel. While a rebase is active, hide the inline "Resolve conflicts" button and conflict indicator in the PR card — the `RebaseBanner` is the active surface for that flow.

```typescript
const showConflictUI = mergeable === "conflicting" && rebaseStatus === "idle";
```

If the rebase aborts (agent gives up after `MAX_REBASE_ITERATIONS = 10`, or user clicks abort), `rebaseStatus` returns to `"idle"` and the next poller tick re-confirms `mergeable === "conflicting"` → the inline UI returns. The user can click "Resolve conflicts" again to retry, or address the situation manually.

### Phase 7: Tests

**Server unit (`pr-status-poller.test.ts`):**
- `parsePrNode` maps GraphQL `MERGEABLE` → `"mergeable"`.
- `parsePrNode` maps `CONFLICTING` → `"conflicting"`.
- `parsePrNode` maps `UNKNOWN` → `"unknown"`.

**Client unit (`PrLifecycleCard.test.tsx`):**
- Merge button hidden when `mergeable === "conflicting"` (CI passing, no auto-merge).
- Merge button visible when `mergeable === "unknown"` (no flicker).
- Conflict indicator renders when `mergeable === "conflicting"` and `rebaseStatus === "idle"`.
- Conflict indicator hidden during rebase (`rebaseStatus !== "idle"`).
- "Resolve conflicts" button disabled when `activeRunnerSessions.has(sessionId)`.
- "Resolve conflicts" button click calls `startRebase(sessionId, pr.baseBranch)` directly — no chat prefill, no toast confirmation.

**Integration (`pr-mergeable.test.ts`, new file under `integration_tests/`):**
- Poller emits `mergeable: "conflicting"` → WS `pr_status` carries the new value → store updates → PR card renders conflict UI.
- "Resolve conflicts" click → `POST /api/sessions/:id/git/rebase` → existing rebase flow fires (covered end-to-end by `rebase-flow.test.ts` from 094 — we just need to verify the PR-card entry point reaches it).

## Chat-input exception

Per CLAUDE.md §5, ShipIt does not give the user shell-shaped buttons that run commands. The legitimate primitives for user-driven action are: ask the agent in chat, declare a service in compose, declare a one-time install in `shipit.yaml`, or use the terminal. "Click to run X" is a category mistake.

The "Resolve conflicts" button looks like a shell-shaped affordance — clicking a button to make the agent do something. We're adding it anyway, and it's worth being explicit about why this is a justified exception rather than precedent-setting drift.

**Why this case is a legitimate exception, not a category mistake:**

1. **Single, well-defined effect.** The button has one outcome: kick off the rebase driver. There is no ambiguity in the prompt — it's constructed by the orchestrator, not by the user. Compare with "click to run npm test" — the user might want different test scopes, watch mode, a specific file. There's nothing to specify here.

2. **The user has already expressed intent.** The button is labeled "Resolve conflicts" and renders only when the PR has merge conflicts. Clicking it cannot mean anything else. A second prompt-confirm step is redundant friction.

3. **The action is not user-authorable.** The conflict-resolution prompt is built by the rebase driver and includes git plumbing context (current rebase state, conflicted files with markers) that the user does not have. We could not prefill a chat box with the equivalent prompt without leaking implementation details into the user-visible chat history.

4. **It maps onto an existing primitive.** This is not a new mechanism. The rebase driver already runs unprompted on push rejection (feature 094 phase 7). We are adding a second trigger for the same flow on a different signal (poller-detected `CONFLICTING` instead of failed push). The auto-trigger precedent already exists.

5. **No new shell-shaped surface.** This is one button on one card, gated on one specific terminal state. It does not introduce a quick-action row, a command palette, or a hotkey-driven runner. The product's chat-as-input identity is unchanged.

**Constraint we keep:** The button is disabled when the agent is in a turn. We never queue an action whose preconditions might change before it runs. If the user wants to resolve conflicts while the agent is busy, they wait (consistent with how everything else gates on agent state).

If a future feature is tempted to add a similar one-click affordance, it should pass all five criteria above. If it can't, the chat-prefill pattern (or the existing terminal) is the right answer.

## Edge cases

- **`mergeable === "unknown"` lingers indefinitely.** Should not happen in practice — GitHub computes mergeability within seconds. If the poller observes `UNKNOWN` for, say, 30s, the merge button stays visible and any click that would actually conflict fails with the existing 405 toast. We accept this as a rare edge case; the alternative (gating on `unknown`) flickers the button on every push and is worse.

- **Rebase succeeds but force push is blocked (no GitHub auth).** Existing 094 behavior: rebase completes locally, force push is skipped, `forcePushed: false` is reported. The PR remains in `CONFLICTING` state on GitHub until the next push. The user is prompted to set up GitHub auth via existing flows. The conflict UI returns on the next poller tick and the user can retry after auth.

- **Rebase exhausts `MAX_REBASE_ITERATIONS`.** Existing 094 behavior: `rebase --abort` runs, `rebase_aborted` event fires, `RebaseBanner` shows the abort state. The PR card's conflict UI returns once the banner clears. The user can click "Resolve conflicts" again, edit conflicts manually, or close the PR.

- **PR card with no `pr.baseBranch`.** `pr` is always defined when we reach `OpenPhase` (early return at `PrLifecycleCard.tsx:394`). `baseBranch` is a required field on `PrStatusSummary` (it comes from GraphQL `baseRefName`). No defensive fallback needed.

- **Agent finishes a turn mid-render.** `useSessionStore.activeRunnerSessions` updates via SSE; the button transitions from disabled → enabled in the same render cycle. No special handling needed.

## Implementation order

1. **Phase 1** — widen `PrStatusSummary.mergeable` to the tri-state union; update poller mapping.
2. **Phase 3** — gate the merge button (smallest-impact correctness fix; ship-able on its own if needed).
3. **Phase 4** — render `MergeConflictIndicator`.
4. **Phase 5** — add `ResolveConflictsButton`.
5. **Phase 6** — coordinate visibility with `RebaseBanner` rebase state.
6. **Phase 7** — tests at every layer.

Phase 2 is folded into Phase 4–5 since `mergeable` is read directly from `statusBySession` rather than mirrored into `cardBySession`.

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/github-types.ts` | `PrStatusSummary.mergeable` becomes `"mergeable" \| "conflicting" \| "unknown"` |
| `src/server/orchestrator/pr-status-poller.ts` | Map GraphQL enum to new tri-state at parse time |
| `src/server/orchestrator/pr-status-poller.test.ts` | Cover all three enum mappings |
| `src/client/components/PrLifecycleCard.tsx` | Read `mergeable` from store; gate `canMerge`; render `MergeConflictIndicator` and `ResolveConflictsButton`; coordinate with `rebaseStatus` |
| `src/client/components/PrLifecycleCard.test.tsx` | Cover button-gate, indicator visibility, and resolve-button click behavior |
| `src/client/components/RebaseBanner.tsx` | (Follow-up only) accept `baseBranch` from PR data instead of hardcoded `"main"` |
| `src/server/orchestrator/integration_tests/pr-mergeable.test.ts` | New: end-to-end `CONFLICTING` → card UI → rebase trigger |

## Out of scope

- **Manual conflict resolution UI** (file-by-file diff with conflict markers). The agent-driven loop in 094 covers this. If the agent fails, the user has the chat affordance to instruct it differently — they don't need a separate file editor for conflict markers.
- **GitHub web editor link.** Per CLAUDE.md §1–2, we don't link out for things ShipIt can render. Conflicts are resolvable inline by the agent.
- **Conflicting-files preview before clicking Resolve.** Showing the file list before the rebase requires a server round-trip that adds latency without changing the user's decision. The agent's resolution summary already lists the files post-hoc (per 094 phase 6 chat output).
- **Auto-firing the rebase on poller detection.** We considered firing the rebase automatically when the poller observes `CONFLICTING`, with no button. Rejected: this can fire while the user is mid-thought on something else, and the rebase grabs the agent for an indeterminate number of turns. Manual trigger preserves user control. (Auto-trigger on push rejection is fine because the user just attempted to push; intent is fresh.)
