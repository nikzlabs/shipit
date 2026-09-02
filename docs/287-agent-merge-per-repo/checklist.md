# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).
Revision 2 (2026-09-02), after two review rounds.

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `RepoStore` read/write, matched on `canonicalRepoKey`
- [ ] Grant on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [ ] No new endpoint; the container-route snapshot does not gain one

## Ownership

- [ ] Migration: `sessions.pr_number`
- [ ] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound
- [ ] `--repo` refused on a repo-bound merge; `cwd` **ignored, not refused**
- [ ] An ordinary `gh pr merge` (which always sends `cwd`) is allowed
- [ ] Branch check uses `currentBranchOrNull()` against `session.branch`
- [ ] Requested number must equal `session.prNumber`; absent refuses

## `prNumber` lifecycle

- [ ] Written by `agentCreatePr()` only on `alreadyExisted: false`
- [ ] Written by `POST /api/sessions/:id/pr` and by `pr-lifecycle.ts`
- [ ] Never written for a pre-existing pull request
- [ ] Cleared by the docs/202 re-arm, by `pr-rearm.ts`, and by unarchive's clearing
- [ ] Never backfilled from `pr_status`

## Merge sequence

- [ ] `flushPendingTurnCommit()` returns a discriminated outcome; merge proceeds
      on `committed` / `nothing-to-commit` only
- [ ] `agentCreatePr()` adopts the same outcome
- [ ] Steps 1–2 run for repo-bound sessions only, never for a sandbox
- [ ] `guardMergeSync()` verdict carries `pushed: boolean` (no taxonomy)
- [ ] `cancelAutoPush(sessionId)` only when the push landed
- [ ] One live read per attempt: `buildPrStatusQuery()` + `parsePrNode()`
- [ ] `committedDate` added to the head commit in that query
- [ ] Gate table implemented in full, including rollup-SHA mismatch and both
      zero-check cases; a failed read refuses
- [ ] The live read replaces `getCheckStatus()` on the **sandbox** path too
- [ ] Merge sends the expected `sha`
- [ ] `--auto` on a repo-bound session arms ShipIt-managed auto-merge

## After the merge

- [ ] `awaitMergeHandling(sessionId)` awaited before success is reported
- [ ] `emitNoticeInTurn()` record (persisted, survives a reload)
- [ ] Result tells the agent to run `shipit branch reset-to-base`

## UI and docs

- [x] Draft the replacement `shipit-docs/github.md` section ([agent-docs.md](./agent-docs.md))
- [ ] Agent permissions section in `ProjectSettings.tsx` (no new tab)
- [ ] Move the draft into `shipit-docs/github.md` with the `gh pr merge` table row
- [ ] Delete `agent-docs.md` once its content has moved

## Quality

- [ ] `pr-target.test.ts` — dispositions, `--repo` refused, `cwd` tolerated
- [ ] `services/github-agent-merge.test.ts` — ownership, flush outcomes, cancel
      rule, every gate row, expected `sha`, settlement awaited
- [ ] `services/branch-sync.test.ts` — `pushed` true only after a real push
- [ ] `prNumber` lifecycle tests: writers, clearers, no backfill
- [ ] `integration_tests/agent-driven-pr.test.ts` — granted, not granted, foreign
      PR, notice reload
- [ ] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [ ] A review of the implementation, not only of the design
