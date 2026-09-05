---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, flush the turn's work before merging, and decide every merge from one live read at an exact commit. Merge-when-checks-pass is docs/288.
---

# Agent merge, granted per repository — design

Implements [requirements.md](./requirements.md). Extends
`docs/224-sandbox-merge-capability` (the shim, the route, the guardrails).

## What changes, in one line

`mergeDisposition()` stops asking "is this a sandbox?" and starts asking "may an
agent merge here?" — the repo-bound path flushes the turn's work first, every
merge is decided by one live read of the pull request, and it lands at the exact
commit that read described.

## 1. Storage — the grant (req 1, 2, 3)

A column on the `repos` table, copying `repos.trusted` (docs/178) — the
per-repository boolean this feature is a second instance of:

```sql
ALTER TABLE repos ADD COLUMN allow_agent_merge INTEGER NOT NULL DEFAULT 0
```

Appended migration, and unlike `trusted` there is **no backfill**: every
repository starts off (req 2). Reads and writes live on `RepoStore`
(`orchestrator/repo-store.ts`) beside `isTrusted()` / `setTrusted()`.

**Matched on a GitHub repository identity, not on `canonicalRepoKey()`.** That
helper exists to spot a near-duplicate row in the repo list, and it is not strong
enough to carry a permission: it lowercases only the scheme and host, leaves the
*path* casing alone, and sends anything that is not a parseable URL — every
SCP-style `git@github.com:owner/repo.git` — down a lowercase-the-whole-string
fallback (`git-utils.ts:139`). So these three spellings of one repository produce
three different keys:

```
https://github.com/Owner/Repo
https://github.com/owner/repo
git@github.com:owner/repo.git
```

A grant stored under one and read under another silently does nothing — and the
same split would reach provenance and the durable claim. This feature therefore
resolves a remote to a parsed **`owner/repo`**, case-normalised (GitHub treats
both parts case-insensitively), and uses `github:<owner>/<repo>` as the key
everywhere the permission is written, read, or compared. `canonicalRepoKey()`
keeps its existing job and is not touched.

**`repoId()` parses strictly, and refuses what it cannot parse.** The existing
convenience regex is not a model to copy: it is unanchored, so `github.com` can
match inside another host's path, and its `[^/.]+` repository group truncates a
legal name at the first dot (`git-utils.ts:480`). The contract is: accept only
the supported remote forms — `https://github.com/<owner>/<repo>` and
`git@github.com:<owner>/<repo>` — with the authority **exactly** GitHub; strip
only a terminal `.git`; preserve every legal owner and repository character,
dots included; and **reject** anything else rather than degrade to a best-effort
string. A remote that cannot be parsed has no identity, so no grant applies to
it, which fails closed.

**No new endpoint.** The flag joins the existing browser-only
`PATCH /api/repos/:url` (which already takes `hidden` and `colorIndex` and
broadcasts `repo_list`) and rides the `RepoInfo` projection to the client. It is
**server-authoritative and container-inaccessible**: the browser reads it to
render the toggle, the container never sees or sets it. That route carries no
`containerAccessible` opt-in, so the golden container-route table is the guard
(req 3).

**Rejected: `shipit.yaml`.** The agent can write that file, so a permission
declared there is one it can grant itself. Receipt in requirements.md.

## 2. The gate (req 4, 5, 6, 12, 13)

`mergeDisposition()` gains one branch and keeps `not-sandbox` for ops sessions —
requirement 13 says their behaviour does not change:

| Session | Decision |
|---|---|
| `kind === "sandbox"` | as today — `dangerousGitHubOps` decides (req 12) |
| `kind === "ops"` | `not-sandbox`, unchanged wording (req 13) |
| repo-bound | the repository's `allow_agent_merge` decides (req 4, 6) |

`not-granted-repo` is the one new disposition: *"Agents cannot merge in this
repository. The user turns this on in Project Settings."* (req 6)

### Ownership: a server-derived tuple (req 5)

Comparing pull-request numbers proves nothing, because a number is only unique
inside a repository. Ownership is decided from state the agent cannot write:

- **Repository** — `session.remoteUrl`. A repo-bound merge **refuses `--repo`**,
  which otherwise retargets the whole operation (`resolvePrTarget()` returns
  early on a parsed `--repo`, `pr-target.ts:106`).
