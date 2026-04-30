---
status: done
---

# 099 — Auto-Create PR After Meaningful Turn

## Summary

Extend the existing `autoCreatePr` setting so that the PR is created after **any** meaningful agent turn — not only the first turn of a new session. A "meaningful turn" = a turn whose post-turn auto-commit produced a non-empty commit (i.e., files actually changed).

## Motivation

Today, ShipIt already has:
- A global `autoCreatePr` setting in `CredentialStore` (off by default).
- A toggle in the PR lifecycle card overflow menu (`AutoCreatePrToggle` in `PrLifecycleCard.tsx`).
- An auto-create code path in `claude-execution.ts` that runs after the post-turn commit.

But the gate has an extra restriction: `shouldAutoCreate = isNewSession && credentialStore.getAutoCreatePr() && githubAuthManager.authenticated`. Because of `isNewSession`, the auto-create only fires for the **first** turn of a brand-new session. If the first turn happens to be a clarifying question with no code changes, or the user creates the session with a one-line prompt and follows up later, the PR is never auto-created — the user has to click "Create PR" on the ready card manually.

The user's expectation when toggling "Auto-create PR" on is: *"any time the agent finishes a turn that actually changed code, open a PR for me."*

## Design

### What "meaningful" means

A turn is meaningful iff `postTurnCommit` returned a non-null commit hash. `git.autoCommit()` returns `null` when the working tree is clean and a hash otherwise — so a question-only or no-op turn is non-meaningful and produces no PR (and indeed never reaches the auto-create block, which is already gated by `if (commitHash && capturedSessionId && capturedSessionDir)` at `claude-execution.ts:250`).

We deliberately **do not** add additional thresholds (file count, line count, etc.). The autoCommit boundary is already the right minimum: anything Claude staged-and-committed is intentional.

### Idempotency

Once a PR exists for the branch, `claude-execution.ts:257` short-circuits the auto-create block (`if (prStatus) { /* already exists */ } else { … }`). So subsequent meaningful turns just rely on the existing 5s-debounced auto-push (`scheduleAutoPush` in `post-turn.ts`) to update the existing PR's branch — no double-creation.

### The change

```diff
- // No PR yet — check if auto-create PR is enabled for new sessions
- const shouldAutoCreate = isNewSession
-   && ctx.credentialStore.getAutoCreatePr()
+ // No PR yet — check if auto-create PR is enabled
+ const shouldAutoCreate = ctx.credentialStore.getAutoCreatePr()
    && ctx.githubAuthManager.authenticated;
```

That is the entire server-side change. Everything else (the "creating" → "open" lifecycle card phases, error handling, PR description generation, push-then-create via `quickCreatePr`) is already wired up.

### Toggle copy

Update `PrLifecycleCard.tsx`:

```diff
- title={autoCreatePr
-   ? "Disable auto-create PR for new sessions"
-   : "Enable auto-create PR for new sessions"}
+ title={autoCreatePr
+   ? "Disable auto-create PR after meaningful turns"
+   : "Enable auto-create PR after every meaningful turn"}
```

The `AutoCreatePrToggle` lives in the overflow menu of the **ready** phase. After the change, when the toggle is on, the ready phase will be transient — it appears for a tick before transitioning to "creating" → "open". That is the desired UX.

### Race with auto-push

`postTurnCommit` schedules a 5s-debounced auto-push BEFORE the auto-create block runs. `quickCreatePr` does its own `git.push()` synchronously. Order:

1. `postTurnCommit` returns commit hash, timer set for `pushToOrigin` in 5s.
2. Auto-create block runs `quickCreatePr` immediately → pushes branch → creates PR.
3. 5s later, the debounced timer fires and pushes again (no-op — branch already up to date).

The redundant push is harmless. We could in principle cancel the pending auto-push when we know we're about to auto-create, but it would add complexity for no user-visible benefit.

## Settings storage scope

The setting stays **global** (one toggle for all sessions), stored on `CredentialStore.autoCreatePr`. Per-session toggles are out of scope for this doc — if needed later, they can be added by extending `SessionMetadata` with an `autoCreatePr?: boolean` override and falling back to the global setting when undefined.

## Auth, remote, and merge-state guards

The existing block at `claude-execution.ts:253` already guards on:

- `session.remoteUrl` exists
- `session.branchRenamed !== false` (don't operate on the bare-cache placeholder branch)
- `!session.mergedAt` (don't reopen a PR for a merged-and-archived branch)

Plus the new `shouldAutoCreate` requires GitHub auth. These are all preserved.

## Tests

Add an integration test `pr-auto-create-on-turn.test.ts` covering:

1. **Auto-create on first meaningful turn (existing behavior, regression-protected)** — `autoCreatePr=true`, GitHub authed, session has remote, FakeClaude produces a file change → expect `pr_lifecycle_update phase=creating` then `phase=open`.
2. **Auto-create on subsequent turn** — same as 1 but `isNewSession=false` (resumed session with prior history). This is the new behavior.
3. **No-op turn** — `autoCreatePr=true`, FakeClaude produces no file change → expect no `pr_lifecycle_update phase=creating` event.
4. **PR already exists** — `autoCreatePr=true`, `prStatusPoller` returns an existing PR for the session → expect no auto-create attempt.
5. **Setting off** — `autoCreatePr=false`, change occurs → expect a `phase=ready` card, not `creating`.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/ws-handlers/claude-execution.ts` | Drop `isNewSession &&` from `shouldAutoCreate` |
| `src/client/components/PrLifecycleCard.tsx` | Update `AutoCreatePrToggle` title copy |
| `src/server/orchestrator/integration_tests/pr-auto-create-on-turn.test.ts` | New integration test file |
| `docs/064-pr-lifecycle-flow/plan.md` | Cross-link from the auto-create section to this doc |

## Future extensions (out of scope)

- **Per-session override** — let a single session opt out of the global setting (e.g. for a long-lived "scratch" session).
- **Per-repo default** — configure auto-create-PR via `shipit.yaml`.
- **Diff-size threshold** — skip auto-create for very small diffs (e.g. < 3 lines), useful to suppress PRs for typo-fixing turns. Probably solved better by Claude's own judgment than a hard rule.
