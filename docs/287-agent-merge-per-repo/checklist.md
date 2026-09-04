# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).

## Storage and grant

- [x] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [x] `repoId()` in `git-utils.ts`: parsed, case-normalised `github:<owner>/<repo>`,
      collapsing https / SSH / casing spellings that `canonicalRepoKey()` does not
- [x] `repoId()` parses **strictly**: authority exactly GitHub, anchored, only a
      terminal `.git` stripped, dots legal in repository names, everything else
      rejected rather than degraded — an unparseable remote gets no grant
- [x] `RepoStore` read/write keyed by that identity — never `canonicalRepoKey()`,
      which leaves path casing alone and sends SCP URLs down a different branch
- [x] Grant on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [x] No new endpoint; the container-route snapshot does not gain one

## Ownership and provenance

- [x] Migration: `sessions.pr_number` + `sessions.pr_repo_id`
- [x] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound,
      with the grant a REQUIRED parameter so no call site can default to allowed
- [x] `--repo` refused on a repo-bound merge; `cwd` **ignored, not refused**
- [x] An ordinary `gh pr merge` (which always sends `cwd`) is allowed
- [x] Branch check uses `currentBranchOrNull()` against `session.branch`
- [x] Requested number must equal `session.pr_number`, and `pr_repo_id` must
      equal `repoId(session.remoteUrl)` at merge time; absent refuses
- [x] `quickCreatePr()` gains an `alreadyExisted` discriminator (and the resolved
      `owner`/`repo`, since `--repo` can retarget where the PR lands)
- [x] Only a **witnessed create** records provenance; a discovered pull request is
      never adopted, on any path — no nonce, no intent table, no heuristic
- [x] Every discovery route goes through one provenance path
      (`services/pr-provenance.ts`), including `pr-lifecycle.ts`, whose recovery
      branch discovers by branch name and deliberately records nothing
- [x] Written by `agentCreatePr()`, `POST /pr`, `/pr/quick` and `pr-lifecycle.ts`,
      only on `alreadyExisted: false` **and** a matching canonical repository
- [x] Cleared by the docs/202 re-arm (both `pr-rearm.ts` paths go through
      `clearMerged`), unarchive, and an `origin` change that moves to a different
      repository identity; never backfilled from `pr_status`

## The live read and the observation

- [x] Merge-only GraphQL query by PR number (`state`, `isDraft`, `reviewDecision`,
      `headRefOid`, rollup state + its `oid`) — `services/merge-gate.ts`
- [x] Any GraphQL `errors` refuses before anything else applies
- [x] The read returns a structured **observation**, and the observation decides
- [x] A repo-bound `--auto` is refused with a message naming
      `docs/288-agent-merge-arming`; sandbox `--auto` is unchanged
- [x] Observation table implemented in full; pending checks and the zero-check
      grace both refuse, and an unrecognised rollup state refuses too
- [x] Any non-passing reported check refuses, required or not (req 7)
- [x] The read replaces `getCheckStatus()` on the **sandbox** path too
- [x] `CiGraceTracker` gains a merge entry point keyed by repository + PR + head
      SHA, where an unknown CI history starts the grace; tests cover both modes
- [x] `awaitCiGraceDecision()` takes `prNumber` explicitly; a test covers two pull
      requests in one repository sharing a head SHA

## Merge sequence

- [x] `flushPendingTurnCommit()` returns a discriminated outcome — `committed` /
      `nothing-to-commit` / `blocked-secret` / `blocked-unreadable` /
      `blocked-conflict` / `partial-unreadable`
- [x] The merge proceeds on `committed` / `nothing-to-commit` only
- [x] `agentCreatePr()` adapts to the new return type and changes no behaviour
- [x] Steps 1–2 run for repo-bound sessions only, never for a sandbox
- [x] `guardMergeSync()` verdict carries `pushed: boolean` (no taxonomy)
- [x] `cancelAutoPush(sessionId)` only when the push landed
- [x] Merge sends the observed `headRefOid` as the REST expected `sha`

## The durable claim and settlement (req 9, 10, 11)

- [x] Migration: `agent_merge_claims` (session PK with `ON DELETE CASCADE`,
      repo id, PR number, expected SHA, `turn_id`, `state` = merging | settling).
      No `method`: nothing after the REST attempt reads it — **done**
- [x] Three merge outcomes: witnessed success → `settling`; definitive GitHub
      refusal → deleted, reason reaches the agent; indeterminate (transport
      error, timeout, unparseable body) → stays `merging`
