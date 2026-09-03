---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, flush the turn's work before merging, and decide the merge from one live read.
---

# Agent merge, granted per repository — design

Implements [requirements.md](./requirements.md). Extends
`docs/224-sandbox-merge-capability` (the shim, the route, the guardrails).

> **Revision 8, 2026-09-03.** Seven independent review rounds; every finding
> verified at the source before it was accepted. Round 1 rebuilt the ownership
> check, round 2 replaced the status gate and caught a `cwd` rule that would have
> broken every merge, round 3 replaced the query and the grace window, round 4
> bound provenance to the repository, and round 5 closed a partial-response hole
> and refuted GitHub-native arming — which the user then answered by scoping in a
> ShipIt arming bound to one commit (req 18–21) — which round 6 then scoped to
> repo-bound sessions and made reachable after a restart. See
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
| `POST /api/sessions/:id/pr/quick` opens a PR | write the number |
| `pr-lifecycle.ts` → `quickCreatePr()` opens a PR | write the number |
| any of those returns a **pre-existing** PR | leave unchanged — it may be a person's |
| docs/202 re-arm clears `pr_status` | clear it too |
| explicit reset (`pr-rearm.ts`) | clear it |
| unarchive's "old PR no longer applies" clearing | clear it |
| sessions predating the column | `NULL` — refuse, and **never backfill from `pr_status`**, which also holds person-opened PRs |

`quickCreatePr()` cannot tell the creation cases apart today: it returns the **same
shape** for a pull request it found (`services/github.ts:656`) and one it opened
(`:721`). It gains an `alreadyExisted` discriminator, as `agentCreatePr()`
already has, and both of its callers pass the result through. Without that the
implementation must either record nothing or claim a person's pull request.

**And a write is repository-bound, not just creation-bound.** `agentCreatePr()`
accepts `--repo` and passes the retargeted remote through
(`api-routes-github.ts:320`), so an agent could open a pull request in
repository B and have its number recorded as the ownership number for repository
A — a number that then matches a *different* pull request at merge time. So the
write happens only when
`canonicalRepoKey(created.repoUrl) === canonicalRepoKey(session.remoteUrl)`.
`alreadyExisted: false` alone is not provenance.

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
      · repo-bound: the PR head SHA must equal local HEAD              (req 14)
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

So the merge does its own read: **a small query written for this decision**, not
the poller's. Round 3 showed reuse does not fit — `buildPrStatusQuery()` always
emits the bulk `pullRequests` connection with the number as an extra alias that
only `extractFocusedPrNodes()` can retrieve, `PR_LIGHT_FIELDS` has no `isDraft`,
and `parsePrNode()` fixes `prState` to `"open"`. Coercing `PrStatusSummary` into
an irreversible decision costs more than the fields are worth.

The merge query asks for exactly what the gate needs, by number:

```
pullRequest(number: $n) {
  state isDraft reviewDecision headRefOid
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
}
```

One round trip, one pull request, both SHAs — `headRefOid` (the ref tip) and the
rollup's `commit.oid` (what the checks describe). Nothing is cached, nothing is
branch-keyed, and `PrStatusSummary`, `prStatusEqual()` and the poller are all
untouched.

The selection is deliberately smaller than the first draft's: `number` is what
the caller supplied, `mergeable` is never consulted by the gate, and the rollup's
`contexts` list is bounded — counting a bounded list is how a fail-open gate gets
built. The gate reads `statusCheckRollup.state`, and treats a **null rollup** as
zero checks.

**A null rollup counts only in a response that carries no `errors`.**
`graphqlQuery()` logs non-rate-limit GraphQL errors and still returns the body,
so a partial response can hold `errors` *and* a null rollup — which would read as
"this repository has no CI" and merge. The gate requires an empty `errors` array
and the presence of the fields it decides on, before any of the rows below apply.

The gate then reads:

| Condition | Result |
|---|---|
| the read failed, the node is missing, or the response carries **any** GraphQL `errors` | refuse — never "no checks" |
| rollup `commit.oid !== headRefOid` | refuse: the checks describe an older commit (req 16) |
| repo-bound and `headRefOid !== local HEAD` | refuse: GitHub does not have this session's work (req 14) |
| `state !== "OPEN"`, or `isDraft` | refuse (req 7) |
| a required check failing | refuse (req 7) |
| checks pending | refuse, naming `--auto` (req 17) |
| **null rollup** (zero checks), inside the CI grace | refuse: "waiting for CI checks to start" |
| **null rollup** past that grace | proceed — the repository has no CI |
| `reviewDecision` review_required / changes_requested | refuse (req 8) |

