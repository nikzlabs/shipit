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
- [ ] Three merge outcomes: witnessed success → `settling`; definitive GitHub
      refusal → deleted, reason reaches the agent; indeterminate (transport
      error, timeout, unparseable body) → stays `merging`
- [ ] The merge and create adapters return a **typed three-way outcome**; today
      every non-2xx and every transport error collapse into one `success: false`
- [ ] A `merging` row is resolved from its own tuple, never from the shape of the
      error: merged → `settling`; still open → deleted
- [ ] The merge route **requires an active turn** and records its identity on the
      claim; the route is `containerAccessible` and enforces none of this today,
      and an existing integration test calls it with no live turn
- [ ] Reconciliation runs at startup, at end of turn, and on session activation —
      not startup alone, or a transient failure strands a row until a restart
- [ ] Reconciliation never settles while that session has an active turn
      (reattachment returns while the adopted turn keeps running), and a later
      turn does not start while settlement is unresolved

- [ ] Neither `forceVerifySessionPrState()` nor `awaitMergeHandling()` is used
- [ ] One canonical terminal-promotion operation, addressed by PR number and given
      the complete PR facts (URL, title, body, base, branch, diff stats, head SHA)
- [ ] Promoted state matches a detected merge: `merged_at`, merged snapshot,
      `mergedHeadSha`, reset eligibility
- [ ] A `settling` row **re-enters** terminal promotion even when `pr_status`
      already reads terminal — today's promotion persists the snapshot first and
      writes `merged_at` / `mergedHeadSha` / merge handling only when
      `!alreadyTerminal`, so a crash between them would suppress them for ever
- [ ] A test crashes between the snapshot and those writes, and proves the
      restart still lands `merged_at`, `mergedHeadSha` and reset eligibility
- [ ] Merge record carries a stable natural identity built only from durable row
      values (`agent-merge:<repo_id>#<pr>@<expected_sha>`); settlement is
      idempotent on it
- [ ] Notices go through `persistNoticeUnattached()` when there is no runner
- [ ] Recovery records only what it can prove: "the agent asked for this commit
      and it is now merged"; "the agent merged it" needs a witnessed REST success
- [ ] Session-state writes require the current `pr_repo_id` **and** `pr_number`
      to equal the row's, and the row's `turn_id` to still be the active turn
- [ ] The row is deleted only after settlement is written
- [ ] Success is reported only after settlement, so the agent's next
      `shipit branch reset-to-base` cannot see `not-merged`

## UI and docs

- [x] Draft the replacement `shipit-docs/github.md` section ([agent-docs.md](./agent-docs.md))
- [x] Agent permissions section in `ProjectSettings.tsx` (no new tab)
- [ ] Move the draft into `shipit-docs/github.md` with the `gh pr merge` table row
- [ ] Delete `agent-docs.md` once its content has moved

## Quality

- [x] Tests as listed in plan.md's Tests section, for everything built so far
      (the settlement tests wait on the claim slice)
- [x] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [x] A review of the implementation, not only of the design — round 1 on the
      storage/grant slice (`shipit agent run --role reviewer`, Codex). Six of its
      seven findings verified at source and fixed; the seventh (the grant is
      reachable by a local-mode agent) is recorded in plan.md's Risks, since a
      local agent can already merge without it
