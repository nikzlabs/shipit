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

### 4. The quiet retry that healed nothing, and the failure nobody could see

The 2026-08-02 production incident (session `bf04d140`) was a turn that died
**twice** on a Claude CLI 401 while the user saw *nothing* in chat — a prompt
with no reply, no error, no card. Two independent defects, one visible outcome.

#### 4.0. Not the same bug as #1886 — how to tell them apart

On the same day, PR #1886 fixed a *different* auth failure that killed several
dogfooding sessions, and the two were conflated in the cohort's incident
traffic. They are distinguishable by signature and by which credential root
they touch, so record the discriminator rather than re-deriving it:

| | #1886 (credential move) | docs/179 (dead-but-unexpired token) |
|---|---|---|
| Trigger | Running the test suite **inside a session container** | A production turn, no tests involved |
| Mechanism | `migrateProviderDefault`'s `fs.renameSync` moved `/credentials/.claude` — the container's live agent home — into `provider-accounts/claude/claude-default/` | A rotating single-use grant was invalidated without its `expiresAt` moving |
| Root touched | The **session's** `/credentials` bind mount | The **orchestrator's** account root, via `resolveCredentialRoot` (`oauth-refresher.ts:479`) |
| Signature | `.credentials.json` absent; `Not logged in · Please run /login`; permanent until re-auth | `.credentials.json` present and future-dated; 401; retry ~120ms later on byte-identical credentials |
| In the logs | One-shot kill | Six `auth healed` events in six hours, each reporting success with no `[claude-oauth-refresh]` line beside it |

The last row is the cheapest discriminator. A moved `.claude` makes
`readClaudeTokenExpiry` fail outright; it cannot produce a heal that reads a
future-dated timestamp and reports success, let alone six of them recurring
over hours. The two failures also never contend for the same file — the
suite's move lands in a session mount the refresher never reads.

Residual uncertainty, stated rather than resolved: the cohort's deaths and this
incident fall in the same six-hour window, so it is possible that some
surrounding auth noise from that window is #1886's and not this. The core
evidence above is not — it requires a present, readable, future-dated source
token, which is exactly the state #1886 destroys.

#### 4a. `expiresAt` is a proxy for ordering, never for validity

Four guards key off one number — `syncAgentTokenIn`, `syncAgentTokenBack`,
`ensureFreshOne`, and the refresher's tick scheduling all read `expiresAt` via
`TOKEN_FRESHNESS` → `readClaudeTokenExpiry`. But a rotating **single-use**
OAuth token's validity is *set membership*: only the newest token lives. Any
invalidation that isn't expiry — a sibling container rotating first (the
documented stampede at `session-runner.ts`'s `prepareAgentEnv` note), a
revocation, an account change — leaves a perfectly future-dated timestamp on a
token that is already dead. Every one of those guards is blind to it.

`ensureFreshOne` therefore short-circuited `return true` ("healthy; no work")
for exactly the token that had just produced a 401. Production: **six** `auth
healed` events in a six-hour window with **zero** `[claude-oauth-refresh]` log
lines beside them — every heal a no-op that reported success. The executor
re-dispatched ~120ms later on byte-identical credentials, failed again, and the
single shared `recoveryRetryUsed` budget was gone. Four of the six were
followed by a surfaced failure.

Worse, the guard actively **blocked** recovery: `syncAgentTokenInFromRoot`
skips the copy when `srcExp <= dstExp`, so a session holding a *dead token with
a later expiry than the source* never received the good source token. That is
the state that turns a recoverable 401 into a dead turn.

Three changes, all scoped to the **runtime-401 recovery path only** — the
proactive env-prep sweep (Step 2a) keeps its cheap short-circuit, which is
correct and near-free on the hot path:

- **`ensureFresh(accountId, { force: true })`** — the 401 path asks a different
  question ("give me a token nobody has used yet"), so it skips the healthy
  short-circuit and runs a tick that always reaches **Tier 2**: a real
  authenticated call that both *probes validity* (a dead grant surfaces
  `invalid_grant` → classified `revoked`) and triggers refresh-on-use. Tier 1
  is read-only for a token with margin, so without `force` the tick would
  return `noop` for precisely the failing token. The verdict is the tick's
  classification, not the timestamp: `revoked` / `missing_credentials` report
  **unhealed** so the card surfaces instead of the recovery budget being spent
  on a turn that cannot succeed.
- **A forced probe is not a scheduling event.** A forced tick on a token that
  wasn't near expiry and didn't rotate returns `noop` and re-arms the ordinary
  expiry-derived schedule, rather than reaching `handleFailure` — otherwise
  every session 401 would bump `failureCount` and replace that account's
  schedule with a backoff.
