---
issue: planning#605
title: Base-branch push protection — design
description: Where ShipIt could publish a base branch, and the two layers that now refuse it.
---

# Base-branch push protection — design

Implements [requirements.md](./requirements.md).

## The failure

Reconstructed from git metadata on `nicolasalt/reward-tag`. `main` advanced
through four GitHub squash merges (`a4b8bae8` → `0578dfc8` → `6ddac198` →
`c8dbc042`, all committed by `GitHub <noreply@github.com>` at their PR merge
times). PR #351 then merged as `a38f62d0` with parent `a4b8bae8` — GitHub builds
a squash commit on the branch's current tip, so `main` had already been reset
from `c8dbc042` back to `a4b8bae8`. Every pre-reset hash was unchanged, so this
was a **ref reset, not a rewrite**, and nothing was added, so it was not a
revert.

`a4b8bae8` is not arbitrary: it is a real former tip that stood for about 66
minutes. That is the signature of a **stale clone**.

## Why a stale clone holds exactly that commit

A session clone comes from the shared bare cache
(`repo-git.ts:199 cloneFromCache` — `git clone --local`, then `remote set-url
origin` to GitHub). `git fetch` advances `refs/remotes/origin/*` and **never**
advances a local branch, so a clone's local `main` is frozen at clone time
forever. `syncLocalDefaultBranchToOrigin` (`git-utils.ts:199`) exists to move
it — but it is called only from the warm-pool and claim paths, **not** from
`restoreSessionWorkspace` or `unarchiveSession`, and it returns early when the
default branch is the one checked out.

So any clone taken in that 66-minute window holds `main` at exactly `a4b8bae8`,
and publishing that ref reproduces the incident byte for byte.

## How a push target becomes the base branch

Every automatic push resolves its target with `getCurrentBranch()` — whatever is
checked out — and, before this change, nothing downstream asked whether that was
the session's own branch. Two ways the checkout reaches the base branch:

- **`git checkout main`.** `block-branch-ops.mjs` refused `git switch main`
  ("moves off the session branch") and let the identical `git checkout` form
  through.
- **A restore with no recorded branch.** `restoreSessionWorkspaceImpl`
  (`services/session.ts`) checks the session branch back out inside
  `if (session.branch)`. `branch` is optional on `SessionInfo`; when it is
  absent the clone stays on its default checkout, which is the default branch.

From there, three force-push call sites resolved their target from the current
branch with no ownership check: `quickCreatePr` and `agentCreatePr`
(`services/github.ts`, the re-arm-past-a-merged-PR paths) and `tryForcePush`
(`services/rebase-driver.ts`). `pushIfAheadOfRemote` in the same file already
refused `branch === baseBranch`; `tryForcePush` beside it did not.
`checkResetPreconditions` (`services/pre-turn-reset.ts`) guarded the two
reset-and-heal force-pushes with `session.branch && branch !== session.branch`,
which passes on **any** branch when `session.branch` is falsy.

## Why the lease did not help

`GitManager.forcePush` reads its expected SHA from the **live** remote
(`remoteBranchSha` → `ls-remote`) moments before pushing, then passes it to
`--force-with-lease`. The lease is therefore satisfied by construction: it
cannot express "I believe the remote is where I last saw it", which is the only
thing that would have refused this push. That live read is deliberate and stays
— a stale tracking ref spuriously rejects the post-merge follow-up push
(`git-force-push-lease.test.ts`) — so the protection is added beside it rather
than by reverting it.

## Two more ways in, found by review

**A refspec through the ordinary push method.** `POST /api/sessions/:id/git/push`
forwards a caller-supplied `branch` straight to `GitManager.push`
(`api-routes-git.ts` → `services/git.ts` → `git.ts`), with no validation. A
`branch` of `+main:main` is a **force** with no flag to find, and it reaches the
non-force method — past any guard that inspects only the force-pushing path.
`assertPlainBranchName` now runs in both `push` and `forcePushWithLease`, at the
primitive rather than at that one route (req 5).

**The rebase refusal falling through to an ordinary push.** Refusing inside
`tryForcePush` is not enough on its own: the successful-rebase callers recorded
only `published = false`, and the `finally` block then armed the pre-sync
commit's auto-push — which would fast-forward the base branch with that commit,
under no pull request. The up-to-date path beside it already had the right
mechanism (`pushProhibited`); `tryForcePush` now returns `"refused"` distinctly
and both callers consume it.

