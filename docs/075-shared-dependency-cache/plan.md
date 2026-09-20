
# Shared Dependency Cache

## Problem

When a new session installs dependencies (`npm install`, `yarn`, `pnpm install`), the package manager downloads every package from the network. On slow connections this takes a long time. Since all sessions for the same repo use the same `package.json`, the downloads are redundant — the second session re-downloads everything the first already fetched.

## Solution

Mount a **per-repo dependency cache directory** into every session container. Package managers already support cache directories — we just need to:

1. Create a stable cache directory alongside the shared repo clone (`/workspace/repos/{hash}/.dep-cache`).
2. Mount it into every session container at `/dep-cache`.
3. Set the standard cache environment variables so npm/yarn/pnpm use it automatically.

### Cache env vars

| Package manager | Env var | Value |
|-----------------|---------|-------|
| npm | `npm_config_cache` | `/session-state/npm-cache` — per session, with `_cacache/content-v2` symlinked to `/dep-cache/npm/_cacache/content-v2` (`docs/276-shared-package-cache-integrity` section 1). Sharing the resolution index was install-time RCE between sessions of one repo. |
| yarn (v1) | `YARN_CACHE_FOLDER` | `/dep-cache/yarn` |
| yarn (berry) | `YARN_CACHE_FOLDER` | `/dep-cache/yarn` |
| pnpm | — | Nothing. `PNPM_STORE_DIR=/dep-cache/pnpm` was set until 2026-09-20 and never took effect — it is not a pnpm config env (measured on 12.5.1 with `pnpm store path`) — so `/dep-cache/pnpm` was only ever an empty directory. pnpm now has a store private to each session, mounted at `/workspace/.pnpm-store` (`docs/276-shared-package-cache-integrity` section 5); a directory every session of the repo could write is what H2/H4 attack. |

### Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/container-lifecycle.ts` | Add `depCacheDir` to `buildMounts()`, add cache env vars to `buildEnv()` |
| `src/server/orchestrator/session-container.ts` | Add `depCacheDir` to `ContainerConfig` |
| `src/server/orchestrator/app-lifecycle.ts` | Create `getDepCacheDir()` helper, wire through runner factory |
| `src/server/orchestrator/session-runner.ts` | Add `depCacheDir` to `SessionRunnerFactory` opts |
| `src/server/session/install-runner.ts` | Pass cache env vars to install subprocess |

### Mount strategy

Uses the same volume/bind mount pattern as `sharedRepoDir`:
- **Bind mount mode**: `{depCacheDir}:/dep-cache:rw`
- **Volume mode**: volume subpath mount to `/dep-cache`

The cache directory is per-repo (not per-session) so all worktree sessions for the same repo share the cache. Standalone sessions don't get a cache mount (they have no shared repo).

### Concurrency safety

npm, yarn, and pnpm all handle concurrent cache access safely — they use temporary files + atomic renames when writing to the cache. Multiple sessions installing simultaneously is safe.
