# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).
Revision 2 (2026-09-02), after two review rounds.

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `RepoStore` read/write, matched on `canonicalRepoKey`
- [ ] Grant on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [ ] No new endpoint; the container-route snapshot does not gain one

## Ownership

- [ ] Migration: `sessions.pr_number` + `sessions.pr_repo_key`
- [ ] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound
- [ ] `--repo` refused on a repo-bound merge; `cwd` **ignored, not refused**
- [ ] An ordinary `gh pr merge` (which always sends `cwd`) is allowed
- [ ] Branch check uses `currentBranchOrNull()` against `session.branch`
- [ ] Requested number must equal `session.prNumber`; absent refuses

## `prNumber` lifecycle

- [ ] Written by `agentCreatePr()` only on `alreadyExisted: false`
- [ ] `quickCreatePr()` gains an `alreadyExisted` discriminator
- [ ] Written by `POST /api/sessions/:id/pr`, `/pr/quick`, and `pr-lifecycle.ts`
- [ ] Never written for a pre-existing pull request
- [ ] Written only when the created PR's canonical repo matches the session's
- [ ] Cleared by the docs/202 re-arm, by `pr-rearm.ts`, and by unarchive's clearing
- [ ] Never backfilled from `pr_status`
- [ ] `pr_repo_key` stored with the number, and the merge gate requires it to match
      `canonicalRepoKey(session.remoteUrl)` at merge time
- [ ] Changing the session's `origin` clears `pr_number`, `pr_repo_key` and any arming

## Merge sequence

- [ ] `flushPendingTurnCommit()` returns a discriminated outcome; merge proceeds
      on `committed` / `nothing-to-commit` only
- [ ] `agentCreatePr()` adopts the same outcome
- [ ] Steps 1–2 run for repo-bound sessions only, never for a sandbox
- [ ] `guardMergeSync()` verdict carries `pushed: boolean` (no taxonomy)
- [ ] `cancelAutoPush(sessionId)` only when the push landed
- [ ] One live read per attempt: a merge-only GraphQL query by PR number
      (`state`, `isDraft`, `reviewDecision`, `headRefOid`, rollup state + its `oid`)
- [ ] A response carrying any GraphQL `errors` refuses; a null rollup counts as
      zero checks only in an error-free response
- [ ] Zero-check grace via a new `PrStatusPoller.awaitCiGraceDecision()` facade
      that awaits `ensureWorkflowsLoaded()` (the tracker is private and needs it)
- [ ] `CiGraceTracker` gains a merge entry point keyed by repository + PR + head
      SHA, where an unknown CI history starts the grace; its tests cover both modes
- [ ] `awaitCiGraceDecision()` takes `prNumber` explicitly; a test covers two pull
      requests in one repository sharing a head SHA
- [ ] Query asks only for what the gate reads; a null rollup means zero checks
- [ ] Gate table implemented in full: failed read, rollup-SHA mismatch,
      local-HEAD mismatch, draft/closed, failing, pending, both zero-check cases
- [ ] The live read replaces `getCheckStatus()` on the **sandbox** path too
- [ ] Merge sends the expected `sha`
## `--auto` — the ShipIt arming (req 18–21)

- [ ] Migration: `agent_merge_armings` (session, repo key, PR number, expected
      SHA, method, **state**, last_error) + repo index + `ON DELETE CASCADE`
- [ ] Repo-bound only; a sandbox `--auto` keeps today's behaviour (req 12)
- [ ] `--auto` writes an arming; a second `--auto` replaces the first
- [ ] No GitHub-native arming on the agent path at all
- [ ] Executor runs in the poller's existing tick
- [ ] Armings feed the polling supervisor and the global gate: loaded at startup,
      `ensure()`d on arm, ticked with no viewer and no tracked session (req 21)
- [ ] Armings are activated only after `reattachInFlightTurns()` completes
- [ ] Executor shares the remote gate but has its own predicate: `expected_sha`,
      not local HEAD (it may have no worktree)
- [ ] Executor refuses while `agentBusy || systemTurnInProgress`, **then** takes
      the post-turn lease (conditional when there is no runner) across the final
      re-reads and the REST call
- [ ] One in-flight flag makes it exclusive with managed auto-merge
- [ ] Head no longer equal to `expected_sha` ⇒ delete the arming + persisted
      notice; never re-point it at the new head (req 19)
- [ ] Merge sends `expected_sha` as the REST expected `sha` (req 18)
- [ ] Revocation deletes **pending** armings by `canonicalRepoKey`, in the same
      transaction as the flag; executor re-reads arming **and** grant immediately
      before merging (req 20)
- [ ] A REST success writes `settling` even if the row was deleted meanwhile, so a
      revocation racing the call cannot strand settlement or the merge record
- [ ] Armings survive a restart (req 21)
- [ ] `settling` is monotonic: origin change, a second `--auto`, archive, re-arm,
      reset, unarchive, repository removal and revocation all act on `pending`
      rows only; only settlement or session destruction removes a `settling` row
- [ ] Settlement reconciles from the row's own `(repo_key, pr_number,
      expected_sha)`, never from current session targeting; session card state is
      best-effort and skipped when repository identity changed
- [ ] Cleared on merge, head change, PR close, **archive**, hard delete / full
      reset, docs/202 re-arm, reset, unarchive, repository removal
- [ ] Notices use `persistNoticeUnattached()` when there is no runner
- [ ] A successful REST response marks the arming **settling**; it is deleted only
      after `forceVerifySessionPrState()` sees terminal state and
      `awaitMergeHandling()` settles (or the gate can close too early)
- [ ] Terminal reconciliation records before deleting, and says only what it can
      prove: recovery records "the agent armed this commit and it is now merged";
      "the agent merged it" needs a witnessed REST success
- [ ] A refused merge keeps the arming and records `last_error`, surfaced once
- [ ] A user's card-armed auto-merge is untouched by any of this

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