- **Working tree** — the session root. `cwd` is **ignored, not refused**: the
  shim sends it on *every* call (`targetBody()` includes `deps.cwd`, which
  `runShim` defaults to `process.cwd()`), so refusing it would reject the
  feature's own happy path. `resolvePrTarget()` already ignores it when no
  `--repo` is given.
- **Branch** — `session.branch`, the server-side record. Before any git mutation
  the route requires `git.currentBranchOrNull() === session.branch` —
  `currentBranchOrNull`, never `getCurrentBranch`, which returns `"main"` on a
  detached HEAD (`shared/git.ts:670`).
- **Pull request** — `session.prNumber` with `session.prRepoId`. The requested
  number must equal it, the identity must equal `repoId(session.remoteUrl)`
  at merge time, and an absent value **refuses**.

Failing closed is deliberate, and is the opposite of `guardMergeSync`, where
"cannot tell" correctly proceeds: there the fallback is the status quo, here it
is a merge.

### The `prNumber` lifecycle

A recorded number is a **provenance claim**, so only a pull request ShipIt itself
opened may write it — otherwise it grants ownership of a person's pull request,
which requirement 5 excludes by name.

| Event | Effect on `sessions.pr_number` / `pr_repo_id` |
|---|---|
| `agentCreatePr()` returns `alreadyExisted: false` | write, if the created repo matches |
| `POST /api/sessions/:id/pr` opens a PR | write, if the created repo matches |
| `POST /api/sessions/:id/pr/quick` opens a PR | write, if the created repo matches |
| `pr-lifecycle.ts` → `quickCreatePr()` opens a PR | write, if the created repo matches |
| any of those returns a **pre-existing** PR | leave unchanged — it may be a person's |
| docs/202 re-arm clears `pr_status` | clear both |
| explicit reset (`pr-rearm.ts`) | clear both |
| unarchive's "old PR no longer applies" clearing | clear both |
| the session's `origin` is changed | clear both |
| sessions predating the columns | `NULL` — refuse, and **never backfill from `pr_status`**, which also holds person-opened PRs |

`quickCreatePr()` cannot tell the creation cases apart today: it returns the
**same shape** for a pull request it found (`services/github.ts:656`) and one it
opened (`:721`). It gains an `alreadyExisted` discriminator, as `agentCreatePr()`
already has, and both of its callers pass the result through. Without that the
implementation must either record nothing or claim a person's pull request.

**A create that crashes records nothing, and that is the safe answer.** GitHub
creates the pull request before `agentCreatePr()` returns, so a crash in between
leaves a real pull request with no provenance, and the session cannot merge it.
An earlier draft tried to recover that case with a nonce written into the pull
request's body — which does not work: the agent can edit the body of any pull
request through the shim, so a nonce is copyable into a person's pull request and
adoption would hand the agent exactly what requirement 5 forbids. **Only a
witnessed create records provenance.** A pull request found rather than created
is never adopted, whatever evidence it appears to carry. Recovering that crash is
not a requirement; if it becomes one, it needs evidence an agent cannot write.

**"If the created repo matches" is load-bearing twice over.** `agentCreatePr()`
accepts `--repo` and passes the retargeted remote through
(`api-routes-github.ts:320`), so a pull request opened in repository B could
otherwise be recorded as the ownership number for repository A. And
`session.remoteUrl` is not fixed — replacing `origin` updates `sessions.remote_url`
in place — while numbers, branch names and even SHAs can coincide across forks.
Hence two defences, so that a missed clear can never become an authorisation:
the write requires
`repoId(created.repoUrl) === repoId(session.remoteUrl)`, and
`pr_repo_id` is stored with the number and re-checked at merge time.

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
 3. one live read of the pull request → a structured observation (req 7, 8, 16)
 4. claim durably, merge at the observed SHA, settle        (req 9, 10, 11, 17)
