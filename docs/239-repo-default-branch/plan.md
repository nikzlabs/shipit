---
issue: https://linear.app/shipit-ai/issue/SHI-252
title: Repo default branch (stop hard-coding "main")
description: Resolve each repo's real default branch (main / master / trunk) and use it everywhere the UI and server previously assumed "main".
---

# Repo default branch

ShipIt assumed every repo's default branch was `main`. The literal string was
hard-coded in a dozen places across the client and server. On a repo whose
default branch is `master` (or `trunk`, or `develop`) every one of them was
wrong, and the failures were quiet rather than loud:

- **RebaseBanner** told the user "Branch is behind `main`" — naming a branch that
  doesn't exist — and "Update branch" rebased onto an unresolvable ref.
- **PrActionsMenu** offered "Sync with main" pre-PR, with the same broken rebase.
- **The ready card's diff stats** came from `diffStatVsBranch("main")`, which has
  no ref to diff against, so a branch full of changes reported +0/-0.
- **"Changes vs main"** hit `GET /git/diff-vs-branch?base=main`, which 400s with
  `Cannot resolve base branch: main`.
- **The Docs panel's "modified in this session"** flags came from the same
  unresolvable merge-base, so nothing was ever flagged.
- **`isDefaultBranch`** matched a hard-coded `{main, master}` set, so a `trunk`
  repo rendered a redundant "trunk ← shipit/xyz" branch label.

## Design

Two independent sources of truth, because the two layers need different things.

### Server: `GitManager.getDefaultBranch()`

Any server path that already holds a session's `GitManager` can ask the clone
itself. It reads `refs/remotes/origin/HEAD` — written by `git clone` and
propagated from the bare cache into each per-session clone — so it costs one
local ref read: no network, no credential prompt. It falls back to probing
`origin/main` then `origin/master`, and finally to the literal `"main"`, which
is the guess every caller made before, so the worst case is exactly the old
behavior and never worse.

This is what the PR-lifecycle emitters, the docs-panel route, and
`graduate-session` use. No new dependency injection was needed.

### Client: `RepoInfo.defaultBranch`

The browser has no git. It needs the value on data it already receives, before
any PR exists. So the default branch is resolved once per repo from the **bare
cache** (`RepoGit.getDefaultBranch()`), persisted on the repo row, and shipped
out on the existing `repo_list` SSE.

Resolution happens at two points, both off the request path and both
best-effort:

1. **After a clone completes** (`POST /api/repos` background clone) — the bare
   cache's HEAD is authoritative the moment `git clone --bare` returns.
2. **Once at boot** (`refreshAllRepoDefaultBranches` in `bootstrap-managers`) —
   so repos added before this field existed, and repos whose remote renamed its
   default branch, pick the value up without the user re-adding them.

A repo whose cache isn't on disk, or whose HEAD can't be read, keeps
`defaultBranch` undefined; `useSessionDefaultBranch` then returns `"main"`, so
hydration order never breaks a render.

### Why not one mechanism?

A single repo-store lookup would have forced `repoStore` into `PrLifecycleDeps`
and several other dependency bundles that have no business knowing about the
repo registry. A single git-read would have forced the client into an HTTP
round-trip per card render. Each layer uses the source it can reach cheaply, and
they agree because they read the same underlying HEAD.

## Key files

| File | Role |
|---|---|
| `src/server/shared/git.ts` | `GitManager.getDefaultBranch()` — reads the session clone's `origin/HEAD`. |
| `src/server/orchestrator/services/repo-default-branch.ts` | Resolves + persists from the bare cache; `repoDefaultBranch(repoStore, url)` is the server-side lookup. |
| `src/server/orchestrator/repo-store.ts` | `setDefaultBranch` + `default_branch` column mapping. |
| `src/server/shared/database.ts` | `ALTER TABLE repos ADD COLUMN default_branch TEXT` migration. |
| `src/server/shared/types/domain-types/session.ts` | `RepoInfo.defaultBranch`. |
| `src/server/orchestrator/bootstrap-managers.ts` | Boot sweep. |
| `src/server/orchestrator/api-routes-session-repos.ts` | Post-clone resolution + `repo_list` broadcast. |
| `src/server/orchestrator/api-routes-git.ts` | `diff-vs-branch` resolves the base when the query param is absent. |
| `src/client/utils/default-branch.ts` | `useSessionDefaultBranch(sessionId)` and the pure resolvers. |

Client call sites now reading the real branch: `RebaseBanner`, `PrActionsMenu`,
`PrLifecycleCard` (+ `PrLifecycleCard/shared`: `useOpenPrDiff`, `BranchLabel`,
`isDefaultBranch`), `pr-detail/PrFilesSection`, `stores/git-store`.

## Notes

- `git-store.fetchDiffVsBranch` no longer defaults `baseBranch` to `"main"`.
  Omitting it now sends no `?base=` at all, and the **server** resolves the
  repo's default — one fewer place for the two layers to disagree.
- `isDefaultBranch(branch, repoDefault?)` prefers the repo's actual default and
  only falls back to the conventional `{main, master}` set when it isn't known
  (no session, repo list not hydrated). That fallback is what keeps the branch
  label sensible during the first paint.
- `getSessionChangedPaths`'s `baseBranch` parameter is now required. It had a
  `= "main"` default that silently produced an empty change set; making it
  required means a new caller has to decide.