Two rows deserve their reason.

**The zero-check split** is what `getCheckStatus()` cannot express: it maps both
"no checks configured" *and* a swallowed API failure to `"none"`, and
`agentMergePullRequest()` treats `"none"` as permission to merge — a fail-open
defect for **sandbox** merges today. Requirement 7 says the guardrails apply to
every agent merge, so this read replaces `getCheckStatus()` on both paths.
The grace **extends** `CiGraceTracker` rather than calling it as it stands —
round 6 was right that the previous wording claimed reuse for what is really a
second mode. The tracker keys its timer by session and head SHA and returns
`false` immediately when the repository's CI history is unknown, which is correct
for the poller (it will see that repository again) and wrong for a one-shot merge
decision. It gains a merge-specific entry point: keyed by repository, pull
request and head SHA, and treating an unknown history as *start the grace*. An earlier revision derived the window from the head
commit's `committedDate`; round 3 rejected that correctly, since commit time is
not check-registration time.

**It is reached through one new method on `PrStatusPoller`, not called
directly.** Round 4 found why that matters: the tracker is `private` to the
poller, and `shouldForcePending()` is synchronous over state the poller loads
first — the poll loop awaits `ensureWorkflowsLoaded()` before deciding, and a
tracker constructed fresh for the merge route would have none of the sticky
"this repo has CI" signal. So the poller exposes
`awaitCiGraceDecision({ sessionId, repoUrl, repoKey, prNumber, headSha, headBranch, baseBranch })`
— `prNumber` explicitly, because that is what makes the key repository + pull
request + SHA rather than session + SHA —
which does the preload and then the existing call. One grace implementation, one
caller-visible answer.

Both differences come from round 5 and stand: two pull requests can legitimately
share a commit SHA, so a session+SHA key is not enough; and for an irreversible
decision, "no CI history" means wait rather than proceed.

**The local-HEAD row** is the half `guardMergeSync()` cannot cover. That guard
compares local HEAD with the remote-*tracking* ref and, by design, **proceeds
whenever it cannot tell** (no tracking ref, HEAD elsewhere, unreachable remote) —
right for the merge button, wrong for an irreversible act. Comparing the live
`headRefOid` with the local HEAD this call just committed is the direct
statement of requirement 14, and it fails closed.

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

### `--auto`: a ShipIt arming, bound to one commit (req 18–21)

`--auto` does **not** use GitHub's own merge-when-green. Round 5 refuted that:
`expectedHeadOid` is a precondition checked when the arming is *enabled*, not a
binding on the merge GitHub later performs, and GitHub keeps an arming alive
across a push by anyone with write access. So a native arming can land a commit
the agent never authorised, and withdrawing the grant cannot cancel it. The
existing ShipIt-managed loop is no better on its own: `AutoMergeState` holds
neither a pull-request number nor a SHA, and it selects through the poller's
branch-keyed map.

**Repo-bound sessions only.** Round 6 found the arming cannot describe a sandbox
at all — a sandbox has no `session.remoteUrl`, may target several repositories,
is not tracked by the repository poller, and is governed by `dangerousGitHubOps`
rather than the repository grant. Requirement 12 already settles what to do:
sandbox behaviour does not change, so a sandbox `--auto` keeps today's native
arming and none of this section applies to it.

```sql
CREATE TABLE agent_merge_armings (
  session_id   TEXT PRIMARY KEY,   -- one arming per session; a session has one PR
  repo_key     TEXT NOT NULL,      -- canonicalRepoKey of the repo-bound session's remote
  pr_number    INTEGER NOT NULL,
  expected_sha TEXT NOT NULL,      -- the head the live read returned
  method       TEXT NOT NULL,      -- merge | squash | rebase
  last_error   TEXT                -- surfaced once, not every tick
);
CREATE INDEX idx_agent_merge_armings_repo ON agent_merge_armings(repo_key);
```

Keyed by session, so a second `--auto` replaces the first rather than
accumulating. There is deliberately no `armed_at`: nothing times an arming out,
and a column no code reads is a column that will drift.

