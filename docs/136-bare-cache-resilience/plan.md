---
status: done
---

# Bare cache resilience — no token leak, self-healing recovery

## Problem

Two related issues surfaced together when a user clicked the "new session"
URL for a repo whose on-disk bare cache had gone missing:

```
POST /api/repos/<encoded-url>/claim-session
500
{"error":"Failed to claim session: Cannot use simple-git on a directory that does not exist"}
```

Looking deeper, the response body — and any other surface that echoed the
remote URL — also contained the user's GitHub PAT:

```
https://x-access-token:ghp_REDACTED@github.com/owner/repo.git
```

Two distinct bugs, with one common root in how the bare cache is managed:

1. **Token leak.** Every code path that touched a repo's bare cache called
   `githubAuthManager.getAuthenticatedCloneUrl(url)` and then
   `cacheGit.setRemoteUrl(authedUrl)`. The result was that the cache's
   `remote.origin.url` was stored as `https://x-access-token:TOKEN@github.com/...`.
   Any git operation that surfaced the URL (a failing `setRemoteUrl`, a
   non-zero `git fetch`, a stray `git remote -v` in a diagnostic dump,
   the HTTP error body that bubbled up through claim-session) leaked the
   token to the caller, to journalctl, and — in the user's case — to the
   browser network tab.

2. **No recovery for a missing cache.** The DB record's `status` field
   said "ready" but the actual `repo-cache/<hash>` directory wasn't on
   disk. Causes are easy: a manual `docker volume` wipe, an interrupted
   clone, a janitor sweep that ran against an older DB state, a developer
   poking around inside the orchestrator container. None of these update
   the DB. The next claim-session ran `createRepoGit(cacheDir)` →
   `cacheGit.setRemoteUrl(...)` against a non-existent directory and blew
   up. The repo was stuck until the user removed and re-added it
   manually.

Both bugs share a cause: the bare cache was treated as an *invariant* —
"the DB says ready, so the cache must exist and must have a fresh token
in its URL" — instead of as *cheap derived state* that any code path can
recreate from the remote.

## Design

### Fix 1 — stop embedding tokens in URLs

Drop `GitHubAuthManager.getAuthenticatedCloneUrl(repoUrl)` entirely. The
global git credential helper installed by `setGlobalCredentialHelper` (see
`docs/015-github-auth` and `src/server/orchestrator/git-config.ts`) already
supplies the token for every git operation in every workspace, because
the orchestrator and every session container both point
`GIT_CONFIG_GLOBAL` at `/credentials/.gitconfig`. Embedding the same
token in the URL was strictly redundant.

The seven call sites that used to pass an authed URL now pass the plain
URL:

| Site | What it did | What it does now |
|---|---|---|
| `api-routes-session.ts` — "add repo" background clone | `cloneBare(authedUrl)` | `cloneBare(repoUrl)` |
| `api-routes-session.ts` — claim-session slow path | `setRemoteUrl(authedUrl)` before fetch | `setRemoteUrl(repoUrl)` to normalize |
| `warm-pool-manager.ts` | `setRemoteUrl(authedUrl)` before fetch | `setRemoteUrl(repoUrl)` to normalize |
| `services/session.ts` — `unarchiveSession` (re-clone case) | `cloneBare(authedUrl)` | `cloneBare(repoUrl)` |
| `services/session.ts` — `unarchiveSession` (fetch case) | `setRemoteUrl(authedUrl)` | `setRemoteUrl(repoUrl)` to normalize |
| `services/session.ts` — `postMergeCleanup` branch delete | `setRemoteUrl(authedUrl)` | `setRemoteUrl(repoUrl)` to normalize |
| `disk-janitor.ts` — orphan-branch sweep | `setRemoteUrl(authedUrl)` | `setRemoteUrl(repoUrl)` to normalize |

The `setRemoteUrl(repoUrl)` calls are deliberately kept, not deleted,
because **existing on-disk caches still have an embedded token in their
`config` file from the old code path**. Overwriting on first touch
normalizes the URL forward — the leaked token never persists past one
warm/claim/janitor pass. The pattern is idempotent: re-writing the same
plain URL on every touch is free.

### Fix 2 — self-heal a missing or corrupt bare cache

