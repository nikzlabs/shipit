---
issue: nikzlabs/shipit#1874
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

### 3. Recognizing the failure at all (the 2026-08 follow-up)

Both mechanisms above hang off one signal: the CLI process emitting
`auth_required`. That signal was **never raised in production** for the most
common auth failure, so neither mechanism ever ran.

`resultEventIndicatesAuthFailure` gated on `subtype === "error"` — a value the
Claude Code CLI does not emit. Captured from a real unauthenticated
`claude -p --output-format stream-json` run (CLI 2.1.219), the failure is two
events:

```jsonc
{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
  "text":"Not logged in · Please run /login"}]},
  "error":"authentication_failed","is_api_error_message":true}
{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
  "result":"Not logged in · Please run /login"}
```

`subtype` is `"success"`; `is_error` is the failure flag. So detection missed
both events, and the synthetic assistant message — an error envelope, not model
output — was rendered as the agent's reply. The user's whole experience of an
auth failure was the CLI telling them to run `/login`, a command that does not
exist anywhere in ShipIt, followed by the next message working because the
scheduled refresher had healed the source token in the meantime.

The fix, in `agents/claude/process.ts`:

- **`resultEventIsError`** — `is_error === true || subtype !== "success"` is the
  failure test. The only non-success subtypes the CLI emits are
  `error_during_execution` (an interrupt) and `error_max_turns`.
- **`resultEventIndicatesAuthFailure`** uses it, still ignoring *successful*
  results: `AUTH_ERROR_PATTERNS` contains generic words ("oauth", "sign in") a
  legitimate final answer could contain.
- **`assistantEventIndicatesAuthFailure`** — new. Requires
  `is_api_error_message`, so a model that merely talks about signing in can't
  trip it, and matches on the `error` code (`authentication_failed`) or the
  text. Firing here recovers the turn one event earlier than the result would.
- Both events are **swallowed** rather than forwarded. An auth failure ends the
  turn and ShipIt owns what happens next — the quiet heal-and-retry (where a
  half-rendered failed turn would flicker in and have to be undone) or the
  sign-in card. This matches the shape the rest of the system already expects:
  a turn dying on the stderr auth path emits no `agent_result` either, and
  `turn-executor` documents that an auth-required turn legitimately ends
  without one.

**Adjacent, from the same incident report:** an `agent_tool_result` whose
`content` is a bare string (permitted by the Anthropic message schema; the
adapter forwards `message.content` untouched) threw
`TypeError: content.filter is not a function` out of the SSE event parser
mid-turn, stranding the turn and requeuing an unacknowledged steer. Two call
sites cast `content` to `unknown[]` without checking —
`agent-listeners`' AskUserQuestion suppression filter and
`extractToolResults` — while their neighbour `stampToolDurations` had the
`Array.isArray` guard all along. Both now guard the same way.

The same `subtype === "error"` assumption sat in `ClaudeAdapter`'s result
mapping, so `agent_result.error` was **always** `undefined` and two unrelated
features gated on it were dead in production: the docs/182 turn-errored flag
(`session.lastTurnErrored`, which `shipit session wait` reads) and the docs/150
req 7 quota-exhaustion stamp that makes the *next* turn fail over to another
account. The adapter now normalizes `is_error` / non-success subtypes into its
`success | error` status.

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

- `session/agents/claude/process.ts` — `resultEventIsError`,
  `resultEventIndicatesAuthFailure`, `assistantEventIndicatesAuthFailure`,
  `consumeAuthFailureEvent` (the drain-loop gate that raises `auth_required`
  and swallows the CLI's error copy).
- `session/agents/claude/adapter.ts` — `is_error`-based `agent_result` status /
  error mapping.
- `ws-handlers/agent-event-normalizer.ts`, `ws-handlers/agent-listeners.ts` —
  `Array.isArray` guards on `agent_tool_result.content`.
- `shared/types/claude-types.ts` — `ClaudeResultEvent.is_error` /
  `terminal_reason`, `ClaudeAssistantEvent.is_api_error_message` / `error`.
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
- `session/agents/claude/auth-detection.test.ts` — the real CLI payloads
  (`subtype:"success"` + `is_error`, the synthetic assistant envelope), the
  no-false-positive cases (a model reply that discusses signing in; a non-auth
  API error), and `resultEventIsError`.
- `session/agents/claude/process.test.ts` — the drain loop raises
  `auth_required` for both events and forwards neither, while a normal
  assistant message + clean result still pass through.
- `integration_tests/ask-user-question.test.ts` — a string-valued
  `tool_result.content` passes through intact while suppression is active
  instead of throwing.
- `integration_tests/auth-401-auto-retry.test.ts` — end-to-end dispatch path:
  heal succeeds → silent re-dispatch + completion; heal fails → card, no
  re-dispatch; bounded (second 401 on the retry surfaces the card, heal runs
  once).
