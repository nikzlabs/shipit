---
issue: https://linear.app/shipit-ai/issue/SHI-115
description: Session clones left local `main` frozen at the stale bare-cache snapshot even though the session branch was cut from the fresh origin/main, so an agent reviewing its own PR via `main..HEAD` reported already-merged commits as part of the branch. Fixed by realigning local `main` to `origin/main` at session hand-out.
---

# 194 — Local `main` tracks `origin/main` on session create

## Symptom

When the user asks the agent to "review the PR I just created", the agent
sometimes lists commits that are **already on `main`** as if they were part of
the branch. The PR itself is correct on GitHub — the confusion is purely in the
agent's local view.

## Mechanism

Every session clone is cut with `git clone --local` from the per-remote **bare
cache**, whose `refs/heads/main` is a *snapshot* that can sit a few commits
behind the real `origin/main`. The three session-provisioning paths then:

1. `fetchAndResolveDefaultBranch(workspaceDir)` — fetches the **real** remote so
   `origin/HEAD` / `origin/main` resolve to the genuine latest commit
   (`resetTarget`). This was the docs/157 fix.
2. Cut the session branch off that fresh `resetTarget` (`git checkout -b
   shipit/xxx <resetTarget>`), or hard-reset the reused clone to it.

So the **branch tip** is correct (latest `origin/main` + the session's work).
But the **local `main` ref** is never moved — it stays pointing at the stale
bare-cache snapshot. Concretely, with snapshot at `A`, `origin/main` at `C`
(`A→B→C`), and the session branch at `C→X→Y`:

- GitHub PR diff = `origin/main...branch` = `X, Y` ✓
- ShipIt's own `diffStatVsBranch` / `resolveBaseBranchRef` prefer `origin/main`
  → `X, Y` ✓
- Agent's `git log main..HEAD` = `A..Y` = **`B, C, X, Y`** ✗ — `B` and `C` are
  already on `main` but ahead of the frozen local ref.

`B` and `C` are the spurious commits the agent attributes to the PR.

This is distinct from docs/157 (where the branch *itself* was cut from a stale
main — a frozen bare cache). docs/157 fixed the branch base; this fixes the
lagging **local ref** the agent reaches for when it types `main` by hand.

## Fix

`syncLocalDefaultBranchToOrigin(workspaceDir)` in `git-utils.ts`: resolve
origin's default branch name (via `origin/HEAD`, falling back to probing
`origin/main` / `origin/master`) and `git branch -f <branch> origin/<branch>`.

It is a pure ref move — never touches the working tree or index — and refuses to
move the checked-out branch (at every call site HEAD is the `shipit/*` branch,
so `main`/`master` is never current). Best-effort and non-fatal: a detached
HEAD, a missing `origin/*` ref, or any git error just skips.

Wired into all three hand-out paths so they can't drift:

- `warm-pool-manager.ts` — after `checkout -b` at warm time.
- `claim-session.ts` slow-clone path — after `checkout -b`.
- `claim-session.ts` `refreshCloneToLatestMain` (warm / reuse hand-out) — after
  the `rollback(resetTarget)`.

## Test plan

`git-utils.test.ts` → `describe("syncLocalDefaultBranchToOrigin")`:

- Mirrors the real flow (remote@c1 → bare cache → `--local` clone → remote@c2 →
  fetch → branch off `origin/main`) and asserts local `main` moves from `c1` to
  `c2` and `git log main..HEAD` is empty afterward.
- Refuses to move the checked-out default branch.
- No-op (no throw) when there is no origin default branch.

## Key files

- `src/server/orchestrator/git-utils.ts` — `syncLocalDefaultBranchToOrigin`
- `src/server/orchestrator/services/claim-session.ts` — slow-clone + refresh paths
- `src/server/orchestrator/warm-pool-manager.ts` — warm provisioning path
- `src/server/orchestrator/git-utils.test.ts` — regression tests

## Related

- [[157-session-branch-stale-from-main]] — fixed the branch *base* (frozen bare
  cache refspec). This doc fixes the lagging local `main` *ref* that survived
  that fix.