```

Steps 1 and 2 are **repo-bound only**: a sandbox session has no ShipIt
auto-commit and owns its own git, so there is nothing to flush and nothing ShipIt
may push.

### One live read, not a cache handoff

The poller's summary cannot carry this decision. `forceRefreshSession()` returns
`void` and returns silently for an untracked session, and `pollRepo()` preserves
the previous state when unauthenticated, rate-limited or handed no repository
data — so a "forced" refresh that failed leaves `getStatus()` returning a stale
green summary. The poll also indexes open pull requests by `headRefName`, so two
pull requests from one branch overwrite each other, and the summary carries no
head SHA while the poller's own model deliberately holds two.

Nor does the poller's *query* fit: `buildPrStatusQuery()` emits the bulk
`pullRequests` connection with a number only as an alias, `PR_LIGHT_FIELDS` has
no `isDraft`, and `parsePrNode()` fixes `prState` to `"open"`.

So the merge does its own read, written for this decision:

```
pullRequest(number: $n) {
  state isDraft reviewDecision headRefOid
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
}
```

One round trip, one pull request, both SHAs — `headRefOid` (the ref tip) and the
rollup's `commit.oid` (what the checks describe). Nothing is cached, nothing is
branch-keyed, and `PrStatusSummary`, `prStatusEqual()` and the poller are
untouched. The selection is deliberately minimal: `number` is what the caller
supplied, `mergeable` is never consulted, and the rollup's `contexts` list is
bounded — counting a bounded list is how a fail-open gate gets built.

### The read returns an observation, and the observation decides

The read produces a **structured observation**, not a bare boolean, so that the
refusals can each say the right thing — and so that
`docs/288-agent-merge-arming` can attach a second behaviour to the same facts
without a second read:

| Observation | Result |
|---|---|
| read failed, node missing, or any GraphQL `errors` | refuse |
| rollup `commit.oid !== headRefOid` | refuse (req 16) |
| repo-bound and `headRefOid !== local HEAD` | refuse (req 14) |
| `state !== "OPEN"`, or `isDraft` | refuse (req 7) |
| the rollup is not `SUCCESS` and not pending — any reported check failing, errored or actioned | refuse (req 7) |
| `reviewDecision` review_required / changes_requested | refuse (req 8) |
| **null rollup** (zero checks) inside the CI grace | refuse: waiting for checks to start |
| checks **pending** | refuse (req 17) |
| checks passed, or null rollup past the grace | merge now |

**`--auto` is not part of this feature.** A repo-bound `--auto` is refused with a
message naming `docs/288-agent-merge-arming`; sandbox `--auto` keeps today's
behaviour (req 12).

**Any GraphQL `errors` refuses before anything else applies.** `graphqlQuery()`
logs non-rate-limit errors and still returns the body, so a partial response can
hold `errors` *and* a null rollup — which would read as "this repository has no
CI" and merge.

**The zero-check split** is what `getCheckStatus()` cannot express: it maps both
"no checks configured" and a swallowed API failure to `"none"`, and
`agentMergePullRequest()` treats `"none"` as permission to merge — a fail-open
defect for **sandbox** merges today. Requirement 7 says the guardrails apply to
every agent merge, so this read replaces `getCheckStatus()` on both paths.

**The grace extends `CiGraceTracker`** rather than calling it as it stands. The
tracker keys its timer by session and head SHA and returns `false` immediately
when a repository's CI history is unknown — correct for the poller, which will
see that repository again, and wrong for a one-shot decision. It gains a
merge-specific entry point keyed by **repository, pull request and head SHA**
(two pull requests can share a commit), where an unknown history *starts* the
grace. It is reached through one new poller method,
`awaitCiGraceDecision({ sessionId, repoUrl, repoKey, prNumber, headSha, headBranch, baseBranch })`,
because the tracker is private to the poller and its decision depends on state
the poll loop preloads with `ensureWorkflowsLoaded()`.

**The local-HEAD row** is the half `guardMergeSync()` cannot cover: that guard
compares local HEAD with the remote-*tracking* ref and, by design, proceeds
whenever it cannot tell. Comparing the live `headRefOid` with the local HEAD this
call just committed is the direct statement of requirement 14, and it fails
closed.

### Merge at a SHA (req 16)

`PullRequestDetail.head` is a **branch name** (`pr.head.ref`,
`github-auth-prs.ts:705`), and `mergePullRequest()` sends no expected SHA
(`github-auth-prs.ts:167`), so anything advancing the branch between the check
and the merge is merged unchecked. The observed `headRefOid` is passed as the
REST merge's `sha`, and GitHub refuses atomically if the head has moved.

### The flush needs a complete outcome (req 15)

`autoCommit()` has four ways to not commit the turn's work, not two: a detected
secret, a `blocked` unreadable path, **unresolved conflicts or a rebase in
progress** (`commitHash: null`, indistinguishable from a clean tree —
`shared/git.ts:502`), and a non-`blocked` unreadable path that yields a
**partial** commit while logging that content was omitted. So
`flushPendingTurnCommit()` returns a discriminated outcome — `committed` /
`nothing-to-commit` / `blocked-secret` / `blocked-unreadable` /
`blocked-conflict` / `partial-unreadable` — and the merge proceeds on the first
two only.

`agentCreatePr()`'s own behaviour is **not** changed here. It adapts to the new
return type and nothing more: its conflict and partial-unreadable handling may
deserve attention, but requirement 15 is about merging, and this feature is not
where that gets decided.

### The refusal after a push (req 17)

`guardMergeSync` already says the right thing — *"Pushed N commits that had not
reached GitHub yet … merge again once its checks report."* The agent path appends
one clause: merge again once the checks report. The command never waits by
itself.

The verdict grows one field, not a taxonomy: `{ action: "hold"; pushed: boolean;
message }`. The caller's only question is whether a synchronous push landed,
because the debounced auto-push may be cancelled **only** then — it is
session-keyed in `services/auto-push-scheduler.ts`, so cancelling one that no
push replaced strands the commit.

## 4. The durable claim, and settlement (req 9, 10, 11)

A merge is claimed **durably before the REST call**, and the claim survives until
its record is written:

```sql
CREATE TABLE agent_merge_claims (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  repo_id      TEXT NOT NULL,      -- github:<owner>/<repo>, case-normalised
  pr_number    INTEGER NOT NULL,
  expected_sha TEXT NOT NULL,      -- the head the live read observed
  state        TEXT NOT NULL       -- merging | settling
);
```

The claim is **turn-owned, and the route must prove it** rather than assume it.
Today it cannot: the merge route is `containerAccessible`, the worker injects
only a session id, the container guard checks route opt-in and session ownership
but never an active turn — and an existing integration test calls the endpoint
with no live turn at all. So a process inside the container could merge after its
turn ended, or during a later turn, attaching its flush, its claim and its
transcript record to the wrong one.

So the route **requires an active turn on the session's runner, and holds that
turn's identity for the length of the request**. A request arriving with no
active turn is refused; a claim whose turn is no longer the active one is not
settled
into that session's state. `runner.running` alone is not enough — it is a mutable
boolean that says something is running, not that *this* request belongs to it.
(`docs/288-agent-merge-arming` extends this table for merges ShipIt performs on
its own, which have no owning turn and need admission exclusion instead.)

**A merge attempt has three outcomes, not two.** The REST call is a plain
`fetch`, which can reject *after* GitHub accepted the request — so "it threw"
does not mean "it did not merge", and treating it as a failure would discard the
record of a merge that already happened:

| Outcome | What it means | The row |
|---|---|---|
| **witnessed success** | a parsed response saying the merge landed | → `settling` |
| **definitive refusal** | GitHub answered no — conflict, protection, moved head | deleted; the reason reaches the agent |
| **indeterminate** | a transport error, a timeout, an unparseable body | stays `merging` |

**The adapter has to be able to say which.** Today it cannot: the merge wrapper
collapses every non-2xx response *and* every thrown transport error into one
`success: false`, so "GitHub refused" and "we never heard back" are the same
value. It gains a typed three-way result, and the same treatment applies to the
create adapter, where the distinction decides whether a create intent is cleared
or kept.

A `merging` row — an indeterminate outcome, or a crash — is resolved from its own
tuple: read that pull request in that repository and ask whether `expected_sha`
merged. Merged ⇒ `settling`; still open ⇒ deleted. Nothing is decided from the
shape of the error.

**Recovery is part of this feature, not a later one**, and it has to be careful
about two things.

*It must not race the turn it belongs to.* Reattachment re-establishes ownership
and listeners and then returns — the adopted turn keeps running afterwards, still
editing and still pushing. Settling behind its back could mark the session merged
and delete its remote branch mid-turn. So reconciliation of a session's claim
**waits for that session to have no active turn**, and a later turn does not
start while its settlement is unresolved.

*It must be retryable.* A transient GitHub or authentication failure must not
strand a row until the next process restart. Reconciliation therefore runs from
three triggers, all cheap and all inside this feature: once at startup, at the end
of any turn on that session, and when the session is next activated. No polling
integration is required, because a direct claim never waits for anything external
— it is created inside a turn and resolved as soon as that turn is over.
(`docs/288-agent-merge-arming` adds rows that *do* wait, and with them the
polling-supervisor and global-gate work that keeps them reachable.)

### Settlement

Settlement never calls `forceVerifySessionPrState()`. That resolves the *current*
tracker repository and the *current* branch, and the lookup beneath it picks the
latest pull request **by branch**, not by number — so a re-arm or an unarchive
inside the same repository is enough to make it settle the wrong pull request.
Nor does it use `awaitMergeHandling()`: a one-shot verification that still reads
the pull request as open creates no merge handling at all, so the await resolves
immediately and the command could report success before `merged_at` existed.

Instead, a performed merge is recorded from **what was witnessed**. The merge
response says the merge happened and at which commit, and the row says which pull
request in which repository. Settlement then runs **one canonical
terminal-promotion operation, addressed by pull-request number**, supplied with
the complete pull-request facts it needs — the promotion that builds the
persisted card needs URL, title, body, base, branch and diff statistics; the
notification needs URL, title and branch; the reset anchor needs the head SHA;
the issue lifecycle needs the body. The merge response carries none of that, so
settlement fetches those facts for that number before promoting. It is the same
operation `verifyMissingPr` reaches on detection, and it leaves `merged_at`, the
merged snapshot, `mergedHeadSha` and reset eligibility exactly as a detected
merge does — which is what requirement 11 asks for.

**Every settlement effect is retry-safe, and the promotion must be re-entered.**
Two separate hazards. First, "record, then delete" is not crash-idempotent on its
own: transcript notices get random ids, so a crash between the append and the
delete would produce a second notice on recovery.

Second — and this one changes existing behaviour — the terminal promotion is
**not** crash-reentrant today. It persists the terminal pull-request snapshot
first, derives `alreadyTerminal` from that persisted state, and writes
`mergedHeadSha`, `merged_at` and the downstream merge handling **later and only
when `!alreadyTerminal`**. A crash in between therefore suppresses those writes
permanently on restart, which would leave requirements 10 and 11 unmet with no
way to notice. So a durable `settling` row **re-enters** terminal promotion even
when `pr_status` already reads terminal, and each required effect is idempotent
or durably checkpointed before the row is deleted. So
the merge record carries a **stable natural identity** —
`agent-merge:<repo_id>#<pr_number>@<expected_sha>` — and settlement is idempotent
on it; the promotion, the lifecycle callbacks and the notification keep their
existing fire-once behaviour. Only after settlement is written is the row
deleted — deleting it at the REST response would leave a crash in that window
with no record that a merge had happened at all.

