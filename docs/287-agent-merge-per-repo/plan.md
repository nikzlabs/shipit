---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, flush the turn's work before merging, and decide the merge from one live read.
---

# Agent merge, granted per repository — design

Implements [requirements.md](./requirements.md). Extends
`docs/224-sandbox-merge-capability` (the shim, the route, the guardrails).

> **Revision 2, 2026-09-02.** Two independent review rounds; every finding
> verified at the source before it was accepted. Round 1 (7 findings) rebuilt the
> ownership check. Round 2 (7 findings, 3 blockers) replaced the status gate and
> caught a `cwd` rule that would have broken every merge. See
> [What the reviews changed](#what-the-reviews-changed).

## What changes, in one line

`mergeDisposition()` stops asking "is this a sandbox?" and starts asking "may an
agent merge here?" — the repo-bound path flushes the turn's work first, and both
paths decide from **one live read of the pull request**, then merge at the exact
SHA that read described.

## 1. Storage — the grant (req 1, 2, 3)

A column on the `repos` table, copying `repos.trusted` (docs/178) — the
per-repository boolean this feature is a second instance of:

```sql
ALTER TABLE repos ADD COLUMN allow_agent_merge INTEGER NOT NULL DEFAULT 0
```

Appended migration, and unlike `trusted` there is **no backfill**: every
repository starts off (req 2). Reads and writes live on `RepoStore`
(`orchestrator/repo-store.ts`) beside `isTrusted()` / `setTrusted()`, matched on
`canonicalRepoKey(url)` for the same reason those are — two spellings of one
remote must share one decision.

**No new endpoint.** The flag joins the existing browser-only
`PATCH /api/repos/:url` (which already takes `hidden` and `colorIndex` and
broadcasts `repo_list`) and rides the `RepoInfo` projection to the client. It is
**server-authoritative and container-inaccessible**: the browser reads it to
render the toggle, the container never sees or sets it. Round 2 confirmed that
route carries no `containerAccessible` opt-in, so the golden container-route
table is the guard (req 3).

**Rejected: `shipit.yaml`.** The agent can write that file, so a permission
declared there is one it can grant itself. Receipt in requirements.md.

## 2. The gate (req 4, 5, 6, 12, 13)

`mergeDisposition()` gains one branch and **keeps `not-sandbox` for ops
sessions** — requirement 13 says their behaviour does not change:

| Session | Decision |
|---|---|
| `kind === "sandbox"` | as today — `dangerousGitHubOps` decides (req 12) |
| `kind === "ops"` | `not-sandbox`, unchanged wording (req 13) |
| repo-bound | the repository's `allow_agent_merge` decides (req 4, 6) |

`not-granted-repo` is the one new disposition: *"Agents cannot merge in this
repository. The user turns this on in Project Settings."* (req 6)

### Ownership: a server-derived tuple (req 5)

Comparing PR numbers proves nothing, because a number is only unique inside a
repository. Ownership is decided from state the agent cannot write:

- **Repository** — `session.remoteUrl`. A repo-bound merge **refuses `--repo`**,
  which otherwise retargets the whole operation (`resolvePrTarget()` returns
  early on a parsed `--repo`, `pr-target.ts:106`).
- **Working tree** — the session root. `cwd` is **ignored, not refused**: the
  shim sends it on *every* call (`targetBody()` includes `deps.cwd`, which
  `runShim` defaults to `process.cwd()`), so refusing it would reject the
  feature's happy path — round 2's first blocker. `resolvePrTarget()` already
  ignores it when no `--repo` is given.
- **Branch** — `session.branch`, the server-side record. Before any git mutation
  the route requires `git.currentBranchOrNull() === session.branch` —
  `currentBranchOrNull`, never `getCurrentBranch`, which returns `"main"` on a
  detached HEAD (`shared/git.ts:670`).
- **Pull request** — `session.prNumber`, the number ShipIt recorded when it
  opened this session's pull request. The requested number must equal it, and an
  absent value **refuses**.

Failing closed is deliberate, and is the opposite of `guardMergeSync`, where
"cannot tell" correctly proceeds: there the fallback is the status quo, here it
is a merge.

### The `prNumber` lifecycle

A recorded number is a **provenance claim**, so only a pull request ShipIt itself
opened may write it — otherwise it grants ownership of a person's pull request,
which requirement 5 excludes by name.

| Event | Effect on `sessions.pr_number` |
|---|---|
| `agentCreatePr()` returns `alreadyExisted: false` | write the number |
| `POST /api/sessions/:id/pr` opens a PR | write the number |
| `pr-lifecycle.ts` → `quickCreatePr()` opens a PR | write the number |
| any of those returns a **pre-existing** PR | leave unchanged — it may be a person's |
| docs/202 re-arm clears `pr_status` | clear it too |
| explicit reset (`pr-rearm.ts`) | clear it |
| unarchive's "old PR no longer applies" clearing | clear it |
| sessions predating the column | `NULL` — refuse, and **never backfill from `pr_status`**, which also holds person-opened PRs |

## 3. The merge sequence (req 7, 8, 14, 15, 16, 17)

```
repo-bound only:
 1. flushPendingTurnCommit(...)                                     (req 14, 15)
      · any outcome but "committed" / "nothing-to-commit" → 422
 2. guardMergeSync(git)                                             (req 14, 17)
      · "diverged" → refuse
      · pushed     → refuse: "merge again once its checks report"
      · cancelAutoPush(sessionId) only when the push landed
both kinds:
 3. one live read of the pull request                          (req 7, 8, 16, 17)
 4. merge with expected sha = the head SHA that read returned        (req 16)
 5. awaitMergeHandling(sessionId) before reporting success       (req 10, 11)
```

Steps 1 and 2 are **repo-bound only**: a sandbox session has no ShipIt
auto-commit and owns its own git, so there is nothing to flush and nothing ShipIt
may push.

### One live read, not a cache handoff

The previous revision gated repo-bound merges on the PR status poller's summary.
Round 2 showed that cannot carry the guarantee:

- `forceRefreshSession()` returns `void` and returns silently for an untracked
  session; `pollRepo()` **preserves the previous state** when unauthenticated,
  rate-limited, or handed no repository data. So a "forced" refresh that failed
  leaves `getStatus()` returning a stale green summary — a revoked approval or a
  changed check result evaluated from cache.
- The poll indexes open pull requests by `headRefName`, so two pull requests from
  one branch overwrite each other in a branch-keyed map. The summary is not
  guaranteed to be the recorded pull request at all.
- The summary carries no head SHA, and the poller's model deliberately holds
  **two** — `extractCurrentHeadOid()` (the ref tip) and `extractHeadSha()` (the
  commit whose check rollup was read). Adding a SHA to the summary would also
  mean teaching `prStatusEqual()` about it, or the poller's update gate swallows
  a head change with otherwise identical status.

So the merge does its own read, assembled from parts that already exist —
`buildPrStatusQuery()` focused on the one number, `parsePrNode()`,
`extractCurrentHeadOid()`, `extractHeadSha()` (`pr-status-parser.ts`). One
GraphQL round trip returns checks, `reviewDecision`, draft state and both SHAs
for the pull request the caller named. Nothing is cached, nothing is
branch-keyed, and `PrStatusSummary` is untouched.

The gate then reads:

| Condition | Result |
|---|---|
| the read failed, or the node is missing | refuse — never "no checks" |
| `extractHeadSha() !== extractCurrentHeadOid()` | refuse: the checks describe an older commit (req 16) |
| draft / closed | refuse (req 7) |
| a required check failing | refuse (req 7) |
| checks pending | refuse, naming `--auto` (req 17) |
| **zero** checks, head commit younger than the grace | refuse: "waiting for CI checks to start" |
| **zero** checks, head commit older than the grace | proceed — the repository has no CI |
| `reviewDecision` review_required / changes_requested | refuse (req 8) |

The zero-check split is what `getCheckStatus()` cannot express: it maps both "no
checks configured" *and* a swallowed API failure to `"none"`, and
`agentMergePullRequest()` treats `"none"` as permission to merge. That is a
fail-open defect for **sandbox** merges today, and requirement 7 says the
guardrails apply to every agent merge — so this read replaces `getCheckStatus()`
on both paths, not just the new one. The grace window needs the head commit's
`committedDate` added to the existing query; the deadline reuses the poller's own
grace constant (docs/230).

### Merge at a SHA (req 16)

`PullRequestDetail.head` is a **branch name** (`pr.head.ref`,
`github-auth-prs.ts:705`), and `mergePullRequest()` sends no expected SHA
(`github-auth-prs.ts:167`), so anything advancing the branch between the check
and the merge is merged unchecked. The head SHA from step 3 is passed as the REST
merge's `sha`, and GitHub refuses atomically if the head has moved.

### The flush needs a complete outcome (req 15)

`autoCommit()` has four ways to not commit the turn's work, not two: a detected
secret, a `blocked` unreadable path, **unresolved conflicts or a rebase in
progress** (`commitHash: null`, indistinguishable from a clean tree —
`shared/git.ts:502`), and a non-`blocked` unreadable path that yields a
**partial** commit while logging that content was omitted. So
`flushPendingTurnCommit()` returns a discriminated outcome — `committed` /
`nothing-to-commit` / `blocked-secret` / `blocked-unreadable` /
`blocked-conflict` / `partial-unreadable` — and the merge proceeds on the first
two only. `agentCreatePr()` adopts it too; it has the same two holes today.

### The refusal after a push (req 17)

`guardMergeSync` already says the right thing — *"Pushed N commits that had not
reached GitHub yet … merge again once its checks report."* The agent path appends
one clause: `--auto` arms merge-when-green. The command never waits by itself.

The verdict grows one field, not a taxonomy: `{ action: "hold"; pushed: boolean;
message }`. The caller's only question is whether a synchronous push landed,
because the debounced auto-push may be cancelled **only** then — it is
session-keyed in `services/auto-push-scheduler.ts`, so cancelling one that no
push replaced strands the commit. `push-failed` and `diverged` stay
distinguishable in the message, which nothing branches on.

### `--auto` in a repo-bound session (req 17)

It arms **ShipIt-managed** auto-merge, as the PR card's route does when a runner
is live (`preferManaged`) — the agent's own runner is always live mid-turn, and
GitHub-native auto-merge would land the pull request during a later turn with no
idea one was running. The transcript notice says the agent *armed* merge-when-green;
the eventual merge is ShipIt's own and the managed loop already records it, so
requirement 9's attribution is unaffected — it governs merges the agent performs.

## 4. After the merge (req 9, 10, 11)

- **Settlement before success.** `forceVerifySessionPrState()` records the
  terminal snapshot and merged-head anchor, but the callback that stamps
  `mergedAt` is deliberately not awaited, and the docs/218 reset gate keys off
  `mergedAt`. So the route awaits `awaitMergeHandling(sessionId)` (docs/282)
  before reporting success — otherwise the very next command the agent is told to
  run, `shipit branch reset-to-base`, can still see `not-merged`.
- **The record (req 9).** `emitNoticeInTurn()` from
  `orchestrator/chat-card-persistence.ts` — it routes through `emitChatCard`, so
  it emits, records in-band and persists in one call. No new card type, no
  column, no migration. `logMergePerformed()` stays as the ops-log half.
- **A shippable branch (req 10).** The branch then sits on the merged tip, so the
  post-turn auto-push is refused as stacked on it. With `mergedAt` settled, the
  merge result tells the agent to run `shipit branch reset-to-base` — docs/239's
  own wording. That is the agent's step, so no user action is needed.

## 5. UI (req 1)

One toggle — *Allow agents to merge their own pull requests* — with help text
naming what it permits: this session's own pull request, checks green, branch
protection still enforced by GitHub. It goes in an **"Agent permissions" section
inside the existing Project Settings surface**, not a new tab: one toggle does
not justify an otherwise empty navigation category. It earns a tab when a second
repo-scoped agent permission exists.

## What the reviews changed

| Round | Finding | Change |
|---|---|---|
| 1 | `--repo` retargets the repository | refused on repo-bound merges |
| 1 | current branch is agent-writable | ownership from `session.branch` + `session.prNumber` |
| 1 | `"none"` checks merge immediately | a real status gate (see round 2) |
| 1 | `pr.head` is a branch name | merge at an expected SHA |
| 1 | flush has four failure modes | discriminated outcome |
| 1 | `reviewDecision` had no source | the live read supplies it |
| 1 | extra mechanism | no new endpoint, no `ops-refused`, no new tab |
| 2 | refusing `cwd` breaks every merge | `cwd` ignored, not refused |
| 2 | the poller summary is cached, branch-keyed and SHA-less | one live read instead |
| 2 | two SHAs, and only one is the checked one | refuse unless rollup SHA == head SHA |
| 2 | `prNumber` had no lifecycle | writers, clearers and the no-backfill rule tabled |
| 2 | sandbox merges stayed fail-open | the live read replaces `getCheckStatus()` on both paths |
| 2 | `mergedAt` is not settled at return | `awaitMergeHandling()` before success |
| 2 | `--auto` undecided for repo-bound | managed auto-merge, as the card does |
| 2 | three-value verdict taxonomy | one `pushed` boolean |

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migrations: `repos.allow_agent_merge`, `sessions.pr_number` |
| `src/server/orchestrator/repo-store.ts` | grant read/write, `canonicalRepoKey`-matched |
| `src/server/orchestrator/api-routes-session-repos.ts` | grant on the existing `PATCH /api/repos/:url` |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()`; `--repo` refused, `cwd` ignored |
| `src/server/orchestrator/pr-status-parser.ts` | `committedDate` on the head commit |
| `src/server/orchestrator/services/github.ts` | flush outcome; the live-read gate; both merge paths |
| `src/server/orchestrator/services/branch-sync.ts` | `pushed` on the hold verdict |
| `src/server/orchestrator/github-auth-prs.ts` | expected `sha` on the REST merge |
| `src/server/orchestrator/services/pr-lifecycle.ts`, `pr-rearm.ts`, `sessions.ts` | `prNumber` writers and clearers |
| `src/server/orchestrator/api-routes-github.ts` | gate, ownership, settlement, notice |
| `src/client/components/ProjectSettings.tsx` | Agent permissions section + toggle |
| `src/server/shipit-docs/github.md` | agent-facing text ([draft](./agent-docs.md)) |

## Tests

- `pr-target.test.ts` — dispositions; `--repo` refused and `cwd` ignored on a
  repo-bound merge; the ordinary call (which always carries `cwd`) is allowed.
- `services/github-agent-merge.test.ts` — ownership refusals (foreign number,
  wrong branch, no recorded PR); each flush outcome; the cancel rule; every row
  of the gate table, including rollup-SHA mismatch and both zero-check cases; the
  expected-`sha` merge; `awaitMergeHandling` awaited before success.
- `services/branch-sync.test.ts` — `pushed` true only after a successful push.
- `prNumber` lifecycle tests: written only on `alreadyExisted: false`, cleared by
  each of the three clearing paths, never backfilled.
- `integration_tests/agent-driven-pr.test.ts` — granted / not granted / foreign
  pull request; the notice surviving a history reload.
- The container-route snapshot must not gain the grant route.
- Each new guard proved red on its own before the fix.

## Risks

- **The live read costs one GraphQL round trip per merge attempt**, and the
  advertised loop makes at least two attempts. That is the price of not trusting
  a cache, and it is bounded by the agent's own call rate.
- **The refusal is the common path, by design.** Any turn with an edit ends in a
  push, so the first `gh pr merge` refuses. The agent-facing docs must say so, or
  agents will report a failure instead of merging with `--auto`.
