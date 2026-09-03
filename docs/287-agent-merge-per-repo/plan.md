---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, flush the turn's work before merging, and decide every merge from one live read at an exact commit.
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
(`orchestrator/repo-store.ts`) beside `isTrusted()` / `setTrusted()`, matched on
`canonicalRepoKey(url)` for the same reason those are — two spellings of one
remote must share one decision.

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
- **Pull request** — `session.prNumber` with `session.prRepoKey`. The requested
  number must equal it, the key must equal `canonicalRepoKey(session.remoteUrl)`
  at merge time, and an absent value **refuses**.

Failing closed is deliberate, and is the opposite of `guardMergeSync`, where
"cannot tell" correctly proceeds: there the fallback is the status quo, here it
is a merge.

### The `prNumber` lifecycle

A recorded number is a **provenance claim**, so only a pull request ShipIt itself
opened may write it — otherwise it grants ownership of a person's pull request,
which requirement 5 excludes by name.

| Event | Effect on `sessions.pr_number` / `pr_repo_key` |
|---|---|
| `agentCreatePr()` returns `alreadyExisted: false` | write, if the created repo matches |
| `POST /api/sessions/:id/pr` opens a PR | write, if the created repo matches |
| `POST /api/sessions/:id/pr/quick` opens a PR | write, if the created repo matches |
| `pr-lifecycle.ts` → `quickCreatePr()` opens a PR | write, if the created repo matches |
| any of those returns a **pre-existing** PR | leave unchanged — it may be a person's |
| docs/202 re-arm clears `pr_status` | clear both |
| explicit reset (`pr-rearm.ts`) | clear both |
| unarchive's "old PR no longer applies" clearing | clear both |
| the session's `origin` is changed | clear both, and any arming |
| sessions predating the columns | `NULL` — refuse, and **never backfill from `pr_status`**, which also holds person-opened PRs |

`quickCreatePr()` cannot tell the creation cases apart today: it returns the
**same shape** for a pull request it found (`services/github.ts:656`) and one it
opened (`:721`). It gains an `alreadyExisted` discriminator, as `agentCreatePr()`
already has, and both of its callers pass the result through. Without that the
implementation must either record nothing or claim a person's pull request.

**"If the created repo matches" is load-bearing twice over.** `agentCreatePr()`
accepts `--repo` and passes the retargeted remote through
(`api-routes-github.ts:320`), so a pull request opened in repository B could
otherwise be recorded as the ownership number for repository A. And
`session.remoteUrl` is not fixed — replacing `origin` updates `sessions.remote_url`
in place — while numbers, branch names and even SHAs can coincide across forks.
Hence two defences, so that a missed clear can never become an authorisation:
the write requires
`canonicalRepoKey(created.repoUrl) === canonicalRepoKey(session.remoteUrl)`, and
`pr_repo_key` is stored with the number and re-checked at merge time.

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
 4. the caller's mode decides what the observation means               (req 17)
      · direct: merge now, or refuse
      · --auto: merge now, or record an arming            (repo-bound, req 18)
 5. claim durably, merge at the observed SHA, settle           (req 9, 10, 11)
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

### The read returns an observation; the caller decides

The read produces a **structured observation**, not a verdict, because the two
callers need different things from the same facts — a direct merge refuses on
pending checks, while `--auto` exists precisely to record an arming for that
case:

| Observation | Direct merge | `--auto` (repo-bound) |
|---|---|---|
| read failed, node missing, or any GraphQL `errors` | refuse | refuse |
| rollup `commit.oid !== headRefOid` | refuse (req 16) | refuse |
| repo-bound and `headRefOid !== local HEAD` | refuse (req 14) | refuse |
| `state !== "OPEN"`, or `isDraft` | refuse (req 7) | refuse |
| a required check failing | refuse (req 7) | refuse |
| `reviewDecision` review_required / changes_requested | refuse (req 8) | refuse |
| **null rollup** (zero checks) inside the CI grace | refuse: waiting for checks to start | refuse |
| checks **pending** | refuse, naming `--auto` (req 17) | **arm** at `headRefOid` (req 18) |
| checks passed, or null rollup past the grace | merge now | merge now |

The zero-check grace refuses **both** modes on purpose: an empty check set inside
the window means "not registered yet", and arming against it would authorise a
commit whose checks nobody has seen.

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
one clause: `--auto` records the merge for when they pass. The command never
waits by itself.

The verdict grows one field, not a taxonomy: `{ action: "hold"; pushed: boolean;
message }`. The caller's only question is whether a synchronous push landed,
because the debounced auto-push may be cancelled **only** then — it is
session-keyed in `services/auto-push-scheduler.ts`, so cancelling one that no
push replaced strands the commit.

## 4. `--auto`: a ShipIt arming, bound to one commit (req 18–21)

