---
status: planned
---

# Remove Standalone Session Creation Path

## Context

ShipIt has three session creation paths: standalone (no repo), worktree fork, and warm pool. The standalone path is obsolete — every session now requires a repo. The warm pool is the primary creation path; worktree fork remains for the rollback "fork as new session" feature.

The standalone path creates sessions via `git init` with no remote, no worktree, and no connection to a shared repo. This path should be removed entirely. The warm pool path should handle all session creation, including empty repos.

## Current Standalone Session Flow

1. **`POST /api/sessions`** — creates a session directory, runs `git init`, no remote URL
2. **`send_message` without `sessionId`** — server-side fallback that creates a standalone session on the fly
3. **`send_message` with missing workspace** — recreates the directory and re-runs `git init`
4. **Empty repo warm sessions** — fall back to standalone mode (`git init` + `git remote add`) instead of worktree

Client-side, the only remaining trigger is `App.tsx` `handleSendMessage`: when there's no `sessionId`, it calls `POST /api/sessions` before sending the message.

## Fresh Main Invariant (done)

New sessions must never start from stale `origin/main`. Previously, `warmSessionForRepo()` only called `git fetch` when re-warming (after a session was claimed), not during initial warming. The sync fallback in `claim-session` also skipped fetch.

**Fix**: `git fetch origin` now runs unconditionally in `warmSessionForRepo()` and in the `claim-session` sync fallback path. Since warming is fire-and-forget in the background, there is no user-visible latency.

## Design

### Empty Repo Handling

Empty GitHub repos have no commits, so `git worktree add` fails (no valid start point). Instead of falling back to standalone mode, create an initial empty commit in the shared repo first, then proceed with the normal worktree flow. This keeps all sessions as worktrees with a consistent lifecycle.

### Changes

**Server — remove standalone creation:**

- **`api-routes.ts`**: Remove `POST /api/sessions` endpoint
- **`send-message.ts`**: Remove the no-`sessionId` fallback that creates a standalone session. Remove the missing-workspace recreation path (worktree sessions can't be casually recreated anyway — the git linkage must be intact)
- **`index.ts` / `createSessionDir`**: Remove the `git.init()` path (non-`skipGitInit`). Simplify or inline since it's always called with `skipGitInit: true`

**Server — fix empty repo warm sessions:**

- **`index.ts` / `warmSessionForRepo`** and **`api-routes.ts` / `claim-session`**: When the shared repo is empty, create an initial commit in the shared repo before creating the worktree. Replace the standalone fallback (`git init` + `git remote add`) with the normal worktree flow

**Client — remove no-repo session creation:**

- **`App.tsx` / `handleSendMessage`**: Remove the `!sessionId` → `POST /api/sessions` branch. Messages should only be sent to existing sessions

**Types:**

- **`domain-types.ts`**: Remove `"standalone"` from `sessionType?: "standalone" | "worktree"`. Simplify to just `"worktree"` or remove the field if all sessions are now worktrees

**Tests:**

- Remove or update tests that exercise standalone session creation
- Add test for empty repo → initial commit → worktree flow
