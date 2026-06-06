---
title: New-session 401 — proactive OAuth heal + runtime-401 auto-retry
description: Kill the "new session 401 once a day" by healing the source OAuth token before it's read and silently re-dispatching a turn that 401s on a transient stale token.
---

# New-session 401: proactive heal + runtime-401 auto-retry

## The bug

Once in a while — empirically about once a day per active user — starting a
**new** session (or sending its first turn) surfaced a sign-in card even though
the user was already authenticated. Re-authenticating and re-sending the same
prompt always worked. AI session naming hit the same window: it silently 401'd
and the placeholder title stuck.

### Root cause

Claude OAuth uses a **rotating, single-use refresh token**. The orchestrator
runs a scheduled `ClaudeOAuthRefresher` that rotates the *source* token ahead of
expiry and re-pushes it into every pinned session (docs/153, docs/142). That
scheduler normally keeps the source comfortably fresh.

But the schedule can fall behind its **safety margin**: a run of `429` backoffs
(rate-limited token endpoint) eats the lead time the refresher relies on. A
session that *starts* inside that degraded window does two things in sequence:

1. **Step 2** of env-prep copies the *current* source token into the session
   subtree (every turn — docs/142 A, because the rotating token goes stale the
   moment any other session rotates it).
2. The CLI spawns and makes its first call with that token.

If the source token is within (or past) its margin at step 1, the session syncs
in a **dying token** and the CLI **401s on its first call** — the report.

The scheduled refresher alone can't close this: it's a *background* loop, and
the failing session starts in the exact gap where the loop is behind.

## The fix — two complementary mechanisms

### 1. Proactive pre-read heal (`ensureFresh`)

`ClaudeOAuthRefresher.ensureFresh(accountId?)` is a cheap, hot-path-safe
"make the source token usable before someone reads it":

- **Healthy token** (more than `safetyMarginMs` of life left): returns `true`
  immediately, **no CLI spawn**. This is the common case, so the call is
  near-free.
- **Within margin or expired**: awaits a **single-flight** `runTickForAccount`
  (so a scheduled tick or a concurrent caller already refreshing is *awaited*,
  not duplicated), then reports whether the token is usable afterward.
- **Never throws**; resolves `false` only when the token is missing or still
  expired (rate-limited / revoked). No-op (`true`) outside containerized
  runtime, matching `refreshNow`.

It is called at the two read sites that precede a CLI call against the source
credentials, **before** the dying token can be copied/used:

- **Session start** — `prepareSessionAgentEnvironment` Step 2a, before Step 2
  copies the token into the session. Time-bounded + fail-open
  (`ENSURE_TOKEN_FRESH_TIMEOUT_MS`) like the other env-prep steps.
- **AI session naming** — `graduateSession` → `scheduleSessionNaming`, before
  `generateSessionName` shells out to `claude -p`. Best-effort: a failed heal
  just falls through to the CLI (placeholder title sticks, exactly as before).

### 2. Runtime-401 auto-retry

A proactive heal can still miss (the margin was fine at start but the token
rotated out from under a long env-prep, or a non-Claude path). So the turn
executor also **recovers at the point of failure**:

When a turn's CLI emits `auth_required`, the `agent-listeners` handler asks the
executor — **synchronously, before it kills the agent** — `willRecoverAuth()`.
It returns true only for a **first-attempt** turn with a healer wired, and flips
a stand-down flag so the executor's `done` handler defers all terminal work to
the recovery. On the quiet path the listener emits **no sign-in card and starts
no OAuth flow**; it calls `recoverAuth()`, which:

1. Awaits `ensureAgentTokenFresh(agentId)` (the same single-flight heal).
2. **Heal succeeds** → re-dispatches the *same* turn once on a fresh agent
   (same assembled prompt, so attachments and slash commands survive). The
   retried turn owns drain/commit/finished. `isAuthRetry` prevents a second
   recovery — **one quiet retry, then the card surfaces** — and a shared
   `persistGuard` keeps the user row at **exactly one copy** across both
   attempts.
3. **Heal fails** (revoked / rate-limited / no rotation) → runs the terminal
   teardown the `done` handler stood down from, then falls back to the
   **visible re-auth flow** (sign-in card + OAuth start).

On the quiet path the runner's `running` flag is deliberately **left set** so
the client doesn't flicker out of its loading state between attempts.

Net effect: a transient stale-token 401 recovers invisibly — no sign-in card,
no manual re-send.

## Wiring

`buildApp` (index.ts) builds an `ensureAgentTokenFresh(agentId, accountId?)`
keyed by agent (mirroring `onAgentAuthRequired`):

- **claude** → the refresher's `ensureFresh`. No refresher (test / local
  runtime) → resolves `false`, so proactive callers fail open (proceed) and the
  runtime-401 retry reads "couldn't heal" and correctly surfaces the card.
- **codex** → no hook; resolves to a no-op `true` (Codex auth isn't subject to
  the rotating-refresh-token stampede).

It's threaded to every place a turn or a source-credential CLI call originates:
`AppCtx` (WS turns), `ApiDeps` (AI naming via routes), `RunnerRegistryDeps`
(quick / child / CI-fix dispatched + system turns), `SystemTurnDeps` (the
executor's retry), `GraduateSessionDeps` (naming), and the env-prep deps
(`prepareSessionAgentEnvironment`). It is **optional everywhere** — tests and
local runtime omit it and get the legacy visible re-auth flow with no retry.

## Key files

- `agents/claude/oauth-refresher.ts` — `ensureFresh` / `ensureFreshOne`
  (single-flight pre-read heal).
- `session-agent-env.ts` — Step 2a pre-spawn heal; `ENSURE_TOKEN_FRESH_TIMEOUT_MS`,
  `ensureAgentTokenFresh` dep.
- `turn-executor.ts` — `willRecoverAuth` / `recoverAuth` / `authRecoveryInProgress`,
  `isAuthRetry`, `persistGuard` (persist-once), the `done` stand-down.
- `ws-handlers/agent-listeners.ts` — `auth_required` handler split into the
  quiet recovery path vs. `surfaceReauth`.
- `ws-handlers/types.ts`, `api-routes.ts`, `runner-registry-factory.ts`,
  `session-runner.ts`, `services/graduate-session.ts`,
  `ws-handlers/send-message.ts`, `ws-handlers/agent-execution.ts`,
  `index.ts`, `api-routes-session.ts` — `ensureAgentTokenFresh` plumbing.

## Tests

- `agents/claude/oauth-refresher.test.ts` — `ensureFresh`: healthy (no spawn),
  within-margin heal, revoked → `false`, no source → `false`, local-mode no-op.
- `ws-handlers/agent-listeners.test.ts` — `auth_required` handler: quiet heal
  (no card / `running` stays set), heal-fail fallback (card + OAuth), legacy
  flow when no hooks wired.
- `integration_tests/auth-401-auto-retry.test.ts` — end-to-end dispatch path:
  heal succeeds → silent re-dispatch + completion; heal fails → card, no
  re-dispatch; bounded (second 401 on the retry surfaces the card, heal runs
  once).
