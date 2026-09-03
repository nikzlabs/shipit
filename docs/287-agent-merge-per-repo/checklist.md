# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `RepoStore` read/write, matched on `canonicalRepoKey`
- [ ] Grant on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [ ] No new endpoint; the container-route snapshot does not gain one

## Ownership and provenance

- [ ] Migration: `sessions.pr_number` + `sessions.pr_repo_key`
- [ ] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound
- [ ] `--repo` refused on a repo-bound merge; `cwd` **ignored, not refused**
- [ ] An ordinary `gh pr merge` (which always sends `cwd`) is allowed
- [ ] Branch check uses `currentBranchOrNull()` against `session.branch`
- [ ] Requested number must equal `session.pr_number`, and `pr_repo_key` must
      equal `canonicalRepoKey(session.remoteUrl)` at merge time; absent refuses
- [ ] `quickCreatePr()` gains an `alreadyExisted` discriminator
- [ ] Written by `agentCreatePr()`, `POST /pr`, `/pr/quick` and `pr-lifecycle.ts`,
      only on `alreadyExisted: false` **and** a matching canonical repository
- [ ] Cleared by the docs/202 re-arm, `pr-rearm.ts`, unarchive, and an `origin`
      change; never backfilled from `pr_status`

## The live read and the observation

- [ ] Merge-only GraphQL query by PR number (`state`, `isDraft`, `reviewDecision`,
      `headRefOid`, rollup state + its `oid`)
- [ ] Any GraphQL `errors` refuses before anything else applies
- [ ] The read returns a structured **observation**; the caller's mode decides
- [ ] Observation table implemented for **both** modes, including: pending checks
      refuse a direct merge but arm `--auto`; the zero-check grace refuses both
- [ ] The read replaces `getCheckStatus()` on the **sandbox** path too
- [ ] `CiGraceTracker` gains a merge entry point keyed by repository + PR + head
      SHA, where an unknown CI history starts the grace; tests cover both modes
- [ ] `awaitCiGraceDecision()` takes `prNumber` explicitly; a test covers two pull
      requests in one repository sharing a head SHA

## Merge sequence

- [ ] `flushPendingTurnCommit()` returns a discriminated outcome; merge proceeds
      on `committed` / `nothing-to-commit` only
- [ ] `agentCreatePr()` adapts to the new return type and changes no behaviour
- [ ] Steps 1–2 run for repo-bound sessions only, never for a sandbox
- [ ] `guardMergeSync()` verdict carries `pushed: boolean` (no taxonomy)
- [ ] `cancelAutoPush(sessionId)` only when the push landed
- [ ] Merge sends the observed `headRefOid` as the REST expected `sha`

## The arming (req 18–21)

- [ ] Migration: `agent_merge_armings` (session PK with `ON DELETE CASCADE`, repo
      key, PR number, expected SHA, method, `state`, `origin`, last_error) + index
- [ ] Repo-bound only; a sandbox `--auto` keeps today's behaviour (req 12)
- [ ] Durable claim written **before** the REST call, by both merge paths
- [ ] A second `--auto` is refused while a row is `merging` or `settling`
- [ ] `merging` / `settling` are monotonic: origin change, archive, re-arm, reset,
      unarchive, repository removal, revocation and a second `--auto` act on
      `pending` rows only
- [ ] `origin` decides failure handling: a failed **direct** claim is deleted, a
      failed **auto** claim returns to `pending` with `last_error` surfaced once
- [ ] Crash reconciliation resolves a `merging` row from its own tuple and keeps
      that origin distinction
- [ ] Executor runs in the poller's existing tick
- [ ] Armings feed the polling supervisor and the global gate: loaded at startup,
      `ensure()`d on arm, ticked with no viewer and no tracked session (req 21)
- [ ] Armings are activated only after `reattachInFlightTurns()` completes
- [ ] Executor's predicate is `expected_sha`, not local HEAD (it may have no
      worktree); a head that no longer matches deletes the arming with a notice (req 19)

## Merge and turn are mutually exclusive (docs/266 req 2)

- [ ] A session-scoped merge claim, taken only when the session is idle
- [ ] Interactive admission (`ws-handlers/send-message.ts`) queues while it is held
- [ ] Dispatched admission (`session-runner.ts`) queues while it is held
- [ ] Released when the merge has settled
- [ ] One in-flight claim makes the executor exclusive with managed auto-merge

## Revocation (req 20)

- [ ] Deletes **pending** armings by `canonicalRepoKey`, in the same transaction
      as the flag
- [ ] Shares a per-repository boundary with the claim-to-REST interval: it either
      cancels before the request is issued, or waits for an issued request to
      resolve before reporting the permission withdrawn
- [ ] A user's card-armed auto-merge is untouched

## Settlement (req 9, 10, 11)

- [ ] Neither `forceVerifySessionPrState()` nor `awaitMergeHandling()` is used
- [ ] One canonical terminal-promotion operation, addressed by PR number and given
      the complete PR facts (URL, title, body, base, branch, diff stats, head SHA)
- [ ] Promoted state matches a detected merge: `merged_at`, merged snapshot,
      `mergedHeadSha`, reset eligibility
- [ ] Merge record carries a stable natural identity
      (`agent-merge:<repo_key>#<pr>@<sha>`) and settlement is idempotent on it
- [ ] Notices go through `persistNoticeUnattached()` when there is no runner
- [ ] Recovery records only what it can prove: "the agent armed this commit and it
      is now merged"; "the agent merged it" needs a witnessed REST success
- [ ] Session-state writes require the current `pr_repo_key` **and** `pr_number`
      to equal the row's
- [ ] The row is deleted only after settlement is written
- [ ] Success is reported only after settlement, so the agent's next
      `shipit branch reset-to-base` cannot see `not-merged`

## UI and docs

- [x] Draft the replacement `shipit-docs/github.md` section ([agent-docs.md](./agent-docs.md))
- [ ] Agent permissions section in `ProjectSettings.tsx` (no new tab)
- [ ] Move the draft into `shipit-docs/github.md` with the `gh pr merge` table row
- [ ] Delete `agent-docs.md` once its content has moved

## Quality

- [ ] Tests as listed in plan.md's Tests section
- [ ] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [ ] A review of the implementation, not only of the design
