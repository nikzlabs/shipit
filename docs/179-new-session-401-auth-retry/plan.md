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
  legitimate final answer could contain. Two structural exclusions run before
  any text match, because a failed result is not automatically an *API* failure
  and only an API failure can be an auth failure: `error_max_turns` and
  `error_during_execution` (the turn cap and an interrupt, whose `result`
  carries the conversation's trailing text), and a `terminal_reason` that is
  present and not `api_error`. Without them, a session *implementing* OAuth
  that hit the turn cap would be read as unauthenticated — the real error
  swallowed, the turn silently "healed" and re-run. Absent `terminal_reason` is
  not disqualifying: older CLIs omit it, and a missed detection is the failure
  this path exists to prevent.
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

**One failure, one signal.** Swallowing both events is right; raising
`auth_required` twice is not. The signal's consumers are emphatically not
idempotent — the quiet recovery heals the token and **re-dispatches the whole
turn** — so the two-event payload made one auth failure re-run the user's turn
twice, side effects included. That was a regression introduced *by* §3: the old
detector fired on neither event, so there was nothing to double.

De-duplication lives at the **emitter**: both process classes latch
`auth_required` to one raise per turn. The two-event shape is a CLI protocol
detail, and a consumer taking a semantic "this turn failed auth" signal should
not have to know the wire format produced it twice — nor should the fix have to
be repeated at each consumer with side effects (the re-dispatch; the visible
path's error message, refresher nudge and `session_agent_finished`) and
re-repeated at the next one added. The latch is per-**turn**, not per-process:
`StreamingClaudeProcess` is resident across turns, so it re-arms in
`sendUserMessage`, or a session that failed auth once would never raise the
signal again. The listener keeps its own turn latch as well
(`agent-auth-handler.ts`), because the emitter's gate cannot cover a duplicate
from a *different* source — the non-JSON branch of each drain loop raises from
raw stderr text too. `willRecoverAuth` is deliberately **not** the gate: its
return value means "will this turn auto-recover", and returning `false` for
"already recovering" would route the caller into `surfaceReauth()`, popping a
sign-in card in the middle of a recovery about to succeed quietly.

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

### 4. The credential-topology half of the same incident

Detection (§3) explains why the failure *looked* like the agent telling the
user to run `/login`. It does not explain why the CLI was unauthenticated at
all, on a session whose account was healthy. That half is the docs/153 leak
repair running underneath a live CLI process.

The repair is destructive by construction: unlink `<sessionDir>/.claude`,
re-copy the subtree from the account root, merge the orphan tree back on top,
`rmSync` the orphan root. Between the unlink and the copy there is a real
window in which the session dir has no `.claude/.credentials.json`.

**That window is observable to a live process — verified, not assumed.** The
mechanism turns entirely on whether the CLI re-reads its credentials or caches
them at startup, and the repo asserted *both*: this doc said "per API call"
while `services/provider-account-switch.ts` said "**once**, at process start"
and built its kill-first ordering on that. Neither was tested. Settled by
driving one resident `--input-format stream-json` process (CLI 2.1.219) through
three turns against an isolated `$HOME`:

| turn | `.claude/.credentials.json` | result |
|---|---|---|
| 1 | present | `subtype: success`, `is_error: false` |
| 2 | **deleted underneath the live process** | `is_error: true`, `terminal_reason: api_error`, `Not logged in · Please run /login` |
| 3 | restored | `subtype: success`, `is_error: false` |

`ok → fail → ok` on one process with no restart. The CLI re-reads the file per
request, and a missing file produces **the exact string this incident reported**
— which also explains the user-visible shape of the bug, that re-sending the
message "just works". `provider-account-switch.ts` has been corrected; its
kill-first ordering is still right, but because a resident process is exposed
to every intermediate state of a non-atomic rewrite, not because it is insulated
from them. (Claude only — Codex was not tested, and neither doc now claims
anything about it.)

The incident's ordering then matches exactly: `/compact` left a resident
streaming process alive, the next turn's env-prep repaired the links again, and
the turn came back `Not logged in · Please run /login`.

**Fix — `reusingResidentAgent` (issue criterion 3).** Credential *topology*
may only change at a spawn boundary. `turn-executor` is the one place that
knows which kind of turn this is, so it passes
`reusingResidentAgent: input.reuseExistingAgent === true` into `prepareAgentEnv`,
and `prepareSessionAgentEnvironment` forwards it to the sync-in as
`repairLeakedSubtrees: false`. Nothing a reuse turn consumes is lost by
deferring: the on-disk convergence is for the next `--resume`, and the
recovered `agentSessionId` is read by `buildRunParams`, which the reuse branch
never calls. The **per-turn token copy still runs**, which is what keeps a
long-lived process authenticated across a rotation (docs/142 A). Both
transports inherit the one decision — the WS wrapper
(`ws-handlers/agent-execution.ts`) and the dispatched/system wrapper
(`runner-registry-factory.ts`) each just forward the flag.

**The other two windows.** `reusingResidentAgent` closes the per-turn sync-in
and nothing else; a live process can be exposed to a rewrite from two more
directions, so all three are closed together.

- **A system turn** (merge wake, rebase, CI fix) is never steered, so it
  answers "not reusing" *truthfully* and the repair is free to run — while the
  resident process it declined to adopt is still running in the worker.
  `dispatched-turn` now **retires** it before env prep, mirroring the docs/150
  account-failover block a few lines above. That is criterion 3's own wording
  ("retire the old process first rather than swapping the subtree beneath it"),
  and "topology changes only at a spawn boundary" is only true if the boundary
  is real. It is also tidier than the status quo, where `createAgent` displaced
  the slot, orphaned the process, and let the worker's `/agent/start` 409 into
  a kill+restart. Reachable only with no turn in flight (`dispatchOnRunner`
  enqueues while `running`).
- **The wall-clock re-push** — the scheduled OAuth refresher
  (`bootstrap-managers.ts`) and the post-sign-in re-push (`app-lifecycle.ts`) —
  ran `repushAgentTokenFromRoot`, which reached the same destructive repair
  unconditionally. It now takes the same `repairLeakedSubtrees` opt-out, and
  both callers derive it from **`sessionHasLiveAgent(registry, sessionId)`**.
  The predicate is deliberately neither `runner.running` (a streaming process
  outlives its turn, which is what `/compact` leaves behind) nor
  `reusingResidentAgent` (these callers fire on a clock, with no turn in view).
  Actual process liveness is the only thing that answers "could a CLI read
  these files while I rewrite them?". It over-approximates at a spawn boundary
  — the incoming agent is already in the slot before it runs — which is why the
  turn path keeps its own predicate and does not use this one.

**The guarantee the suppression leans on — the token copy must still land.**
"Topology frozen, token still refreshed" is only true if the copy reaches the
file the CLI reads. The freshness guard compared the source against
`<sessionDir>/<rel>`; on the *actual* leaked shape that path is an absolute
symlink back into the shared account root, so on the orchestrator it resolves
to the source itself, `srcExp <= dstExp`, and the copy was skipped — silently,
while inside the subpath-mounted container the same symlink resolves to the
session's own orphan and the resident CLI keeps reading a dead token. Both copy
loops now resolve the destination to what the container would read
(the orphan under `<sessionDir>/provider-accounts/<provider>/<account>/`) before
comparing or writing. The earlier "reuse turn still refreshes the token" test
could not have caught this: it used a real directory plus a separate orphan,
the one shape where the naive destination is already correct.

*Not fixed here, deliberately:* the **write-back** direction still uses the
naive path — `syncAgentTokenBack`, `agentTokenFilePaths` /
`sessionTokenIsAheadOfSource` and the mid-turn publisher built on them
(docs/153). On the leaked shape those resolve to the source itself, so a
rotation the container performs is compared against, and copied over, that same
file: a no-op rather than a corruption. The consequence is bounded — a
pre-req-19 session's *own* refresh is not published to its siblings until the
repair runs — and the fix belongs with the sync-back owner, not in a change
whose subject is not writing under a live process.

**Convergence (criterion 2) — NOT closed; the writer is still unidentified.**
An earlier revision of this doc named `migrateDefaultAccounts` as the writer,
claiming it re-created the root-level alias symlinks on **every boot**. That is
false. `migrateProviderDefault` opens with `if (this.list(provider).length > 0)
return;` and the `symlinkSync` sat *below* that guard (confirmed present in
`95a44dc6^` as well), so it created the aliases exactly once, at first
migration, and returned immediately on every boot thereafter. It cannot explain
repair-then-recreation between ordinary turns on an already-migrated install.

What *is* established is narrower, and only about **newly provisioned**
sessions: docs/150 req 19 stopped creating the root aliases and retires any an
earlier boot left behind, and `copyCredentialPath` dereferences rather than
preserving symlinks, so a session provisioned today cannot acquire the leaked
shape at all. An audit of the current tree found no remaining production path
that writes a symlink at `<sessionDir>/.claude`. For sessions provisioned
*before* req 19, the repair converges after one pass —
`session-agent-env.test.ts` ("repairs a legacy default-account link once, then
converges to a no-op") asserts that directly.

None of that identifies what recreated the links between turns on the
production install in the incident. Repeated repair there remains unexplained,
so criterion 2 stays open (issue #1874). The §4 fix does not depend on the
answer: it makes repair-under-a-resident-process impossible whether or not the
repair ever converges.

**Turn-path audit (criterion 4).** Every path that spawns an agent converges on
the same enforcing preparation. Five services prepare the environment early —
`wake-session.ts`, `services/headless-sessions.ts`,
`services/child-sessions.ts` (create + follow-up), `services/github-ci-fix.ts` —
and each then calls `runner.dispatch(...)`, which reaches `executeAgentTurn` and
its `deps.prepareAgentEnv`. That callback is installed by
`createRunnerRegistry` for *every* runner (container and in-process alike) with
`enforceAccountRouting: true`. So the early call is a deliberately
non-enforcing warm-up (a session being created must not be blocked before it
has a route), and the enforcing call is the one immediately before spawn. The
only case with no env prep at all is a build with neither `credentialsDir` nor
`credentialStore` — minimal test setups — which is the pre-existing documented
degradation, not a turn-path divergence.

**Diagnostics (criterion 7).** `prepareSessionAgentEnvironment` logs one
`[env-prep]` line per preparation with the resolved route, whether this call
pinned it, whether the repair ran or was skipped for a resident agent, and any
failover. Diagnosing this incident from production logs meant inferring all
three from side effects — the repair announced itself only when it fired, so
"repaired again" and "never converged" were indistinguishable from "ran and
found nothing". Route ids are opaque account handles; no token material is
logged.

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
  `resultEventIndicatesAuthFailure` (incl. the `error_max_turns` /
  `terminal_reason` exclusions), `assistantEventIndicatesAuthFailure`,
  `consumeAuthFailureEvent` (the drain-loop gate that raises `auth_required`
  and swallows the CLI's error copy), and `raiseAuthRequiredOnce` — the
  per-turn latch on both process classes, re-armed in `run()` /
  `sendUserMessage`.
- `ws-handlers/agent-auth-handler.ts` — the listener's own turn latch, for a
  duplicate arriving from the raw-stderr path rather than the JSON drain.
- `session/agents/claude/adapter.ts` — `is_error`-based `agent_result` status /
  error mapping.
- `ws-handlers/agent-event-normalizer.ts`, `ws-handlers/agent-listeners.ts` —
  `Array.isArray` guards on `agent_tool_result.content`.
- `shared/types/claude-types.ts` — `ClaudeResultEvent.is_error` /
  `terminal_reason`, `ClaudeAssistantEvent.is_api_error_message` / `error`.
- `turn-executor.ts` — decides `reusingResidentAgent` from
  `input.reuseExistingAgent` at the `prepareAgentEnv` call.
- `session-agent-env.ts` — `reusingResidentAgent` → the sync-in's
  `repairLeakedSubtrees`, plus the `[env-prep]` decision log.
- `dispatched-turn.ts` — retires a resident process before env prep on a system
  turn (the boundary the reuse flag alone doesn't make real).
- `session-runner.ts` — `sessionHasLiveAgent`, the process-liveness predicate
  for the wall-clock callers (and why it is not `runner.running`).
- `bootstrap-managers.ts`, `app-lifecycle.ts` — the scheduled refresher and the
  post-sign-in re-push consult that predicate for `repairLeakedSubtrees`.
- `token-sync-manager.ts` — `repairLeakedSubtrees` on both the sync-in and the
  re-push; the container-visible destination resolution in both copy loops. The
  repair itself (`materializeLeakedSubtreeSymlinks`) is unchanged.
- `ws-handlers/agent-execution.ts`, `runner-registry-factory.ts`,
  `session-runner.ts` — the two `prepareAgentEnv` wrappers and the
  `SystemTurnDeps` signature that carries the flag.
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
  API error; a turn-cap or interrupted failure whose text mentions OAuth; a
  non-`api_error` `terminal_reason`), that an absent `terminal_reason` still
  detects, and `resultEventIsError`.
- `session/agents/claude/process.test.ts` — the drain loop forwards **neither**
  auth event and raises `auth_required` exactly **once** across the pair, on
  both process classes; the streaming latch re-arms on the next
  `sendUserMessage`; a normal assistant message + clean result still pass
  through.
- `integration_tests/auth-401-auto-retry.test.ts` → the real two-event payload —
  injects what the CLI actually emits (not a synthetic single `auth_required`)
  and asserts exactly one heal and one re-dispatch. Pre-fix this test sees two
  heals and three agents.
- `integration_tests/ask-user-question.test.ts` — a string-valued
  `tool_result.content` passes through intact while suppression is active, and
  the **turn survives**: the broadcast happens before the extraction that threw,
  so the assertions that matter are the ones after — the follow-up steer is
  honored in order and the turn reaches a terminal state.
- `ws-handlers/agent-event-normalizer.test.ts` — direct non-array `content`
  cases for `extractToolResults` and `stampToolDurations`.
- `session-agent-env.test.ts` → "credential topology under a resident agent" —
  a legacy default-account link repairs once then converges; the pinned
  non-default account's token is the one synced; a reuse turn leaves the
  subtree alone but still refreshes the token; and the suppression never
  leaves a resident agent credential-less when the source subtree is missing.
- `session-credentials.test.ts` → the **genuine leaked shape** (an absolute
  symlink into the shared root, not a real dir + orphan): with the repair
  suppressed, sync-in and re-push both still land the rotated token at the path
  the container reads, and neither touches the topology.
- `session-runner.test.ts` — the executor tells env prep which kind of turn
  it is: `reusingResidentAgent: true` when the message is steered into a
  resident streaming process, `false` on a fresh spawn; a **system turn**
  (merge wake) kills the resident process *before* env prep runs, asserted as
  an ordering; and `sessionHasLiveAgent` is true for an idle session holding a
  resident process (the case `runner.running` gets wrong).
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
