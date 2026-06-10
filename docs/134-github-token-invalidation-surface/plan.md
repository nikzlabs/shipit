---
issue: https://linear.app/shipit-ai/issue/SHI-107
description: Surface expired GitHub tokens to the UI, and only clear a stored token on an explicit 401 — never on a transient GitHub outage.
---

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
   It does **not** clear blindly — see "Only clear on proof, never on an
   outage" below.

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

## Only clear on proof, never on an outage

A stored token is the user's property — only an **explicit** signal that GitHub
itself rejected the credential, or an explicit user logout, may clear it. A git
operation failing is *not* such a signal: it can fail because the token expired,
or because GitHub is having an outage, is rate-limiting, or is unreachable. The
original design verified the token with `GET /user` before clearing, but folded
"GitHub says the token is bad" and "GitHub didn't answer" into a single
`null` — so during the kind of GitHub-wide outage that takes down both the git
push *and* the verification call, the token was wiped anyway, logging the user
out for an incident they didn't cause.

`checkGitHubToken(token)` (in `github-auth.ts`) replaces the boolean probe with
a three-way classification:

| Outcome | When | Effect on the stored token |
|---|---|---|
| `valid` | `200` with a user profile | preserved — the git failure was repo-specific (e.g. a fine-grained PAT whose scope excludes the repo) |
| `invalid` | `401` (the *only* credential-rejection status) | cleared + `token_invalid` emitted |
| `indeterminate` | `5xx`, `403`/`429` rate-limit, network/DNS/TLS error, timeout — i.e. a GitHub outage or transient | preserved; logged; retried on the next operation |

The same classifier guards three sites that previously cleared on any non-200:

- **`markTokenInvalid`** — clears only on `invalid`; `valid` and `indeterminate`
  both preserve the token and return `false` (no `token_invalid` event).
- **`loadUserInfo`** (boot) — clears only on `invalid`; on `indeterminate` it
  keeps the token (profile fields just stay unpopulated until a later check
  succeeds), so an orchestrator restart *during* an outage doesn't wipe creds.
- **`setToken`** (adding a new token) — never stores an unverified token, but
  now distinguishes the error message: "Invalid GitHub token" on `invalid` vs.
  "Couldn't reach GitHub to verify the token…" on `indeterminate`.

`validateGitHubToken` is retained as a thin `valid ? user : null` wrapper for
callers that genuinely treat both failure modes the same (optional profile
population). Anything that would *clear* a token must use `checkGitHubToken`.

The Claude/Codex OAuth refreshers already follow this principle independently:
they only flip an account to "revoked" on explicit terminal patterns
(`invalid_grant`, `401 invalid authentication credentials`), classify everything
else as `rate_limited`/`unknown_failure` with backoff, and never delete the
credentials file on a transient — so this hardening was GitHub-specific.

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
  it doesn't; **preserves the token on 5xx outage, network error, and 403
  rate-limit**), `checkGitHubToken` (valid / invalid / indeterminate
  classification), and `loadUserInfo` (clears only on 401, keeps the token on
  5xx and network errors at boot).
- `git-utils.test.ts` existing `fetchAndResolveDefaultBranch` test —
  assertions updated for the new `authError` return field.
- All 78 integration test files continue to pass (614 tests green).
