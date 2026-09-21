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

## Known gaps, deliberately not closed here

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
- **An ordinary push to a shared branch is still allowed.** `pushToOrigin`
  (auto-push), `checkout-durability.ts` and `branch-sync.ts` all push whatever
  is checked out. None can rewind — git declines a non-fast-forward — but each
  could fast-forward the base with a commit belonging to no pull request.
  Guarding `pushToOrigin` was tried and reverted: it stops auto-push for any
  session legitimately working on the default branch, which is a behaviour
  change wider than this incident and a call for a human to make. Open question
  in `requirements.md`.
- **A stale local `main` is still created.** `syncLocalDefaultBranchToOrigin`
  is not called from the restore and unarchive paths. Healing it there would
  reduce the blast radius but is not the guarantee; refusing the push is.

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
- Guards: `src/server/shared/git-force-push-rewind.test.ts`,
  `src/server/shared/git-push-refspec.test.ts`,
  `src/server/orchestrator/services/push-target-guard.test.ts`,
  `src/server/session/agent-shim/block-branch-ops.test.ts`