**One remote gate, two callers with their own predicates.** The GraphQL read and
the refusal table are shared; the caller-specific part is not, and round 6 was
right that calling it "the same gate" hid that. The direct path runs mid-turn
with a worktree and compares the live head with **local HEAD**. The executor runs
post-turn, may have no worktree at all after a restart, and compares the live
head with its durable **`expected_sha`**. Same remote read, one predicate each.

If the head no longer matches, the arming is **deleted** and a persisted notice
says so (req 19). It is never re-pointed at the new head, because nothing
authorised that commit. Otherwise the merge goes out with that SHA as the REST
merge's expected `sha` (req 18).

**Keeping the executor reachable (req 21).** Durability is not enough on its own:
the polling supervisor iterates `tracker.sessionRepos`, and the global gate opens
only for in-memory automation, so after a restart with no viewer a persisted
arming would never receive a tick. So armings are a **first-class input to the
supervisor and the global gate** — loaded at startup, `ensure()`d when one is
written, and their repository ticked even when no ordinarily tracked session
would keep polling alive.

**But not before in-flight turns are adopted.** `trackSession()` polls
immediately when the gate is open, and the poller exists before
`reattachInFlightTurns()` has run — so activating armings at construction could
merge a session's pre-turn head while a surviving turn still holds uncommitted
work. Armings are therefore **loaded** at startup and **activated** only after
reattachment completes.

**Serialisation, stated honestly.** Order matters here, and round 7 corrected it:
`PostTurnHold.begin()` only increments a counter — it neither waits for existing
work nor blocks turn admission — so the lease alone would let the executor fire
during the very turn that armed it. So the executor:

1. refuses while `runner.agentBusy || runner.systemTurnInProgress`, the same
   precheck the managed performer makes;
2. then takes the post-turn lease (conditional: there may be no runner at all
   after a restart) and holds it across the final arming re-read, the grant
   re-read and the REST call;
3. and one in-flight flag per session makes it exclusive with the managed
   auto-merge loop.

That is what the design can promise, and it is **not** an absolute "never while
working": the managed performer documents that a turn can begin after the busy
check while a merge request is in flight, and the same is true here. The SHA
precondition protects the *commit*; the precheck and lease narrow, but do not
eliminate, the overlap with a turn.

**Revocation is local, which is the point (req 20).** Turning
`allow_agent_merge` off deletes every arming whose `repo_key` matches — one
statement in the same transaction as the flag, resolved by `canonicalRepoKey`, so
every URL spelling of that repository is covered. No network call can fail and
leave GitHub armed while ShipIt reports the permission off, which is exactly what
the native path could not avoid. The executor re-reads both the arming row and
the grant immediately before merging, so a revocation that lands first wins. The
residual window is one HTTP call wide, and what lands in it is still the commit
the agent was authorised to merge.

**Deleting the row on success — after settlement, not at the response.** The
arming may be the only thing holding the global polling gate open, and the
managed loop deliberately keeps a `completed` marker until the terminal PR state
is observed for exactly this reason. So a successful REST response marks the
arming **settling**, and it is deleted only once `forceVerifySessionPrState()`
has seen the terminal state and `awaitMergeHandling()` has settled — otherwise
the gate can close before the card, `mergedAt` and the reset eligibility do
(req 10, 11).

**Clearing.** On a settled merge; on a head that no longer matches; when the
pull request closes; on **archive** and on hard delete or full reset (a foreign
key with `ON DELETE CASCADE`, plus the explicit archive hook — round 6 correctly
rejected `untrackSession()`, which has no production lifecycle caller); on the
docs/202 re-arm and the reset and unarchive clears that also drop `pr_number`;
on repository removal; and on revocation.

**Two failure modes the executor must handle**, both round 6's:

- **No runner to emit through.** `emitNoticeInTurn()` needs one, and a post-turn
  or post-restart executor may have none. Its notices go through
  `persistNoticeUnattached()`, which exists for exactly this case, so the record
  persists either way.
