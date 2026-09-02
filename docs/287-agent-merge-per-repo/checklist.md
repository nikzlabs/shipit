# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).
Revised 2026-09-02 after the independent review.

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `RepoStore` read/write, matched on `canonicalRepoKey`
- [ ] Grant carried on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [ ] No new endpoint, and the route stays browser-only

## Ownership (the tuple, not a number)

- [ ] Migration: `sessions.pr_number`, written when ShipIt opens the session's PR
- [ ] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound
- [ ] `--repo` and `cwd` refused on a repo-bound merge; still allowed for sandbox
- [ ] Branch check uses `currentBranchOrNull()` and compares with `session.branch`
- [ ] Requested number must equal the recorded `session.prNumber`; absent refuses

## Merge sequence

- [ ] `flushPendingTurnCommit()` returns a discriminated outcome (committed,
      nothing-to-commit, blocked-secret, blocked-unreadable, blocked-conflict,
      partial-unreadable)
- [ ] Merge proceeds on `committed` / `nothing-to-commit` only; the rest are 422
- [ ] `agentCreatePr()` adopts the same outcome (it has the same two holes today)
- [ ] `guardMergeSync()` before any status read
- [ ] `MergeSyncVerdict` gains `reason: "pushed" | "push-failed" | "diverged"`
- [ ] `cancelAutoPush(sessionId)` only on `reason: "pushed"`
- [ ] Repo-bound gating reads the poller summary after `forceRefreshSession()`
- [ ] Absent summary refuses; `checks.total === 0` inside `graceUntil` refuses
- [ ] `reviewDecision` gate from that same summary (docs/174)
- [ ] Pending refusal names `--auto`
- [ ] Head SHA captured once, and sent as the REST merge's expected `sha`

## After the merge

- [ ] `emitNoticeInTurn()` record (persisted, survives a reload)
- [ ] `poller.forceVerifySessionPrState()` after a successful merge
- [ ] Result tells the agent to run `shipit branch reset-to-base`

## UI and docs

- [x] Draft the replacement `shipit-docs/github.md` section ([agent-docs.md](./agent-docs.md))
- [ ] Agent permissions section in `ProjectSettings.tsx` (no new tab)
- [ ] Move the draft into `shipit-docs/github.md` with the `gh pr merge` table row
- [ ] Delete `agent-docs.md` once its content has moved, so there is one copy

## Quality

- [ ] `pr-target.test.ts` — dispositions, and overrides refused on repo-bound
- [ ] `services/github-agent-merge.test.ts` — ownership refusals, flush outcomes,
      cancel rule, `graceUntil`, `--auto`, expected-`sha`
- [ ] `services/branch-sync.test.ts` — the `reason` discriminator
- [ ] `integration_tests/agent-driven-pr.test.ts` — granted, not granted, foreign PR, notice reload
- [ ] Container-route snapshot unchanged (the grant route is browser-only)
- [ ] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [ ] A second independent review of the implementation