- **`repushSessionAgentToken`** (`session-agent-env.ts`) — force the source
  token into the failing session's subtree before the retry spawns, bypassing
  the sync-in's expiry-ordering guard. `repushAgentToken` /
  `repushProviderAccountToken` are the escape hatch the credential layer
  already ships for this state ("Distinct from `syncAgentTokenIn`, whose guard
  would skip a session holding a later-expiry-but-dead token"), wired until now
  only to the manual `auth_complete` re-login. Route-aware in the same way
  `finalizeSessionAgentEnvironment` is: account-pinned sessions (docs/150) go
  through `repushProviderAccountToken`, legacy null-route sessions through the
  shared root, `claude-env-oauth` sessions are left alone. Best-effort.

`syncAgentTokenBack` and its call sites are deliberately **untouched** — the
write-back publication timing is a separate concern.

#### 4b. The failure was invisible by construction

`surfaceReauth` reported the auth failure with `emitToViewers` →
`runner.emitMessage()`, which is **transport only**: it broadcasts to attached
viewers and buffers into the per-turn event log, and never writes persisted
chat history — the exact violation CLAUDE.md names under *"Chat transcript
content MUST be persisted, not just emitted"*. In production the user had no WS
viewer attached at either failure instant, and idle-cleanup disposed the runner
**five seconds** after the first error, destroying even the in-memory replay
buffer. Irrecoverable, and a switch/reload would have shown nothing either.

All three of the turn-ending error notices now go through **`emitChatCard`**
(`chat-card-persistence.ts`) — emit, record in-band, persist, in one call:

- the `auth_required` notice (`agent-auth-handler.ts`, now the exported
  `AGENT_NOT_AUTHENTICATED_MESSAGE` so tests assert the constant),
- the stale-resume notice ("Couldn't resume the previous conversation…",
  `agent-listeners.ts`),
- the empty-retry / no-result error in `turn-executor`'s `done`.

Recorded **in-band** (not appended) so `onInterruptedTurn`'s finalize rebuilds
each at its true transcript position alongside whatever partial output the turn
streamed, instead of the two racing to write separate rows. The auth path
additionally calls `finalizeInProgress` right after its emit — it is the one
turn ending that never finalizes (`done` skips `onInterruptedTurn` when
`sawAuthRequired`), so an `in_progress=1` row would be deleted by the next
turn's `replaceInProgress`, i.e. the docs/156 erasure bug.

The no-result error is also **suppressed on the auth path**: an auth-required
turn legitimately ends without an `agent_result`, and the listener has already
written the actionable persisted explanation. Emitting the generic one beside
it would show two errors live and one after a reload.

## Key files

### 2026-08-02 incident follow-up — rejected resume and retry transcript durability

A production turn exposed two recovery edges after it streamed visible work,
healed an auth failure, and retried against a Claude conversation id that
existed on disk but could not be resumed from `/workspace`:

- Leak repair validates and selects JSONLs only from Claude's
  `projects/-workspace` bucket. A structurally valid conversation from another
  encoded cwd is not resumable by the session CLI and cannot become the DB
  pointer.
- The shared executor recognizes `No conversation found with session ID`,
  identity-guards clearing against the exact id used by that process, and
  re-dispatches the same assembled turn once without `--resume`. Stale-resume
  and quiet-auth recovery share one retry budget.
- Before either automatic retry resets runner accumulators, visible assistant,
  tool, and card groups are finalized. An empty failed retry appends its error
  without deleting the first attempt, while the shared user-row guard prevents
  a duplicate prompt.

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
  (single-flight pre-read heal), the `force` validity-probe mode and its
  `noop` classification; `outputIndicatesRevoked`.
- `session-agent-env.ts` — Step 2a pre-spawn heal; `ENSURE_TOKEN_FRESH_TIMEOUT_MS`,
  `ensureAgentTokenFresh` dep; `repushSessionAgentToken` (401-recovery
  unconditional token push, route-aware).
- `turn-executor.ts` — `willRecoverAuth` / `recoverAuth` / `authRecoveryInProgress`,
  `isAuthRetry`, `persistGuard` (persist-once), the `done` stand-down; the
  forced heal + `repushSessionAgentToken` call; the persisted (and
  auth-suppressed) no-result error.
- `ws-handlers/agent-auth-handler.ts` — `AGENT_NOT_AUTHENTICATED_MESSAGE`,
  `persistAuthErrorRow` (`emitChatCard` + `finalizeInProgress`).
- `ws-handlers/agent-listeners.ts` — `auth_required` handler split into the
  quiet recovery path vs. `surfaceReauth`; persisted stale-resume notice.
- `ws-handlers/agent-execution.ts`, `runner-registry-factory.ts`,
  `bootstrap-managers.ts`, `session-runner.ts` — `repushSessionAgentToken` dep
  plumbing and the `ensureAgentTokenFresh` `opts.force` signature.
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
  once). Plus the 2026-08-02 regressions: the heal is requested with
  `force: true`; the source token is repushed **before** the healed retry
  spawns and **not** repushed when the heal failed; the surfaced sign-in notice
  is readable from `GET /history` after the runner is gone.
- `session-agent-env.test.ts` — `repushSessionAgentToken`, including the state
  no test covered before and the guard mishandles: **a session token whose
  `expiresAt` is LATER than the source but is dead** — the source must win.
  Also the account-routed root (docs/150) and the non-container no-op.
- `agents/claude/oauth-refresher.test.ts` — forced mode: a healthy token is
  probed via tier 2 instead of short-circuiting; a rotating probe repushes to
  pinned sessions; a revoked grant reports **not** healed; a live-token probe
  does not push the account into refresh backoff. And the guard that the
  proactive sweep is unchanged: unforced still short-circuits.
- `ws-handlers/agent-listeners.test.ts` — the re-auth notice is persisted and
  finalized (both the surfaced and failed-heal paths), nothing extra is
  recorded on the quiet heal path, and the stale-resume error is persisted
  rather than only emitted.