- **A crash between GitHub accepting the merge and the row being deleted.** On
  the next tick the pull request reads as closed/merged, and naively deleting the
  arming would destroy the only evidence — requirement 9 asks for a record. So a
  terminal reconciliation records first, *then* deletes. **What it may claim is
  narrower than what a witnessed merge claims**, and round 7 was right to insist
  on the difference: finding `expected_sha` merged proves the agent *authorised*
  that commit, not that ShipIt performed the merge — a user, the card, or
  GitHub-native auto-merge could have landed the same SHA, and
  `merge-attribution.ts` already documents that this race cannot honestly name
  the performer. So recovery records "the agent armed this commit, and it is now
  merged"; only a witnessed successful REST response records "the agent merged
  it".

**A user's own auto-merge is untouched** — different record, different loop, and
the repository grant does not govern it (req 20).

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
| 3 | the poller's query/parser does not fit (no `isDraft`, bulk shape, fixed state) | a small merge-only query instead of reuse |
| 3 | `committedDate` is not a check-registration clock | reuse `CiGraceTracker`, delete the heuristic |
| 3 | `quickCreatePr()` cannot tell "found" from "opened" | give it `alreadyExisted`; add the `/pr/quick` writer |
| 3 | `guardMergeSync()` proceeds when it cannot tell | compare the live PR head with local HEAD, fail closed |
| 3 | managed `--auto` is session-bound and SHA-less | native arming only; refuse with GitHub's reason |
| 4 | `--repo` could record a foreign PR as the session's | provenance write requires a canonical-repo match |
| 4 | the grace tracker is private and needs a preload | one `awaitCiGraceDecision()` facade on the poller |
| 4 | a native arming outlived the permission | `expectedHeadOid`, recorded arming, cancelled on revocation — **refuted in round 5** |
| 4 | the merge query asked for more than the gate uses | `number`, `mergeable` and `contexts` dropped |
| 5 | `expectedHeadOid` binds the arming, not the merge | `--auto` is a ShipIt arming bound to one commit (user decision, req 18–21) |
| 5 | a partial GraphQL response reads as "no CI" | any `errors` refuses, before the gate table applies |
| 5 | the CI grace was keyed by session + SHA | keyed by repository + PR + SHA; unknown CI starts the grace |
| 6 | a persisted arming would never get a tick | armings feed the polling supervisor and global gate |
| 6 | the arming cannot describe a sandbox | armings are repo-bound only; sandbox keeps today's behaviour (req 12) |
| 6 | "never while working" was absolute | a lease and a per-session in-flight flag, with the residual overlap stated |
| 6 | `untrackSession()` is not a lifecycle hook | clear on archive, delete and full reset instead |
| 6 | a crash could erase the merge record | terminal reconciliation records, then deletes |
| 6 | `armed_at` had no consumer | dropped from the schema |
| 7 | armings could execute before in-flight turns were adopted | loaded at startup, activated after reattachment |
| 7 | the lease does not block turn admission | an explicit busy precheck before the lease |
| 7 | recovery could not honestly claim who merged | recovery records the authorisation, not the performance |
| 7 | deleting on the REST response could close the polling gate | a settling state, deleted after settlement |
| 7 | the grace facade omitted the PR number | `prNumber` passed explicitly |

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migrations: `repos.allow_agent_merge`, `sessions.pr_number`, `agent_merge_armings` |
| `src/server/orchestrator/agent-merge-armings.ts` | the arming store: arm, read, delete by session / repo / cascade |
| `src/server/orchestrator/ci-grace-tracker.ts` | a merge-specific entry point (repo + PR + SHA; unknown history waits) |
| `src/server/orchestrator/pr-polling-supervisor.ts`, `polling-global-gate.ts` | armings as a polling input, so a restart still executes them |
| `src/server/orchestrator/repo-store.ts` | grant read/write, `canonicalRepoKey`-matched |
| `src/server/orchestrator/api-routes-session-repos.ts` | grant on the existing `PATCH /api/repos/:url` |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()`; `--repo` refused, `cwd` ignored |
| `src/server/orchestrator/services/github.ts` | flush outcome; the merge-gate query + gate; both merge paths; `quickCreatePr()` gains `alreadyExisted` |
| `src/server/orchestrator/pr-status-poller.ts` | `awaitCiGraceDecision()` facade over the private `CiGraceTracker` |
| `src/server/orchestrator/github-auth-prs.ts` | expected `sha` on the REST merge |
| `src/server/orchestrator/pr-status-poller.ts` | the arming executor, in the existing tick, behind the docs/266 busy gate |
| `src/server/orchestrator/services/branch-sync.ts` | `pushed` on the hold verdict |
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