## The design: two layers

**Layer 1 — the primitive refuses a rewind** (`shared/git.ts`,
`refuseRewindingForcePush`). Before a leased force-push, compare the local ref
to the remote tip. If the local ref is a **proper ancestor** of the remote tip,
the push only discards: it moves the branch backwards and replaces what it drops
with nothing. Refuse, naming how many commits were at risk.

One caller legitimately needs that shape, and only one: `reset-to-base` drops
the commits above the base on purpose, and with `--force` that is an authorised
rewind. So the refusal is unconditional and the two reset paths pass
`{ allowRewind: true }` — after `checkResetPreconditions` has verified the
target is the session's own branch and not a shared one.

Otherwise no legitimate ShipIt force-push has that shape. A
republished rewrite (rebase, reset-onto-base, release prepare, PR re-arm) leaves
the old remote tip on a **diverged** history, never ahead of the new one — after
a squash merge especially, base and branch are not ancestors of each other. A
fast-forward is not a force at all. `pushIfAheadOfRemote` proves its own case is
the other direction (`isAncestor(remoteHead, "HEAD")`).

One subtlety makes the check work at all: `ls-remote` transfers **no objects**,
so on a stale checkout the commits at risk are exactly the ones the repository
has never seen, and the ancestry test would answer "unrelated" for the case the
guard exists for. `refuseRewindingForcePush` therefore fetches the branch when
the remote tip is not a local object, and refuses outright if it still cannot
see it — an unreadable remote is not a cleared one.

**Layer 2 — the call sites refuse a foreign ref**
(`services/push-target-guard.ts`, `findSharedBranchRefusal`). A push target that
is the pull request's base, or the repository's default branch, is refused with
an explanation. Wired into `quickCreatePr` and `agentCreatePr` before either
pushes, and mirrored by the `branch === baseBranch` refusal added to
`tryForcePush`. `checkResetPreconditions` gained the same check: its
`session.branch && branch !== session.branch` test passed on **any** branch when
the recorded branch was falsy, and matching a recorded name is not proof of
ownership either — a headless session takes an explicit branch name and a fork
takes a caller-supplied one. Asking "is this a shared branch?" directly is both
narrower and stronger than inferring it from the recorded name.

Layer 2 states intent and produces a good message; layer 1 does not depend on
any caller having asked the right question. The incident's exact call site is
not established, so a fix resting only on layer 2 would be a guess.