`--auto` does **not** use GitHub's own merge-when-green. `expectedHeadOid` is a
precondition checked when the arming is *enabled*, not a binding on the merge
GitHub later performs, and GitHub keeps an arming alive across a push by anyone
with write access — so a native arming can land a commit the agent never
authorised, and withdrawing the grant cannot cancel it. The existing
ShipIt-managed loop is no better on its own: `AutoMergeState` holds neither a
pull-request number nor a SHA, and it selects through the branch-keyed map.

**Repo-bound sessions only.** A sandbox has no `session.remoteUrl`, may target
several repositories, is not tracked by the repository poller, and is governed by
`dangerousGitHubOps` rather than the repository grant. Requirement 12 settles it:
sandbox behaviour does not change, and none of this section applies there.

```sql
CREATE TABLE agent_merge_armings (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  repo_key     TEXT NOT NULL,      -- canonicalRepoKey of the session's remote
  pr_number    INTEGER NOT NULL,
  expected_sha TEXT NOT NULL,      -- the head the live read observed
  method       TEXT NOT NULL,      -- merge | squash | rebase
  state        TEXT NOT NULL,      -- pending | merging | settling
  origin       TEXT NOT NULL,      -- auto | direct
  last_error   TEXT
);
CREATE INDEX idx_agent_merge_armings_repo ON agent_merge_armings(repo_key);
```

There is deliberately no `armed_at`: nothing times an arming out, and a column no
code reads is a column that will drift.

### The state machine

`pending → merging → settling → deleted`, and the claim is written **before** the
REST call, never after it. An executor that only recorded success would have an
unrepresentable window: the row it is merging could be replaced or cleared while
the call is in flight, leaving its own success nowhere to land.

| State | Written | Who may touch it |
|---|---|---|
| `pending` | when `--auto` arms | every lifecycle clear, revocation, a second `--auto` |
| `merging` | durably, immediately **before** the REST call | only the performer |
| `settling` | on a witnessed REST success | only settlement |

A second `--auto` while a row is `merging` or `settling` is **refused**, so one
row per session stays true and the primary key cannot collide. `merging` and
`settling` are **monotonic**: an origin change, archive, a re-arm, a reset, an
unarchive, a repository removal and revocation all act on `pending` rows only.
Only settlement, or destroying the session (through the cascade), removes a
`merging` or `settling` row.

**`origin` decides what a failure means.** A merge that GitHub refuses — a
conflict, branch protection, a moved head — is an ordinary outcome, and the two
callers want opposite things from it. A failed **direct** claim is **deleted**: a
plain `gh pr merge` must never leave behind something that merges later. A failed
**auto** claim returns to `pending` with `last_error`, surfaced once rather than
on every tick. Crash reconciliation preserves the same distinction: on restart, a
`merging` row is resolved from its own tuple — read that pull request in that
repository, ask whether `expected_sha` merged — and then either moves to
`settling` or follows its `origin` back to `pending` or to deletion.

### Where the executor runs, and what it excludes

In the PR status poller's existing tick, beside the managed auto-merge loop —
not a second timer. Durability alone would not reach it: the polling supervisor
iterates `tracker.sessionRepos` and the global gate opens only for in-memory
automation, so after a restart with no viewer a persisted arming would never
receive a tick. Armings are therefore a **first-class input to the supervisor and
the gate** — loaded at startup, `ensure()`d when one is written, and their
repository ticked even when no ordinarily tracked session would keep polling
alive. They are **activated only after `reattachInFlightTurns()` completes**,
because `trackSession()` polls immediately when the gate is open and the poller
exists before reattachment; activating at construction could merge a session's
pre-turn head while a surviving turn still holds uncommitted work.

**A merge and a turn are mutually exclusive, through admission (docs/266 req 2).**
A busy check alone cannot give that: `PostTurnHold.begin()` only increments a
counter, interactive admission (`ws-handlers/send-message.ts`) tests `running`
and `systemTurnInProgress`, dispatched admission (`session-runner.ts`) does the
same, and none of them consults `agentBusy` — so a turn can start *during* the
REST call, after which its push is refused and its work is stranded. That is a
documented failure of the existing managed loop, not a hypothetical.

So the exclusion is a **session-scoped merge claim that admission itself
respects**: the performer takes it only when the session is idle, both admission
paths queue a turn while it is held, and it is released when the merge has
settled. One claim, checked in the three places that can start work. This is what
lets requirement 18's promise — and the agent-facing documentation — say plainly
that a merge never lands under a live turn.

### Revocation (req 20)

Turning `allow_agent_merge` off deletes every **pending** arming whose `repo_key`
matches — one statement in the same transaction as the flag, resolved by
`canonicalRepoKey`, so every URL spelling of that repository is covered. Nothing
network-dependent can fail and leave a merge armed while ShipIt reports the
permission off, which is exactly what the native path could not avoid.

Requirement 20 says *every* request that has not merged is cancelled, so the
in-flight case is not waived: revocation and the claim-to-REST interval share a
**per-repository boundary**. Revocation either wins — cancelling before the
request is issued — or waits for an already-issued request to resolve before it
reports the permission withdrawn. The user is never told the permission is off
while a merge it authorised is still in flight.

