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

**A create that crashes must not lose the pull request it made.** GitHub creates
the pull request before `agentCreatePr()` returns, so a crash in between leaves a
real pull request and no provenance — and the retry then takes the
already-exists path, which this design forbids recording. The session could never
merge its own work. So a create writes a durable **intent** first —
`pr_create_intents(session_id, repo_key, branch)` — and clears it when provenance
is recorded. A create path that finds an existing pull request may adopt it as
provenance **only** when an intent row exists for that exact repository and
branch, and the found pull request's head branch matches it. No intent, no
adoption: a person's pull request on the same branch still cannot be claimed.

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
| the rollup is not `SUCCESS` and not pending — any reported check failing, errored or actioned | refuse (req 7) | refuse |
| `reviewDecision` review_required / changes_requested | refuse (req 8) | refuse |
| **null rollup** (zero checks) inside the CI grace | refuse: waiting for checks to start | refuse |
| checks **pending** | refuse, naming `--auto` (req 17) | **arm** at `headRefOid` (req 18) |
| checks passed, or null rollup past the grace | merge now | **arm** at `headRefOid` |

The zero-check grace refuses **both** modes on purpose: an empty check set inside
the window means "not registered yet", and arming against it would authorise a
commit whose checks nobody has seen.

**`--auto` always defers; it never merges inline.** An earlier draft let it merge
at once when the checks were already green, which made the same flag mean two
different things and contradicted the agent-facing promise that an armed merge
lands after the turn. One meaning: `--auto` records what to merge and ShipIt
performs it, exactly as requirement 18 words it. An agent that wants the merge
*now* calls `gh pr merge` without the flag.

**"Every reported check", not "every required check".** The rollup is GitHub's
*combined* status for the commit and does not say which checks the base branch
requires; the per-check `isRequired` flag would mean paging every check run, and
the branch-protection API needs an Administration permission ShipIt's
installation tokens deliberately omit (`github-app-token.ts:91`). Requirement 7
was reworded to match what can actually be decided fail-closed from one field: a
failing check blocks an agent merge whether or not GitHub calls it required. That
is stricter than branch protection, and deliberately so — the user can still
merge from the pull-request card, which is governed by GitHub's own rules.

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
  revoked      INTEGER NOT NULL DEFAULT 0
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

**A merge attempt has three outcomes, not two.** The REST call is a plain
`fetch`, which can reject *after* GitHub accepted the request — so "it threw" does
not mean "it did not merge", and treating it as a failure would discard the
record of a merge that already happened:

| Outcome | What it means | What happens to the row |
|---|---|---|
| **witnessed success** | a parsed response saying the merge landed | → `settling` |
| **definitive refusal** | GitHub answered no — conflict, protection, moved head | deleted, reason surfaced once |
| **indeterminate** | a transport error, a timeout, an unparseable body | stays `merging`, reconciled from the tuple |

A definitive refusal **ends the claim**, whatever its origin: the row is deleted
and GitHub's reason is surfaced once. The requirements ask ShipIt to wait for
*checks*, not to keep an arming alive after GitHub has said no — a conflict or a
branch-protection refusal at a fixed commit does not resolve itself, and a
lingering arming that retries every tick is both surprising and noisy. A direct
refusal reaches the agent as the command's answer; an arming's refusal reaches
the transcript as a notice.

An indeterminate outcome — and equally a crash — leaves the row `merging`, and it
is resolved from its own tuple: read that pull request in that repository and ask
whether `expected_sha` merged. Merged ⇒ `settling`. Still open ⇒ back to
`pending` for an arming, deleted for a direct claim — unless the row is `revoked`,
which terminates it instead. Nothing is decided from the shape of the error.

**A `pending` row also needs terminal handling.** The observation table refuses
every non-open pull request, so without this a row whose pull request was merged
or closed by somebody else — the user, the pull-request card's own auto-merge —
would refuse for ever, and keep the polling gate open with it:

| What the read finds | The row |
|---|---|
| `MERGED` at `expected_sha` | settle, with the narrower "the agent asked for this commit and it is now merged" attribution (req 9) |
| `MERGED` or closed at a different head | cancel as moved-head, with the req 19 notice |
| closed without merging | delete, with a terminal notice |

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

The exclusion is a **session-scoped merge claim**, and it has two kinds, because
the two performers stand in opposite relations to the turn:

| Claim | Taken by | Precondition |
|---|---|---|
| **turn-owned** | the direct `gh pr merge` route | none — it belongs to the turn that is already running, and that route documents that its own runner is always running |
| **background** | the arming executor | the session is idle **and** its queue is empty |

An idle-only rule would make the direct path impossible, since that HTTP call is
issued from inside the active turn. A turn-owned claim instead says "this turn is
merging", which is exactly what a later turn must wait for.

**The claim is only worth what admission is.** Turn starts are not confined to
the two entry points named above: a queued turn re-enters through
`ws-handlers/agent-execution.ts`'s drain, and `runDispatchedTurn`
(`session-runner.ts`) deliberately bypasses the ordinary send-or-queue decision
via `dispatched-turn.ts`. A check added to two of those four is not an exclusion.
So every turn start — interactive send, dispatched turn, and queue drain —
passes through **one authoritative admission gate** that consults the claim; a
background claim makes a turn wait, and it is released when the merge has
settled.

**Adoption after a restart is deliberately not gated.** It resumes a turn that
already exists rather than starting a new one, startup already completes adoption
before later automation, and gating it could block the very turn that owns a
persisted direct claim. The gate is for new work only.

**Releasing the claim must actively restart the queue.** Draining is
event-driven: a finished turn drains once, and a background merge has no owning
turn whose completion could drain afterwards — so a message that arrived while
the claim was held would sit there until some unrelated event. Every exit from a
background claim — settlement, cancellation, a refusal, or recovery — calls the
shared `releaseQueuedTurn()` (`queue-drain.ts`), which exists for exactly this
case: work with no turn of its own. It is called **after** the durable state
change, so a crash in between leaves a row that reconciliation resolves rather
than a queue released against a claim that still exists.

### Revocation (req 20)

Turning `allow_agent_merge` off deletes every **pending** arming whose `repo_key`
matches — one statement in the same transaction as the flag, resolved by
`canonicalRepoKey`, so every URL spelling of that repository is covered. Nothing
network-dependent can fail and leave a merge armed while ShipIt reports the
permission off, which is exactly what the native path could not avoid.

Requirement 20 says *every* request that has not merged is cancelled, so the
in-flight case is not waived. Three parts, because "wait for it to resolve"
cannot be the whole answer — an indeterminate outcome deliberately leaves a row
`merging`, so waiting could hang:

- **The grant is re-checked atomically at `pending → merging`.** A claim is never
  issued under a permission that has already been withdrawn.
- **Revocation marks in-flight rows `revoked`, durably**, rather than deleting
  them: a `merging` row must survive to be reconciled, but it must also carry the
  fact that its permission is gone, or a restart would lose that intent.
- **A revoked row never returns to `pending`.** Reconciliation reads its tuple: if
  `expected_sha` merged, it settles (the merge already happened, and requirement 9
  still wants the record); otherwise it terminates with a notice. Either way
  nothing further is merged.

Revocation reports the permission withdrawn once every row is `pending`-free —
deleted, or marked and therefore incapable of merging again — not once every
network call has returned.

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