**What the record may claim.** A witnessed REST success records *"the agent
merged it"*. Recovery that finds `expected_sha` already merged records something
narrower — *"the agent armed this commit, and it is now merged"* —
because a user, the card, or GitHub's own auto-merge could have landed the same
commit, and `merge-attribution.ts` documents that this race cannot honestly name
the performer.

**Where the notice goes.** `emitNoticeInTurn()` needs a runner, and a post-turn
or post-restart performer may have none, so notices go through
`persistNoticeUnattached()`. `logMergePerformed()` stays as the ops-log half.

**Session state is guarded by the whole tuple.** Any write to the *session* —
its card, its reset eligibility — requires the session's current `pr_repo_key`
**and** `pr_number` to still equal the row's. If either has moved on, the merge
is still recorded against the row and the session is left alone.

**A shippable branch (req 10).** After the merge the branch sits on the merged
tip, so the post-turn auto-push is refused as stacked on it. With `merged_at`
settled, the merge result tells the agent to run `shipit branch reset-to-base`
— docs/239's own wording. That is the agent's step, so no user action is needed.

**A user's own auto-merge is untouched** — different record, different loop, and
the repository grant does not govern it.

## 5. UI (req 1)

One toggle — *Allow agents to merge their own pull requests* — with help text
naming what it permits: this session's own pull request, checks green, branch
protection still enforced by GitHub. It goes in an "Agent permissions" section
inside the existing Project Settings surface, not a new tab: one toggle does not
justify an otherwise empty navigation category.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migrations: `repos.allow_agent_merge`, `sessions.pr_number` + `pr_repo_id`, `agent_merge_claims` |
| `src/server/orchestrator/agent-merge-claims.ts` | the claim store, the turn identity, and the merge record's natural identity |
| `src/server/orchestrator/services/agent-merge-settlement.ts` | settlement and the three reconciliation triggers |
| `src/server/orchestrator/repo-store.ts` | grant read/write, keyed by the GitHub repository identity |
| `src/server/orchestrator/git-utils.ts` | `repoId()` — parsed, case-normalised `github:<owner>/<repo>`; `ownerRepoFromRepoId()` inverts it; `parseGitHubRemote()` no longer truncates a dotted repository name |
| `src/server/orchestrator/api-routes-session-repos.ts` | grant on the existing `PATCH /api/repos/:url` |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()`; `--repo` refused, `cwd` ignored |
| `src/server/orchestrator/services/github.ts` | flush outcome; the merge-gate read and observation; both merge paths; `quickCreatePr()` gains `alreadyExisted` |
| `src/server/orchestrator/github-auth-prs.ts` | expected `sha` on the REST merge; typed three-way merge and create outcomes |
| `src/server/orchestrator/pr-status-poller.ts` | `awaitCiGraceDecision()`; the canonical, re-enterable terminal promotion, with the caller's `guard` asked between the read and the first write; `readPrByNumber()` for the promote-nothing case |
| `src/server/orchestrator/services/agent-merge-settlement.ts` | settlement, the three reconciliation triggers, and `captureTurn()` — the in-memory turn token (runner identity + epoch) a witnessed settlement is checked against |
| `src/server/orchestrator/ci-grace-tracker.ts` | a merge entry point (repo + PR + SHA; unknown history waits) |
| `src/server/orchestrator/services/branch-sync.ts` | `pushed` on the hold verdict |
| `src/server/orchestrator/services/merge-gate.ts` | the merge-only read, the observation, and the decision table |
| `src/server/orchestrator/services/pr-provenance.ts` | the one provenance path: witnessed creates only, repository matched by identity |
| `src/server/orchestrator/services/pr-lifecycle.ts`, `pr-rearm.ts`, `services/git.ts`, `sessions.ts` | provenance writers and clearers |
| `src/server/orchestrator/api-routes-github.ts` | gate, ownership, settlement, notice |
| `src/client/components/ProjectSettings.tsx` | Agent permissions section + toggle |
| `src/server/shipit-docs/github.md` | agent-facing text: the grant, what may be merged, the commit-and-push step, and the guardrails |

## Tests

- `pr-target.test.ts` — dispositions; `--repo` refused and `cwd` ignored on a
  repo-bound merge; the ordinary call (which always carries `cwd`) is allowed.
- `services/merge-gate.test.ts` — every row of the observation table, and the
  read's unreadable shapes including a 200 carrying `errors` beside data.
- `services/github-agent-merge.test.ts` — the sandbox path on the new read,
  including the two states its old `getCheckStatus()` gate could not tell apart:
  a repository with no CI, and a read that failed.
- `pr-target.test.ts` — ownership refusals (foreign number, wrong branch, no
  recorded PR, moved repository).
- `integration_tests/agent-driven-pr.test.ts` — each flush outcome, the cancel
  rule, the expected-`sha` merge, and the `--auto` refusal.
- `agent-merge-claims.test.ts` — the three outcomes, and reconciliation of a
  `merging` row from its own tuple after an indeterminate result or a crash.
- Settlement tests — idempotence on the natural identity (a repeated settlement
  produces one notice); the promoted state matching a detected merge; and a crash
  between the terminal snapshot and the later writes, proving the restart still
  lands `merged_at`, `mergedHeadSha` and reset eligibility.
- `services/branch-sync.test.ts` — `pushed` true only after a successful push.
- Provenance lifecycle tests: written only on `alreadyExisted: false` with a
  matching repository, cleared by each clearing path, never backfilled.
- `integration_tests/agent-driven-pr.test.ts` — granted / not granted / foreign
  pull request; the notice surviving a history reload.
- `git-utils.test.ts` — `repoId()` collapses the https/SSH/casing spellings that
  `canonicalRepoKey()` does not.
- Provenance — only a witnessed create records it; a discovered pull request never
  does, on any path, including `pr-lifecycle.ts`'s poller discovery.
- Turn ownership — the merge route refuses with no active turn, and a claim whose
  turn is no longer active does not write session state. The existing integration
  test that calls the endpoint with no live turn must be updated to expect that.
- Reconciliation — a surviving row resolves at startup, at end of turn, and on
  activation; and it does not settle while that session has an active turn.
- The container-route snapshot must not gain the grant route.
- Each new guard proved red on its own before the fix.

## What is built, and what is not

All seventeen requirements are implemented.

Two deliberate deviations from this document, both narrowing:

- **The CREATE adapter keeps its boolean result.** §4 asks for a typed
  three-way outcome on the merge *and* the create adapters, on the grounds that
  the distinction decides whether a create intent is cleared or kept. That
  intent table was deleted earlier in this feature — provenance is
  witnessed-create-only — so the create side has no consumer for the
  distinction, and adding one would be mechanism nothing reads. The merge
  adapter has it, because the claim genuinely turns on it.
- **A later turn is not blocked while a settlement is unresolved.** §4 asks for
  that as the second half of "reconciliation must not race the turn". The first
  half is built and is the one that protects correctness: reconciliation stands
  down for any active turn. The second would mean holding a user's next message
  behind a GitHub round trip, and an unresolved claim already survives to the
  next of three triggers, so the cost buys nothing the triggers do not.

## Risks

- **The live read costs one GraphQL round trip per merge attempt**, and
  settlement costs another for the promotion facts. That is the price of not
  trusting a cache, and it is bounded by the agent's own call rate.
- **The refusal is the common path, by design.** Any turn with an edit ends in a
  push, so the first `gh pr merge` refuses. The agent-facing docs must say so, or
  agents will report a failure instead of merging once the checks report. This is
  the cost of shipping without `docs/288-agent-merge-arming`: until that lands, an
  agent whose CI takes minutes cannot land its work inside the turn that produced
  it.
- **A stale claim blocks the next merge until reconciliation clears it.** Claims
  are single-flight: an outstanding row of either state refuses a new claim,
  because replacing one loses a merge that is still in flight. The cost is the
  other direction — an attempt whose outcome was never learned, on a session
  ShipIt cannot resolve (GitHub unreachable), refuses the next merge with "an
  earlier attempt is unresolved". That is the intended failure direction, and
  the three reconciliation triggers (end of turn, session activation, startup)
  are what clear it.
- **A stale `OPEN` read spends a `merging` claim.** Reconciliation resolves an
  unwitnessed claim from one read, so a GitHub read-after-write that still says
  open — seconds after a merge whose answer was lost — deletes the row and
  records nothing. Deliberately not defended with a minimum claim age: that
  would add a blocking failure mode to protect a transcript line, while the
  session's own state still converges through ordinary poller detection
  (`merged_at`, the reset anchor, the card). Requirement 9's record is what is
  lost in that window, and nothing else. A `settling` row is exempt — it is
  proof a merge response came back, and no `OPEN` read may downgrade it.
- **In `RUNTIME_MODE=local`, the grant is not out of the agent's reach** — and
  cannot be made so by anything in this feature. Requirement 3's guarantee rests
  on the PATCH route carrying no `containerAccessible` opt-in, which is a real
  boundary only when there are containers. Local mode has none: the agent runs in
  the orchestrator's own namespace, `registerContainerOriginGuard` is inert
  without a `containerManager` (`api-container-guard.ts:270`), and a request with
  no `Origin` is allowed (`api-origin-guard.ts` `isAllowedWithoutOrigin`). So a
  local agent can PATCH its own grant.

  It is left as-is rather than special-cased, because a local-mode refusal would
  protect nothing: `POST /api/sessions/:id/pr/merge` is browser-only by the same
  mechanism, so an agent that can reach the grant route can already merge
  **without** a grant, today, with this feature absent. `local-agent-ops.ts`
  states the same conclusion for the `gh` surface it hosts — "it is not a
  sandbox … a determined agent can already curl `/api/sessions/<any-id>/…`
  directly. Closing that is a different problem than this one, and it is not
  made worse here." That is exactly this feature's position, and closing it is
  the same different problem. Recorded, not silently inherited (cross-agent
  review finding).
- **A background process that writes during the merge can leave work off the
  merged commit.** The flush commits and pushes the tree, then two GitHub round
  trips happen before the REST call. Anything the agent started that keeps
  writing tracked files in that window is committed by the ordinary post-turn
  commit — after the merge — and lands on a branch that has already shipped.
  Closing it would need an operation-level write exclusion over the workspace,
  which this feature does not have a mechanism for and which nothing else in
  ShipIt asserts either; a human merging from the card has exactly the same
  exposure. Recorded rather than built (cross-agent review finding).
