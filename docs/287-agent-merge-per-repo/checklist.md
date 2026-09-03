# Checklist — Agent merge, granted per repository

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).

## Storage and grant

- [ ] Migration: `repos.allow_agent_merge INTEGER NOT NULL DEFAULT 0`, no backfill
- [ ] `repoId()` in `git-utils.ts`: parsed, case-normalised `github:<owner>/<repo>`,
      collapsing https / SSH / casing spellings that `canonicalRepoKey()` does not
- [ ] `RepoStore` read/write keyed by that identity — never `canonicalRepoKey()`,
      which leaves path casing alone and sends SCP URLs down a different branch
- [ ] Grant on the existing `PATCH /api/repos/:url` and the `RepoInfo` projection
- [ ] No new endpoint; the container-route snapshot does not gain one

## Ownership and provenance

- [ ] Migration: `sessions.pr_number` + `sessions.pr_repo_id`
- [ ] `mergeDisposition()`: sandbox / ops (`not-sandbox`, unchanged) / repo-bound
- [ ] `--repo` refused on a repo-bound merge; `cwd` **ignored, not refused**
- [ ] An ordinary `gh pr merge` (which always sends `cwd`) is allowed
- [ ] Branch check uses `currentBranchOrNull()` against `session.branch`
- [ ] Requested number must equal `session.pr_number`, and `pr_repo_key` must
      equal `repoId(session.remoteUrl)` at merge time; absent refuses
- [ ] `quickCreatePr()` gains an `alreadyExisted` discriminator
- [ ] `pr_create_intents(session_id, repo_id, branch, nonce)` written before the
      GitHub create; the nonce goes into the created PR's body
- [ ] A discovered PR is adopted **only** when its body carries a matching intent
      nonce — an intent alone proves intent, not authorship, and a person can open
      a PR from that branch in the window
- [ ] The intent is cleared on provenance and on a **definitive** create failure,
      and kept on an indeterminate one
- [ ] One provenance reconciliation path used by every discovery route, including
      `pr-lifecycle.ts`, which can return an existing PR straight from the poller
- [ ] Written by `agentCreatePr()`, `POST /pr`, `/pr/quick` and `pr-lifecycle.ts`,
      only on `alreadyExisted: false` **and** a matching canonical repository
- [ ] Cleared by the docs/202 re-arm, `pr-rearm.ts`, unarchive, and an `origin`
      change; never backfilled from `pr_status`

## The live read and the observation

- [ ] Merge-only GraphQL query by PR number (`state`, `isDraft`, `reviewDecision`,
      `headRefOid`, rollup state + its `oid`)
- [ ] Any GraphQL `errors` refuses before anything else applies
- [ ] The read returns a structured **observation**, and the observation decides
- [ ] A repo-bound `--auto` is refused with a message naming
      `docs/288-agent-merge-arming`; sandbox `--auto` is unchanged
- [ ] Observation table implemented in full; pending checks and the zero-check
      grace both refuse
- [ ] Any non-passing reported check refuses, required or not (req 7)
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

## The durable claim and settlement (req 9, 10, 11)

- [ ] Migration: `agent_merge_claims` (session PK with `ON DELETE CASCADE`,
      repo id, PR number, expected SHA, method, `state` = merging | settling)
- [ ] Three merge outcomes: witnessed success → `settling`; definitive GitHub
      refusal → deleted, reason reaches the agent; indeterminate (transport
      error, timeout, unparseable body) → stays `merging`
- [ ] The merge and create adapters return a **typed three-way outcome**; today
      every non-2xx and every transport error collapse into one `success: false`
- [ ] A `merging` row is resolved from its own tuple, never from the shape of the
      error: merged → `settling`; still open → deleted
- [ ] A startup reconciliation pass resolves every surviving `merging` /
      `settling` row, after `reattachInFlightTurns()` completes

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