## 5. Settlement (req 9, 10, 11)

**Both merge paths settle the same way**, whether the merge came from `--auto` or
from a direct `gh pr merge`.

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

**Every settlement effect is retry-safe.** "Record, then delete" is not
crash-idempotent on its own: transcript notices get random ids, so a crash
between the append and the delete would produce a second notice on recovery. So
the merge record carries a **stable natural identity** —
`agent-merge:<repo_key>#<pr_number>@<merge_sha>` — and settlement is idempotent
on it; the promotion, the lifecycle callbacks and the notification keep their
existing fire-once behaviour. Only after settlement is written is the row
deleted; until then it is also what holds the polling gate open, which is why
deleting at the REST response would let the gate close before the card,
`merged_at` and reset eligibility exist.

**What the record may claim.** A witnessed REST success records *"the agent
merged it"*. Crash recovery that finds `expected_sha` already merged records
something narrower — *"the agent armed this commit, and it is now merged"* —
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

## 6. UI (req 1)

One toggle — *Allow agents to merge their own pull requests* — with help text
naming what it permits: this session's own pull request, checks green, branch
protection still enforced by GitHub. It goes in an "Agent permissions" section
inside the existing Project Settings surface, not a new tab: one toggle does not
justify an otherwise empty navigation category.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migrations: `repos.allow_agent_merge`, `sessions.pr_number` + `pr_repo_key`, `agent_merge_armings` |
| `src/server/orchestrator/agent-merge-armings.ts` | the arming store: arm, claim, state transitions, delete by session / repo |
| `src/server/orchestrator/repo-store.ts` | grant read/write, `canonicalRepoKey`-matched |
| `src/server/orchestrator/api-routes-session-repos.ts` | grant on the existing `PATCH /api/repos/:url`; revocation and its boundary |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()`; `--repo` refused, `cwd` ignored |
| `src/server/orchestrator/services/github.ts` | flush outcome; the merge-gate read and observation; both merge paths; `quickCreatePr()` gains `alreadyExisted` |
| `src/server/orchestrator/github-auth-prs.ts` | expected `sha` on the REST merge |
| `src/server/orchestrator/pr-status-poller.ts` | `awaitCiGraceDecision()`; the arming executor; the canonical terminal promotion |
| `src/server/orchestrator/ci-grace-tracker.ts` | a merge entry point (repo + PR + SHA; unknown history waits) |
| `src/server/orchestrator/pr-polling-supervisor.ts`, `polling-global-gate.ts` | armings as a polling input |
| `src/server/orchestrator/ws-handlers/send-message.ts`, `session-runner.ts` | admission respects the merge claim |
| `src/server/orchestrator/services/branch-sync.ts` | `pushed` on the hold verdict |
| `src/server/orchestrator/services/pr-lifecycle.ts`, `pr-rearm.ts`, `services/git.ts`, `sessions.ts` | provenance writers and clearers |
| `src/server/orchestrator/api-routes-github.ts` | gate, ownership, settlement, notice |
| `src/client/components/ProjectSettings.tsx` | Agent permissions section + toggle |
| `src/server/shipit-docs/github.md` | agent-facing text ([draft](./agent-docs.md)) |

## Tests

- `pr-target.test.ts` — dispositions; `--repo` refused and `cwd` ignored on a
  repo-bound merge; the ordinary call (which always carries `cwd`) is allowed.
- `services/github-agent-merge.test.ts` — ownership refusals (foreign number,
  wrong branch, no recorded PR, moved `pr_repo_key`); each flush outcome; the
  cancel rule; every row of the observation table in **both** modes; the
  expected-`sha` merge.
- `agent-merge-armings.test.ts` — the state machine, including a failed direct
  claim being deleted while a failed auto claim returns to pending, and crash
  reconciliation of a `merging` row from its own tuple.
- Admission tests — a turn queues while a merge claim is held, on both the
  interactive and the dispatched path.
- Settlement tests — idempotence on the natural identity (a repeated settlement
  produces one notice), and the promoted state matching a detected merge.
- `services/branch-sync.test.ts` — `pushed` true only after a successful push.
- Provenance lifecycle tests: written only on `alreadyExisted: false` with a
  matching repository, cleared by each clearing path, never backfilled.
- `integration_tests/agent-driven-pr.test.ts` — granted / not granted / foreign
  pull request; the notice surviving a history reload.
- The container-route snapshot must not gain the grant route.
- Each new guard proved red on its own before the fix.

## Risks

- **The live read costs one GraphQL round trip per merge attempt**, and
  settlement costs another for the promotion facts. That is the price of not
  trusting a cache, and it is bounded by the agent's own call rate.
- **The refusal is the common path, by design.** Any turn with an edit ends in a
  push, so the first `gh pr merge` refuses. The agent-facing docs must say so, or
  agents will report a failure instead of using `--auto`.
