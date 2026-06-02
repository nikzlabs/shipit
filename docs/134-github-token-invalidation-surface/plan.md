
# Surface expired GitHub tokens to the UI

## Problem

Before this change, when the user's GitHub PAT (or fine-grained token) expired or got
revoked, the only signal was a stack of `console.warn` lines on the orchestrator's
stdout — e.g. during warm-pool prefetch:

```
[git] fetchAndResolveDefaultBranch: origin fetch failed for /workspace/sessions/.../workspace
  (resolving from local refs instead): remote: Invalid username or token. Password
  authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/.../...git/'
```

The browser kept rendering `githubStatus.authenticated: true` until the user
reloaded the page, every new session silently branched from a possibly-stale local
snapshot, and the next auto-push failed for the same reason.

ShipIt's product principle is "ShipIt is the surface" (CLAUDE.md §1) — operational
signals the user needs to act on belong in the UI, not the server logs.

## Design

Three pieces:

1. **`isGitAuthError(err)`** in `git-utils.ts` — central detection of the
   canonical credential-failure strings (`Authentication failed`, `Invalid
   username or token`, `Password authentication is not supported`, `could not
   read Username`, `terminal prompts disabled`, `Bad credentials`, `401
   Unauthorized`, `403 Forbidden`). One predicate so every git call site
   classifies the same way.

2. **`GitHubAuthManager.markTokenInvalid(reason)`** — clears the stored token
   and emits a `token_invalid` event. Idempotent (no-op when no token is
   configured, so the unauthenticated-public-repo code path doesn't trip it).

3. **SSE `github_status` broadcast** wired in `app-lifecycle.ts` — pushes
   `{ authenticated: false, tokenInvalidReason }` to every connected client.
   `useServerEvents` listens, updates the settings store (so the sign-in card
   reappears in Settings → GitHub), and shows a Toast pointing back to that tab
   with a "Sign in" action button.

## Call sites that invoke `markTokenInvalid`

| Site | What was failing | What the user sees now |
|---|---|---|
| `fetchAndResolveDefaultBranch` (warm pool, claim slow-path, `refreshCloneToLatestMain`) | `git fetch origin` in the workspace clone — the warm path's branch point used to come from a stale snapshot, silently. | The "stale code" SSE warning is suppressed (it's not a staleness issue; it's an auth issue) and the toast surfaces. |
| Auto-push catch block in `index.ts` | `git push` after an agent turn. | Already used to write a `log_entry` to the per-session Logs panel; now also clears credentials and shows the toast. |

The detection is opt-in per call site via an optional `onAuthError` callback on
`fetchAndResolveDefaultBranch` — the helper degrades to its pre-existing
silent-on-failure shape if no callback is supplied, so tests and other callers
without access to `GitHubAuthManager` don't change behavior.

## Why a dedicated SSE event and not the existing `auth_required`?

`auth_required` is a Claude-OAuth flow signal — it stashes a URL in
`useSessionStore.setAuthUrl` and pops the Claude auth overlay. GitHub auth runs
through a different surface (Settings → GitHub → paste a PAT or device-auth),
and `WsGitHubStatus` already exists as the type carrier for that surface's state.
Adding a new SSE event name (`github_status`) keeps the two auth surfaces
independent.

## Key files

- `src/server/orchestrator/git-utils.ts` — `isGitAuthError`, updated
  `fetchAndResolveDefaultBranch` signature with `onAuthError` callback and a
  new `authError` field in its return tuple.
- `src/server/orchestrator/github-auth.ts` — `markTokenInvalid` method on
  `GitHubAuthManager`, emits `token_invalid` event.
- `src/server/orchestrator/app-lifecycle.ts` — `wireEventHandlers` now takes
  `githubAuthManager` and wires `token_invalid` → SSE broadcast.
- `src/server/orchestrator/index.ts` — auto-push catch block recognizes auth
  errors and routes them through `markTokenInvalid` instead of (or in
  addition to) the generic log entry. Also passes `githubAuthManager` to
  `wireEventHandlers`.
- `src/server/orchestrator/warm-pool-manager.ts`,
  `src/server/orchestrator/api-routes-session.ts` — pass `onAuthError`
  callbacks that route into `githubAuthManager.markTokenInvalid`.
- `src/server/shared/types/github-types.ts` — `WsGitHubStatus` gains an
  optional `tokenInvalidReason` field.
- `src/client/hooks/useServerEvents.ts` — listens for the SSE
  `github_status` event, updates the settings store, and shows a toast with
  a "Sign in" action.
- `src/server/orchestrator/integration_tests/test-helpers.ts` —
  `StubGitHubAuthManager` gains a `markTokenInvalid` shim so warm-pool
  integration tests don't crash when the fetch fails (which is normal in
  tests where origin is a fake URL).

## Test coverage

- `git-utils.test.ts` — unit tests for `isGitAuthError` (covers the exact
  user-reported stderr plus the other canonical strings; covers
  non-credential-related errors as the negative case).
- `github-auth.test.ts` — unit tests for `markTokenInvalid` (clears
  credentials + emits when a token exists, no-op + returns `false` when
  it doesn't).
- `git-utils.test.ts` existing `fetchAndResolveDefaultBranch` test —
  assertions updated for the new `authError` return field.
- All 78 integration test files continue to pass (614 tests green).