**Layer 3 — the agent-side hook** (`docker/agent-hooks/block-branch-ops.mjs`).
`git checkout <branch>` now reads the same as `git switch <branch>`. Only the
unambiguous branch form is judged: a name carrying `.`, `/` or `\`, a name that
exists as a path, or any `--` pathspec form is left alone, so `git checkout .`
and `git checkout src/index.ts` stay allowed — and so does returning to a
`shipit/…` branch. Separately, `git push origin +main` is a force with no flag
to find, and is now caught alongside `--force` under the destructive guard.

## Reducing the blast radius: healing the frozen ref

The refusals above stop the publish. Separately, the stale ref itself is healed
where ShipIt hands an **existing** checkout back to a session:
`restoreSessionWorkspaceImpl`'s workspace-present return (the wake path) and
`restoreInPlace` under `unarchiveSession` both call
`syncLocalDefaultBranchToOrigin`.

Those two, and not the re-clone beside them, because a clone taken during a
restore is **not** stale: `cloneFromCache` runs `git clone --local` against a
bare cache that `fetchCache(0)` just refreshed, so the clone's local default and
its `origin/<default>` are the same commit — measured, not assumed. The drift
appears later, inside the container, every time the session fetches. So the
moment worth healing is the one just before the next turn runs.

Two properties of `syncLocalDefaultBranchToOrigin` matter for these callers:

- **The early return when the default branch is checked out is right, and for a
  stronger reason here.** Moving the checked-out branch would have to move the
  working tree with it, and an inherited checkout can hold the session's
  uncommitted work — `restoreInPlace` exists precisely to preserve it. A session
  sitting *on* the default branch therefore keeps its stale ref, and the
  push-side refusals are what cover that case.
- **It now moves the ref only when that discards nothing.** Moving the ref drops
  whatever it has and the remote does not; a cache snapshot never has commits of
  its own, but a checkout ShipIt inherits can. When the local ref has commits
  `origin/<branch>` lacks, it warns and leaves the ref alone.

  The cost falls on the warm-pool and claim callers in one case: after an
  **upstream rewrite** of the default branch, the old local commits are "local
  only" by hash, so the ref is now left stale where it used to be realigned, and
  a `main..HEAD` diff is wrong until the next clone. Chosen over the other
  failure, which is deleting a user's commits with no record.

Two smaller decisions inside it. Every ref is **fully qualified**: a *tag* named
`main` outranks the branch in git's revision lookup, so a bare name can measure
one ref and then move another. And the write is `update-ref <ref> <new> <old>`,
a compare-and-swap, because a worker git operation can move either ref between
the check and the write — the same "believe the ref is where I last saw it"
property the leases above lack. It gives up `git branch -f`'s refusal to move a
branch checked out in another worktree; ShipIt creates none, the primary
worktree is covered by the early return, and the move is a fast-forward.

## Layer 4 — the ordinary pushes, and the fork

Layers 1–3 stop the force-push, which is the half that destroys. An ordinary
push cannot rewind — git declines a non-fast-forward — but it can fast-forward
the base with a commit that belongs to no pull request, so it is refused too
(req 7). The same `findSharedBranchRefusal` runs at all three ordinary-push
sites:

- **`pushToOrigin`** (`git-utils.ts`), the per-turn auto-push. Its `onSkip`
  now carries a `{ reason, message }` pair rather than a bare reason, so the
  wording of every refusal lives in one place and both callers report it (req 3).
- **`ensureBranchTipOnOrigin`** (`checkout-durability.ts`), the push that makes
  a checkout safe to delete. A new `blocked-by-push` cause, `shared-branch`.
  Refusing here is the SAFE answer rather than a lesser one: "not durable" keeps
  the checkout, so the commits survive locally instead of being published onto
  the base.
- **`guardMergeSync`** (`services/branch-sync.ts`), the pre-merge catch-up push.
  Holds with `pushed: false`, which deliberately leaves any armed auto-push in
  place — it refuses the same branch for the same reason, so nothing reaches the
  branch by the other route.

**The fork is the only way to start a session on a shared branch**, and it is
refused as well (req 8). `POST /api/sessions/:id/fork` takes its branch name
from the caller and validated only characters; the fork's clone carries no local
copy of the default branch, so `git checkout -b main` would succeed. The check
runs before the clone, and only for a session that has a remote — without one
`getDefaultBranch()` answers `"main"` from its own fallback, which is no
evidence of a shared branch.

Two more paths reach a shared branch without the checkout ever being on one, and
both are covered: **`gitPush`** (`services/git.ts`), behind
`POST /api/sessions/:id/git/push`, takes its branch from the caller — the
`assertPlainBranchName` added earlier stops `+main:main`, but a plain `main` was
still accepted; and **`mergeSession`**'s push of the source session's recorded
branch, where refusing costs nothing because the fallback beside it fetches the
same commits straight from the source checkout.

**A verified default, for ordinary pushes only** (req 9). `getDefaultBranch()`
returns the literal `"main"` when it can read nothing, so a repository whose
origin holds no refs reports a default it has never had. For a force-push that
guess is the right way to fail — an unreadable remote is not a cleared one. For
an ordinary push it is wrong, and the case is real: a session created from a
TEMPLATE starts on a local `main` (`GitManager.init()` passes
`--initial-branch=main`) and records no branch, so refusing would stop a new
project publishing its first branch to the empty repository the user just
pointed it at. Nothing there can be lost, because nothing is on it. So the
ordinary-push sites pass `requireVerifiedDefault`, which demands a
`refs/remotes/origin/<default>` tracking ref as proof.

**The fork reads the authoritative default, not `getDefaultBranch()`.** An older
parent's own `origin/HEAD` can point at *its* parent's feature branch — the
reason `inheritOriginHead` prefers the bare cache. The guard uses the same
`resolveForkOriginHead`, or a fork named `main` would pass a check that the very
next step then corrects.

**What the premise turned out to be.** The question was open because guarding an
ordinary push would stop auto-push for a session working on the default branch.
Every *repo-backed* session gets a branch of its own (the enumeration is in
`requirements.md`'s resolved question), and the fixtures that appeared to show
otherwise — `auto-push-success.test.ts`, `checkout-durability.test.ts` — build
their session through `/api/_test/sessions`, a test-mode-only route, and were
rewritten onto a `shipit/*` branch. The template session is the one genuine
exception, and req 9 is what handles it.

## Known gaps, deliberately not closed here

- **A non-default PR base is not refused at the ordinary-push sites.** On a repo
  whose pull requests target `stable` while the default is `main`,
  `findSharedBranchRefusal`'s `baseBranch` argument would catch it — but
  `pushToOrigin`, `ensureBranchTipOnOrigin` and `guardMergeSync` have no session
  context to read it from, and the session row stores `pr_number` /
  `pr_repo_id` but not the base. The force-push sites do pass it, because the
  pull-request flow has the record in hand. Closing this means either a new
  column or threading session state into these helpers.

- **The hook is Claude-only.** It is a Claude Code `PreToolUse` hook, armed in
  `session/agents/claude/process.ts`. Codex, opencode and grok sessions get no
  branch guard, and the terminal panel is not covered by any. Layers 1 and 2
  cover ShipIt's own pushes on every backend; an agent running raw `git` on
  another backend is not covered.
- **`git push --force` is only blocked during merged-branch recovery**
  (`SHIPIT_GUARD_DESTRUCTIVE_GIT`). Blocking it always would be wrong — a
  session force-pushing its *own* branch after a rebase is routine — and the
  hook has no way to learn the session branch, so the precise rule ("force-push
  only your own branch") needs an env var it does not have.
- **A live session's local default branch still drifts.** It is healed when a
  checkout is handed back (above) and never again, so a long-running session
  that fetches many times ends the day holding a stale `main`. Healing on every
  fetch would mean a hook inside the container; refusing the push is the
  guarantee, and this only narrows the window.
- **Browser activation of a retained `light` checkout is not healed.**
  `materializeRunnerSync` (`services/materialize-runner.ts`) promotes a `light`
  session straight to `hot` and builds its runner without going through
  `restoreSessionWorkspace`, so the interactive path — the one most turns start
  on — keeps its stale ref. Closing it means either a contract change on a
  function that is synchronous on purpose (to preserve WS connect-frame order)
  or a fire-and-forget git call on every attach, including the many that already
  have a live runner. Both are wider than this change and are left for a call.

## Key files

- `src/server/shared/git.ts` — `forcePush`, `forcePushWithLease`,
  `refuseRewindingForcePush`, `hasCommit`
- `src/server/orchestrator/services/push-target-guard.ts` —
  `findSharedBranchRefusal`
- `src/server/orchestrator/services/github.ts` — `quickCreatePr`,
  `agentCreatePr`
- `src/server/orchestrator/services/pre-turn-reset.ts` —
  `checkResetPreconditions`
- `src/server/orchestrator/services/rebase-driver.ts` — `tryForcePush`,
  `pushIfAheadOfRemote`
- `src/server/orchestrator/services/release-prepare.ts` — the head check runs
  before the force-push, not inside `agentCreatePr` after it
- `docker/agent-hooks/block-branch-ops.mjs` — `offends`, `offendsDestructive`,
  `unquote`
- `src/server/orchestrator/git-utils.ts` — `pushToOrigin`, `PushSkip`
- `src/server/orchestrator/checkout-durability.ts` — `ensureBranchTipOnOrigin`
- `src/server/orchestrator/services/branch-sync.ts` — `guardMergeSync`
- `src/server/orchestrator/services/session-fork-merge.ts` — `forkSession`,
  `mergeSession`
- `src/server/orchestrator/services/git.ts` — `gitPush`
- `src/server/orchestrator/git-utils.ts` — `syncLocalDefaultBranchToOrigin`,
  `localDefaultIsSafeToMove`
- `src/server/orchestrator/services/session.ts` — `restoreSessionWorkspaceImpl`,
  `restoreInPlace`
- Guards: `src/server/shared/git-force-push-rewind.test.ts`,
  `src/server/shared/git-push-refspec.test.ts`,
  `src/server/orchestrator/services/push-target-guard.test.ts`,
  `src/server/session/agent-shim/block-branch-ops.test.ts`