- [x] The MERGE adapter returns a typed three-way outcome
      (`mergePullRequestAttempt`); `mergePullRequest` stays as the boolean
      wrapper for callers with no claim to keep or drop. The CREATE adapter
      deliberately does not: the distinction was there to decide whether a
      create *intent* was cleared, and that table was deleted when provenance
      became witnessed-create-only, so it would have no consumer
- [x] A `merging` row is resolved from its own tuple, never from the shape of the
      error: merged → settled and recorded; still open → deleted
- [x] The merge route **requires an active turn** and records its identity on the
      claim. The turn identity carries a per-process prefix, so a claim from a
      previous process cannot match epoch 0 of the next one
- [x] Reconciliation runs at startup, at end of turn (the runner-idle hook), and
      on session activation
- [x] Reconciliation never settles while that session has an active turn —
      `agentBusy` OR `running`, so post-turn work counts too
- [ ] A later turn does not start while settlement is unresolved (not built: an
      unresolved claim defers to the next trigger rather than blocking a turn)

- [x] Neither `forceVerifySessionPrState()` nor `awaitMergeHandling()` is used
- [x] One canonical terminal-promotion operation, addressed by PR number and given
      the complete PR facts (URL, title, body, base, branch, diff stats, head SHA)
- [x] Promoted state matches a detected merge: `merged_at`, merged snapshot,
      `mergedHeadSha`, reset eligibility — it is literally the same code path
- [x] A `settling` row **re-enters** terminal promotion even when `pr_status`
      already reads terminal (the `force` flag)
- [x] A test crashes between the snapshot and those writes, and proves the
      restart still lands `merged_at`, `mergedHeadSha` and reset eligibility
- [x] Merge record carries a stable natural identity built only from durable row
      values (`agent-merge:<repo_id>#<pr>@<expected_sha>`); settlement is
      idempotent on it — the record and the release share one transaction, and
      the row inside it is the permission to record
- [x] Notices go through `persistNoticeUnattached()` — always, since a
      settlement can run post-turn or after a restart
- [x] Recovery records only what it can prove: "the agent asked for this commit
      and it is now merged"; "the agent merged it" needs a witnessed REST success
- [x] Session-state writes require the current `pr_repo_id` **and** `pr_number`
      to equal the row's, checked BEFORE the promotion (which is what writes
      that state). Reconciliation's turn rule is stronger than the row's
      `turn_id`: it stands down for ANY active turn, because the hazard is
      writing while something else pushes, not whether the ids match
- [x] The row is deleted only after settlement is written
- [x] Success is reported only after settlement, so the agent's next
      `shipit branch reset-to-base` cannot see `not-merged`

## UI and docs

- [x] Draft the replacement `shipit-docs/github.md` section
- [x] Agent permissions section in `ProjectSettings.tsx` (no new tab)
- [x] Move the draft into `shipit-docs/github.md` with the `gh pr merge` table row,
      corrected against the shipped behaviour rather than the pre-implementation draft
- [x] Delete `agent-docs.md` once its content has moved

## Quality

- [x] Tests as listed in plan.md's Tests section, for everything built so far
      (the settlement tests wait on the claim slice)
- [x] Each new guard proved red on its own before the fix
- [x] `npm run lint:dev` and `npm run typecheck` green, and the full suite ran
      clean (963 files, 16,705 tests) for the widened interfaces
- [x] A review of the implementation, not only of the design — three cold rounds
      (`shipit agent run --role reviewer`), each given the work without being
      told what an earlier round found. Round 1 (storage/grant): 6 of 7 findings
      fixed, the 7th (a local-mode agent can reach the grant) recorded in
      plan.md's Risks, since such an agent can already merge without it. Round 2
      (claim/settlement): 10 of 10 real, all fixed. Round 3 (the whole branch):
      9 of 10 fixed — a withdrawn grant not stopping an in-flight merge, claims
      not being single-flight, the promotion writing before validating the
      merged commit and the idle state, a moved-on session dropping its
      evidence, an unreadable local HEAD reading as the sandbox exemption, the
      two repository parsers disagreeing on dotted names, a branch change not
      clearing provenance, and a `reviewDecision` blacklist
- [x] Six tests round 3 judged unable to fail were rebuilt, not kept: the
      settlement fake performs the promotion decision instead of standing in for
      its result, the turn race is reproduced inside the simulated round trip,
      and the promotion guard is tested on the real poller
