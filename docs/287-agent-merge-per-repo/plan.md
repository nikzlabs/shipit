---
issue: planning#499
title: Agent merge, granted per repository — design
description: Widen the docs/224 merge gate from a per-sandbox grant to a per-repository one, and make the agent's merge flush the turn's work before it lands.
---

# Agent merge, granted per repository — design

Implements [requirements.md](./requirements.md). Extends
`docs/224-sandbox-merge-capability` (the shim, the route, the guardrails).

> **Revised 2026-09-02** after an independent review. Seven findings, each
> verified at the source before it was accepted; the changes are marked
> **(review)** below and summarised in [What the review changed](#what-the-review-changed).

## What changes, in one line

`mergeDisposition()` stops asking "is this a sandbox?" and starts asking "may an
agent merge here?" — and the repo-bound merge path gates on the **same state the
PR card gates on**, after flushing the turn's work.

## 1. Storage — the grant (req 1, 2, 3)

A column on the `repos` table, copying the shape of `repos.trusted` (docs/178) —
the per-repository boolean this feature is a second instance of:

```sql
ALTER TABLE repos ADD COLUMN allow_agent_merge INTEGER NOT NULL DEFAULT 0
```

A new migration entry, appended. Unlike `trusted` there is **no backfill**:
`trusted` backfilled existing rows to 1 because the gate arrived after the
repositories did, whereas here every repository must start off (req 2).

Reads and writes live on `RepoStore` (`orchestrator/repo-store.ts`) beside
`isTrusted()` / `setTrusted()`, matched on `canonicalRepoKey(url)` for the same
reason those are: rows are keyed by the raw URL a repository was first added
with, so two spellings of one remote must share one decision.

**No new endpoint (review).** The flag joins the existing browser-only
`PATCH /api/repos/:url`, which already takes `hidden` and `colorIndex` and
broadcasts `repo_list` on change, and it rides the existing `RepoInfo`
projection out to the client. The value is **server-authoritative and
container-inaccessible** — the browser must read it to render the toggle; the
container must never see or set it. That is a property of the route, not of the
session payload (req 3).

**Rejected: `shipit.yaml`.** The agent can write that file, so a permission
declared there is one the agent can grant itself in one commit. Receipt in
requirements.md.

## 2. The gate (req 4, 5, 6, 12, 13)

`mergeDisposition()` in `orchestrator/pr-target.ts` today returns `not-sandbox`
for anything that is not a sandbox. It gains one branch, and **keeps
`not-sandbox` for ops sessions (review)** — requirement 13 says ops behaviour
does not change, so a renamed disposition would be churn with no behaviour:

| Session | Decision |
|---|---|
| `kind === "sandbox"` | as today — `dangerousGitHubOps` decides (req 12) |
| `kind === "ops"` | `not-sandbox`, unchanged wording (req 13) |
| repo-bound | the repository's `allow_agent_merge` decides (req 4, 6) |

`not-granted-repo` is the one new disposition: *"Agents cannot merge in this
repository. The user turns this on in Project Settings."* (req 6)

### Ownership: a server-derived tuple, not a number (req 5)

The first draft compared the requested PR number with the number of the
current-branch PR. **The review showed that does not bind anything**, and all
three holes were reproduced in the code:

1. **`--repo` retargets the repository.** `resolvePrTarget()` returns early on a
   parsed `--repo` (`pr-target.ts:106`), and PR numbers are repository-scoped. So
   `gh pr merge 42 --repo org/other` passes a check against *this* repo's #42 and
   merges *another* repo's #42. `cwd` similarly moves the flush and push onto an
   agent-chosen nested clone.
2. **The current branch is agent-controlled.** `getCurrentBranch()` reads the
   writable workspace, and `block-branch-ops.mjs` refuses `checkout -b` but
   allows a plain `git checkout <existing-branch>`. It also returns `"main"` when
   HEAD is detached (`status.current ?? "main"`, `shared/git.ts:670`), so the
   "detached HEAD fails closed" claim in the first draft was simply false.
3. **A branch lookup carries no provenance.** `findPullRequest()` filters by
   repository and head branch only, so a pull request a *person* opened from the
   session's branch reads as the session's own — which requirement 5 excludes by
   name.

So ownership is decided from state the agent cannot write:

- **Repository** — `session.remoteUrl`. On a repo-bound session the route
  **refuses `--repo` and `cwd` outright (review)**; they stay available to
  sandbox sessions, which merge an explicit number in a repository that need not
  be their own.
- **Branch** — `session.branch`, the server-side record. Before any git
  mutation the route requires `git.currentBranchOrNull() === session.branch`
  (`currentBranchOrNull`, never `getCurrentBranch`, precisely because of the
  `"main"` fallback), and refuses otherwise.
- **Pull request** — the number ShipIt recorded when it opened the pull request
  for this session, persisted on the session row (`prNumber`, written by
  `agentCreatePr()` / `quickCreatePr()`). The requested number must equal it.
  **Absent ⇒ refuse (review)**: without a recorded number there is no way to tell
  ShipIt's pull request from a person's, and requirement 5 names that case.

Failing closed here is deliberate and is the opposite of `guardMergeSync`, where
"cannot tell" correctly proceeds: there the fallback is the status quo, here it
is a merge.

## 3. The merge sequence (req 14, 15, 16, 17)

```
1. flushPendingTurnCommit(...)                                          (req 14, 15)
     · any outcome other than "committed" / "nothing to commit" → 422
2. guardMergeSync(git)                                                  (req 14, 17)
     · "diverged" → hold, refuse
     · "ahead"    → push, then hold: "merge again once its checks report"
     · cancelAutoPush(sessionId) only on reason === "pushed"
3. poller.forceRefreshSession(sessionId), then poller.getStatus(...)    (req 7, 8, 16, 17)
     · no summary, or checks.total === 0 inside checks.graceUntil → refuse
     · reviewDecision review_required / changes_requested → refuse
     · failing → refuse; pending → refuse, naming --auto
4. merge at the recorded head SHA → logMergePerformed(via: "gh pr merge")
```

### The check gate is the poller's, not a second one (review)

docs/224 reads checks directly with `getCheckStatus()` because *"the poller
doesn't track sandbox PRs"*. That reason does not transfer: in a repo-bound
session the poller **does** track the session's pull request, and it is the
source the PR card gates on. Gating the agent path on the same summary is one
source of truth instead of two, and it removes three defects at once:

- **`"none"` is ambiguous.** `getCheckStatus()` maps an empty result to `"none"`
  (`github-auth-checks.ts:57`), and `agentMergePullRequest()` treats `"none"` as
  permission to merge. So the advertised second call — `gh pr merge --auto`,
  moments after the push — merges immediately if GitHub has not registered the
  new head's checks yet, because `--auto` is consulted only on `"pending"`. The
  poller summary carries `checks.graceUntil` (docs/230) for exactly this
  ambiguity, and the UI route already refuses inside that window with *"Waiting
  for CI checks to start"*.
- **A read failure looks like "no checks".** `getCheckStatus()` swallows API
  errors into the same `"none"`. Through the poller, an unread summary is
  `undefined` and refuses.
- **`reviewDecision` had no source (review).** The first draft listed the docs/174
  gate but named nothing that supplies it: the REST `viewPullRequest()` result
  has no such field — it is a GraphQL projection. The poller summary already
  carries it.

Sandbox sessions keep today's direct `getCheckStatus()` path unchanged.

### Merge at a SHA, not at a branch (review)

`PullRequestDetail.head` is a **branch name** (`pr.head.ref`,
`github-auth-prs.ts:705`), not a commit. So the first draft's stated reason for
moving the pull-request read — "then `pr.head` is the head we just pushed" — was
wrong. The reorder is still right, but for a different reason: `guardMergeSync`
returns `hold` after it pushes, so that invocation never reaches the check gate
at all.

The residual hazard is real and unaddressed by ordering: checks are read through
a mutable ref and `mergePullRequest()` sends no expected SHA
(`github-auth-prs.ts:167`), so anything that advances the branch between the
check and the merge gets merged unchecked. The fix is to carry the head **SHA**
through: read it once, gate the checks on it, and pass it as the REST merge's
`sha` parameter so GitHub refuses atomically if the head moved (req 16).

### The flush needs a complete outcome (review)

The first draft aborted on `secretBlocked` and `unreadableBlocked` only. Both
exist, and both are insufficient, because `autoCommit()` has two more ways to not
commit the turn's work:

- **Unresolved conflicts or a rebase in progress** return `commitHash: null`
  (`shared/git.ts:502`). `flushPendingTurnCommit()` emits a notice but hands the
  caller nothing that distinguishes this from a clean tree.
- **An unreadable path of kind other than `blocked`** produces a *partial*
  commit — the log line says so explicitly: *"its contents are omitted from this
  commit. The commit itself still lands."*

Both merge the previous or partial state while the agent believes its work
shipped, which is exactly what requirement 15 forbids. So `flushPendingTurnCommit()`
returns a discriminated outcome — `committed` / `nothing-to-commit` /
`blocked-secret` / `blocked-unreadable` / `blocked-conflict` / `partial-unreadable`
— and the merge proceeds on the first two only. `agentCreatePr()` gets the same
treatment, since it has the same two holes today.

### The refusal after a push (req 17)

`guardMergeSync` already says the right thing — *"Pushed N commits that had not
reached GitHub yet … merge again once its checks report."* The agent path appends
one clause: `--auto` arms merge-when-green. The command never waits by itself.

`MergeSyncVerdict` grows a discriminator so the caller never parses the message:

```ts
| { action: "hold"; reason: "pushed" | "push-failed" | "diverged"; message: string }
```

The debounced auto-push is cancelled **only** on `reason: "pushed"` — it is
session-keyed in `services/auto-push-scheduler.ts`, so cancelling one that no
synchronous push replaced simply strands the commit. The review confirmed this
rule against the scheduler and recommended keeping the discriminator.

## 4. After the merge (req 9, 10, 11)

- **The record (req 9).** `emitNoticeInTurn()` from
  `orchestrator/chat-card-persistence.ts` — it routes through `emitChatCard`, so
  it emits, records in-band and persists in one call. No new card type, no
  column, no migration. `logMergePerformed()` stays as the ops-log half.
- **Poller state (req 11).** `poller.forceVerifySessionPrState(sessionId)` after
  a successful merge, as the UI route does. The review confirmed this records the
  terminal snapshot and the merged-head anchor.
- **A shippable branch (req 10).** The branch then sits on the merged tip, so the
  post-turn auto-push is refused as stacked on it. The verify above sets the
  docs/218 reset eligibility, and the merge result tells the agent to run
  `shipit branch reset-to-base` — docs/239's own wording. That is the agent's
  step, so no user action is needed.

## 5. UI (req 1)

One toggle — *Allow agents to merge their own pull requests* — with help text
naming what it permits: this session's own pull request, checks green, branch
protection still enforced by GitHub.

It goes in an **"Agent permissions" section inside the existing Project Settings
surface (review)**, not in a new tab. The first draft added an Agents tab on the
Appearance tab's precedent; the review's objection stands — one toggle does not
justify a navigation category that is otherwise empty. It gets its own tab when a
second repo-scoped agent permission exists.

## What the review changed

| Finding | Change |
|---|---|
| `--repo` retargets the repository | Overrides refused on repo-bound merges |
| Current branch is agent-writable | Ownership from `session.branch` + `session.prNumber`, fail closed |
| `"none"` checks merge immediately | Gate on the poller summary, honouring `graceUntil` |
| `pr.head` is a branch name | Carry the head SHA; pass it as the merge's expected `sha` |
| Flush has four ways to not commit | Discriminated flush outcome; merge on `committed` only |
| `reviewDecision` had no source | Comes from the poller summary, with the checks |
| Grant test proves too little | Browser-only route + unchanged container-route snapshot |
| Extra mechanism | No new endpoint, no `ops-refused`, no new tab |

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | migrations: `repos.allow_agent_merge`, `sessions.pr_number` |
| `src/server/orchestrator/repo-store.ts` | grant read/write, `canonicalRepoKey`-matched |
| `src/server/orchestrator/api-routes-session-repos.ts` | grant on the existing `PATCH /api/repos/:url` |
| `src/server/orchestrator/pr-target.ts` | `mergeDisposition()`; refuse overrides on repo-bound merges |
| `src/server/orchestrator/services/github.ts` | flush outcome; the repo-bound merge path |
| `src/server/orchestrator/services/branch-sync.ts` | `reason` discriminator on the hold verdict |
| `src/server/orchestrator/github-auth-prs.ts` | expected `sha` on the REST merge |
| `src/server/orchestrator/api-routes-github.ts` | gate, ownership, poller gating, notice |
| `src/client/components/ProjectSettings.tsx` | Agent permissions section + toggle |
| `src/server/shipit-docs/github.md` | agent-facing text ([draft](./agent-docs.md)) |

## Tests

- `pr-target.test.ts` — every disposition branch, and `--repo` / `cwd` refused on
  a repo-bound merge.
- `services/github-agent-merge.test.ts` — ownership refusals (foreign number,
  wrong current branch, no recorded PR), each flush outcome, `cancelAutoPush`
  only on `reason: "pushed"`, the `graceUntil` refusal, the pending refusal
  naming `--auto`, the expected-`sha` merge.
- `services/branch-sync.test.ts` — the `reason` discriminator on each hold.
- `integration_tests/agent-driven-pr.test.ts` — granted / not granted / foreign
  pull request, and the notice surviving a history reload.
- The grant's route is browser-only: the container-route snapshot must not gain
  it, which is what the first draft's session-payload test failed to prove.
- Each new guard proved red on its own before the fix.

## Risks

- **The ownership tuple depends on a recorded PR number.** Sessions that predate
  the column have none and will refuse. That is the correct direction to fail,
  but it must be a clear message, not a puzzle.
- **The refusal is the common path, by design.** Any turn with an edit ends in a
  push, so the first `gh pr merge` refuses. If the agent-facing docs do not say
  so, agents will report a failure instead of merging with `--auto`.