Add a helper `ensureBareCache(cacheDir, repoUrl, createRepoGit)` in
`repo-git.ts`:

- A healthy bare cache has a `HEAD` file at its top level. Test that.
- Missing dir, empty dir, partial download — all fail the check.
- Recovery: `rm -rf` + `mkdir` + `cloneBare(repoUrl)`. Returns
  `{ git, recovered }` so the caller can re-sync the repo store after a
  recovery.

Used in two places:

- **Claim-session slow path** (`api-routes-session.ts`) — the actual bug.
  The previous `createRepoGit(cacheDir)` is replaced with
  `await ensureBareCache(...)`. The DB record stays "ready"; the on-disk
  cache catches up.
- **Unarchive** (`services/session.ts`) — already had an inline existence
  check + re-clone, now uses the shared helper. No behavior change, just
  unified.

Three call sites deliberately do NOT use the helper:

- **Warm-pool** (`warm-pool-manager.ts`) keeps its silent-skip on missing
  cache. Warming is best-effort; re-cloning on warm-pool startup would
  block other repos from warming and chew network bandwidth at boot.
  The next user-triggered claim will recover lazily, which is when the
  cost of a re-clone is actually worth paying.
- **Disk-janitor orphan-branch sweep** (`disk-janitor.ts`) skips repos
  with no cache. A janitor has no work to do on an absent cache — it's
  not the recovery path.
- **postMerge branch cleanup** (`services/session.ts`) similarly skips on
  failure. Cleanup is housekeeping, not load-bearing.

## Why not a startup reconciliation pass?

`startup-tasks.ts` already validates warm sessions at boot (it checks
that each warm session's `workspaceDir` exists and re-warms if not).
Extending that pass to validate every repo's bare cache would also work,
but it has costs:

- Cloning at boot blocks the orchestrator from accepting requests.
- A repo the user hasn't touched in months may never need its cache
  back; cloning eagerly wastes network and disk.
- The lazy path covers the user-visible failure mode (claim-session
  works again) at the right moment.

The boot-time cost is non-trivial — the leaked-cache repo in the
incident was only noticed because the user clicked its new-session
link. Lazy recovery costs the user one slightly-slower claim. Eager
recovery costs every restart a network round-trip per stale repo.

If a future failure mode shows up where multiple caches go missing
simultaneously (e.g. a volume mount swap), revisit and consider a
background reconciliation pass after boot.

## Key files

- `src/server/orchestrator/github-auth.ts` — `getAuthenticatedCloneUrl`
  removed from `GitHubAuthManager`.
- `src/server/orchestrator/integration_tests/test-helpers.ts` — stub
  shim removed.
- `src/server/orchestrator/repo-git.ts` — new `ensureBareCache`
  function.
- `src/server/orchestrator/api-routes-session.ts` — claim-session slow
  path uses `ensureBareCache`; "add repo" background clone uses the
  plain URL.
- `src/server/orchestrator/services/session.ts` — `unarchiveSession`
  uses `ensureBareCache`; both unarchive and `postMergeCleanup` pass
  plain URLs.
- `src/server/orchestrator/warm-pool-manager.ts` — passes plain URL.
- `src/server/orchestrator/disk-janitor.ts` — passes plain URL.
- `src/server/orchestrator/repo-git.test.ts` — unit coverage for
  `ensureBareCache` against missing, empty, corrupt, and valid caches.
- `src/server/orchestrator/disk-janitor.test.ts` — stub no longer
  defines `getAuthenticatedCloneUrl`.

## Out of scope

- **Rotating the leaked token.** The original incident used a real PAT
  that was echoed in chat. The token itself needs to be revoked from
  GitHub by the user; this design doc only closes the leak path so
  future tokens stay private.
- **`configureGitCredentials` per-workspace backfill.** The global
  credential helper handles this now (see `docs/015-github-auth`), but
  the per-workspace call still runs as defense-in-depth. Removing it
  was considered out of scope here because the leak fix is independent
  and the backfill is harmless.
- **Recovery from a corrupt cache with a still-good remote token in its
  config.** The fix wipes the cache on recovery, so any embedded token
  is dropped anyway. This is intentional — the cache is cheap derived
  state, treat it as such.
