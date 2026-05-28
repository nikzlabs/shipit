---
status: planned
priority: medium
description: ShipIt session branches are sometimes created from a stale main, so the agent starts without access to recently-merged docs and code (observed when picking up docs/153 work — the doc was on origin/main but missing from the session worktree until a manual fetch+rebase).
---

# 157 — Session branches created stale from main

## Symptom

A session was spun up to work on `docs/153-orchestrator-owned-claude-oauth-refresh`.
The branch `shipit/l6hw6g` was created off a `main` revision (`b55be0c3d`) that was
**619 commits behind `origin/main`** at session start.

Concrete impact:

- The user's first prompt pointed me at `docs/153-orchestrator-owned-claude-oauth-refresh/plan.md`.
- That doc exists on `origin/main` but did not exist in the session's worktree.
- I had to report "no such plan" and ask the user to clarify. Only after the user
  manually requested a fetch + rebase did the doc appear.
- The `recent commits` block in the session bootstrap context (`b55be0c3d Fix
  session-namer ...`, `1998c208d Add .update-requested to .gitignore`, etc.)
  matched a `main` snapshot from ~16 docs ago — there are now 070-156 in the
  series, the session saw up to ~083.

## Why this is a bug

Sessions are the unit of work the agent operates on. The agent's mental model of
"the codebase" comes from what's in the worktree. If the worktree is created off a
stale `main`, then:

1. **Agents can't see recently-merged design docs**, so any task that says
   "implement doc NNN" silently fails when NNN is newer than the snapshot.
2. **Agents may reintroduce bugs that were fixed on main**, because the code they
   read doesn't reflect the fix.
3. **Agents may "discover" missing files** (modules, helpers, plan docs) and
   propose to create them, duplicating work already merged.
4. **PRs from the session need a long rebase later** — 619 commits of drift in
   this case — increasing conflict surface.

This is a silent failure: there is no warning in the session bootstrap. The
agent only finds out by accident, when a referenced path 404s in its tools.

## Suspected mechanism

Open question — needs confirmation from someone with `RepoGit` context. Plausible
causes:

- The shared repo clone backing this session's worktree (`git-architecture` skill:
  `RepoGit`) hadn't been fetched recently. Worktree creation branches from the
  shared clone's local `main`, not from `origin/main`, so a stale clone yields a
  stale session branch.
- The warm session pool (`session-lifecycle`) may pre-create worktrees against
  whatever `main` was current at warm-up time, then hand the warmed session out
  much later without re-fetching.
- A scheduled `git fetch` on the shared clone may have been failing silently, or
  may not exist at all.

The 619-commit gap argues against a "just stale by a few minutes" race — this
clone hadn't been updated in a non-trivial amount of time.

## Proposed fix (sketch)

Not designed in detail here — this doc files the bug so it can be triaged.
Possible directions:

1. **Fetch on session create.** Before creating the worktree (or right after, but
   before the agent gets control), run `git fetch origin main` on the shared clone
   and reset its local `main` to `origin/main`. Cost: one network round-trip per
   session create. Failure mode: offline / GitHub down → fall back to local main
   with a logged warning surfaced in the session bootstrap context.
2. **Fetch on warm-pool warm-up *and* on hand-out.** If warmed sessions are the
   problem, only fetching at warm-up time doesn't help; we need to refetch (and
   rebase the worktree if no edits yet) at the moment the warm session is
   assigned to a user prompt.
3. **Surface staleness in bootstrap.** As a minimum, include in the session
   bootstrap context how far the session branch is behind `origin/main` (commit
   count, or last-fetch timestamp). Even if we don't fix the staleness
   automatically, the agent and the user can spot it immediately.

The right fix likely combines (1) or (2) with (3) — fetch eagerly, but also
surface staleness so partial failures don't become silent again.

## Test plan (sketch)

- Unit on `RepoGit` (or its session-creation entry point): a session created
  against a clone whose `main` is N commits behind `origin/main` should either
  (a) fetch and create off the up-to-date tip, or (b) emit a structured warning
  containing the gap.
- Integration via `buildApp({ isTestMode: true })`: create a fake repo with a
  diverged shared clone, create a session, assert the session branch tip equals
  `origin/main` tip.
- Manual: trigger a session against a repo where a doc has been merged to main
  in the last few minutes; confirm the doc appears in the worktree.

## Out of scope

- Fixing already-stale sessions in flight. The mitigation there is the same as
  what just unblocked this session: a manual `git fetch origin main && git rebase
  origin/main`. Documenting this in the agent runbook is fine; auto-rebasing live
  sessions on every fetch is too invasive for a v1.
- Worktrees for *non-main* base branches. The pattern likely generalizes, but
  this bug was observed for `main`; widen scope after the fix lands.

## Key files (to investigate)

- `src/server/orchestrator/repo-git.ts` — `RepoGit` clone + worktree lifecycle
- `src/server/orchestrator/session-runner.ts` /
  `container-session-runner.ts` — session creation entry points
- `src/server/orchestrator/sessions.ts` — `SessionManager` persistence; check
  whether session metadata records the base commit it was forked from
- `src/server/orchestrator/api-routes-session.ts` — HTTP path for session create
- The warm-pool code path (see `session-lifecycle` skill) — confirm whether warm
  sessions refetch on hand-out

## Related

- [[153-orchestrator-owned-claude-oauth-refresh]] — the work that surfaced this
  bug. The session was spun up to implement that plan, and the plan was missing
  from the worktree.
