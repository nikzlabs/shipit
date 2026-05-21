---
status: planned
priority: high
description: Fix three coupled agent failures — a masked Claude 401, a stuck "Agent already running" state under live steering, and new sessions silently switching the user's model/agent.
---

# Agent auth recovery & model source-of-truth

## Context

A single user-reported incident surfaced three independent defects that compound
into an unrecoverable state. The reported chain (full container mode, live
steering on):

1. The agent fails with `API Error: 401 Invalid authentication credentials`,
   even though Settings shows Claude as authenticated.
2. Retrying the turn returns `Agent process error: Agent already running`.
3. Separately: for new sessions the model picker shows **Opus**, but on the
   first turn the session silently runs **gpt-5.5** (Codex).

Each has a distinct root cause. They are documented and fixed together because
the incident only becomes unrecoverable when all three interact: the wrong agent
runs (C), it cannot authenticate (A), and the failed turn cannot be retried (B).

The fixes must work in **both** runtime modes (full container and
local/dogfood). The reported failure was in container mode.

---

## Problem A — rotating refresh token vs. one-directional credential copy

### Root cause (CONFIRMED on prod, 2026-05-21)

Diagnostic from inside a failing session container (`/root/.claude` →
`/credentials/.claude` subpath mount):

```
{ "expiresAt": 1779304803371,  // ~May 21 2026 — a SHORT-LIVED access token, expired
  "expiredNow": true, "hasAccess": true, "hasRefresh": true, "tokenTail": "Ds9AAA" }
```

Running `claude -p` in that container 401s and leaves the credential file
**byte-for-byte unchanged** — the CLI never obtained a working token.

The structural cause (the earlier "≈1 year expiry" premise was wrong — the
access token is short-lived and meant to be refreshed):

1. **One-directional copy, never written back.** `provisionAgentCredentials`
   ([session-credentials.ts](../../src/server/orchestrator/session-credentials.ts)
   `copyCredentialPath`) does `fs.cpSync(/credentials/.claude →
   /credentials/sessions/<id>/.claude)`. The session container mounts only its
   own subdir, so a refresh inside the session writes to
   `sessions/<id>/.claude/.credentials.json` and **never propagates back** to
   the orchestrator's source `/credentials/.claude`.

2. **Refresh tokens rotate (single-use).** Each successful refresh returns a new
   refresh token and invalidates the old one server-side. With N independent
   copies of the same refresh token, the first session to refresh consumes it;
   the orchestrator source and every other copy are left holding a dead token.

3. **The orchestrator never refreshes its own source.** It runs the OAuth login
   (writes `/credentials/.claude`) but never runs a turn, so it never refreshes.
   The source access token simply expires, and the source refresh token is
   whatever was last written at login (and is dead once any session rotated it).

Failure chain: source holds `(expiredAccess, R1)` → a session copies it and
refreshes `R1 → (A2, R2)` into *its own* copy only → R1 is now dead → every new
session copies the stale source `(expiredAccess, R1)` → refresh rejected → 401
with the file unchanged. **Re-auth only unblocks until the next rotation/expiry.**

### Secondary masking gaps (still real, still worth fixing)

- **Existence-only auth check.** `AuthManager.checkCredentials()`
  ([auth.ts](../../src/server/orchestrator/auth.ts)) reports authenticated
  whenever a credentials file *exists* — so a dead token still shows
  "authenticated" in the UI.
- **The runtime 401 is never classified as an auth failure.** The keyword
  detection in `ClaudeProcess`/`StreamingClaudeProcess`
  ([claude.ts](../../src/server/session/claude.ts)) matches `unauthorized`,
  `oauth`, etc. but **not** `invalid authentication credentials` / `401`, and
  the 401 arrives as a `result` event with `subtype: "error"` (structured JSON),
  bypassing the scan. The turn dies as a generic error instead of emitting
  `auth_required`.

### Fix — orchestrator-mediated copy-back (chosen) + 401 classification

Chosen after weighing a shared RW mount (clean but blocked by warm-pool mount
timing + per-agent isolation) and a central orchestrator-only refresher (rated
fragile). The copy-back keeps the existing per-session-copy model (so warm pool
and docs/138 isolation are untouched) and just **closes the loop** so a rotated
token isn't stranded in one session.

- **A-copyback (primary) — sync the OAuth token in per-turn and write it back
  when it advances.** Implemented in
  [session-credentials.ts](../../src/server/orchestrator/session-credentials.ts)
  (`syncAgentTokenIn` / `syncAgentTokenBack`) and wired into
  [agent-execution.ts](../../src/server/orchestrator/ws-handlers/agent-execution.ts):
    - **Before each turn:** copy just the token file
      (`.claude/.credentials.json`) from the orchestrator source into the
      session's per-session dir, so the CLI starts from the freshest token (not
      a stale write-once copy).
    - **After each turn:** if the session's token now carries a **strictly later
      expiry** than the source, copy it back (atomic temp+rename). The
      **expiry guard** is the safety mechanism: a session that *failed* to
      refresh (same/older expiry) can never clobber a fresher source token, so
      the rare concurrent-refresh case is a self-healing one-off rather than a
      regression.
    - Covers **both agents.** Each declares its token file(s) and a "freshness"
      reader so the expiry guards compare like with like (Claude:
      `claudeAiOauth.expiresAt`; Codex: the access-token JWT `exp` claim /
      `last_refresh`, since `auth.json` carries no plain expiry). Claude was the
      confirmed failure; Codex has the same latent rotation hazard and is now
      synced too. The per-turn wiring is agent-generic. No-op outside container
      mode (local/dogfood reads the orchestrator creds directly).

- **A1 (done) — Classify the runtime 401.** `textIndicatesAuthFailure` /
  `resultEventIndicatesAuthFailure` in
  [claude.ts](../../src/server/session/claude.ts) add `invalid authentication
  credentials` / `authentication_error` / `invalid (x-)api key` and inspect
  error `result` events (the 401 arrives as `{type:"result", subtype:"error"}`,
  not a stderr line). A runtime 401 now emits `auth_required`, which flips the
  auth card and (via B1) tears the stuck turn down — visible and recoverable
  instead of a silent 401 + "Agent already running".

- **A2 — DROPPED.** Originally "validate token expiry in `checkCredentials()`".
  An expired-but-refreshable token must NOT report unauthenticated; honest auth
  state instead falls out of A-copyback (the source stays fresh) + A1 (a real,
  unrecoverable 401 flips the card).

- **A3 (done) — Re-push on re-auth.** On `auth_complete` (Claude *and* Codex),
  `repushAgentToken` ([session-credentials.ts](../../src/server/orchestrator/session-credentials.ts))
  force-copies the fresh source token into every session pinned to that agent
  ([app-lifecycle.ts](../../src/server/orchestrator/app-lifecycle.ts)
  `repushTokenToPinnedSessions`), so an idle pinned session recovers immediately
  instead of waiting for its next turn's sync-in. It is **unconditional**
  (ignores the expiry guard on purpose — a manual re-login exists to repair the
  dead-but-later-expiry token the guard would otherwise skip) but cross-agent
  safe: it only overwrites a token file the session already holds, so it never
  seeds `.claude` into a Codex session (docs/138).

> **One-time operational step:** the prod refresh token was already dead
> (consumed before write-back existed), so a single sign out + sign in is needed
> to seed a fresh source token. After that, copy-back keeps it alive.

### Key files
- `src/server/orchestrator/session-credentials.ts` — `syncAgentTokenIn` / `syncAgentTokenBack` + expiry guard (A-copyback)
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — per-turn sync-in (pre-start) + sync-back (post-turn) wiring
- `src/server/session/claude.ts` — `textIndicatesAuthFailure` / `resultEventIndicatesAuthFailure` (A1)
- `src/server/orchestrator/app-lifecycle.ts` — `repushTokenToPinnedSessions` on `auth_complete` (A3)

---

## Problem B — stuck "Agent already running" under live steering

### Root cause

With live steering ("Inject messages mid-turn") enabled, Claude runs as a
persistent `StreamingClaudeProcess` that, by design, treats a `result` event as
turn-end **without exiting** ([claude.ts](../../src/server/session/claude.ts)).
The worker only clears `this.agent` on the process's `done`/`error` events
([session-worker.ts](../../src/server/session/session-worker.ts) `wireAgentEvents`).
A turn that fails (e.g. the 401) emits `result` but the process stays alive, so:

- The worker never clears `this.agent`.
- The orchestrator *does* release its own reference on `agent_result`
  ([agent-execution.ts](../../src/server/orchestrator/ws-handlers/agent-execution.ts)).
- The next turn calls `currentAgent.run()` → `POST /agent/start`, which the
  worker rejects with `409 Agent already running`
  ([session-worker.ts](../../src/server/session/session-worker.ts)).
- The lone 150ms retry in `_startAgentViaProxy`
  ([container-session-runner.ts](../../src/server/orchestrator/container-session-runner.ts))
  cannot help because the process never exits — it 409s again and surfaces as
  "Agent process error: Agent already running".

### Fix

- **B1 — Proactive teardown on auth failure.** When `auth_required` fires for a
  running turn, kill the worker agent so `this.agent` clears (the turn is dead
  regardless) and the auth card flips. This handles the common path cleanly.

- **B2 — Defensive kill + restart on persistent 409.** In `_startAgentViaProxy`,
  if the second `/agent/start` still returns 409, `POST /agent/kill` then start
  fresh instead of re-throwing. This path only runs when the orchestrator
  believes no turn is active, so a 409 is always a worker/orchestrator desync →
  it is safe to clear the stale agent. This makes *any* stranded-agent cause
  self-heal, not just the auth case.

### Key files
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — auth_required teardown (B1)
- `src/server/orchestrator/container-session-runner.ts` — `_startAgentViaProxy` kill+restart (B2)

---

## Problem C — new sessions don't honor the user's model selection

### Root cause

The only model/agent control is the model dropdown
([ModelAgentSelector.tsx](../../src/client/components/ModelAgentSelector.tsx)) —
the standalone `AgentPicker` is not mounted anywhere. Picking a model implicitly
selects its agent. There is no user-facing "switch the agent" action.

Despite that, the agent is tracked as **independent state**:

- a separate `vibe-agent-id` localStorage key whose `getSavedAgentId()` fallback
  hardcodes `"claude"` ([local-storage.ts](../../src/client/utils/local-storage.ts)),
- plus an in-memory `activeAgentId` that gets mirrored from whatever session was
  last *viewed* ([useConnectionSync.ts](../../src/client/hooks/useConnectionSync.ts)).

The new-session WebSocket connect sends `agent` and `model` as independent query
params read straight from those two stores
([useSessionWebSocket.ts](../../src/client/hooks/useSessionWebSocket.ts)). When
they disagree, the server resolves the conflict by making the **agent**
authoritative and rewriting the model to the agent's first model
([index.ts](../../src/server/orchestrator/index.ts)) — e.g. `opus` → `gpt-5.5`.
The user sees Opus, gets Codex.

### Fix

Make the **model the single source of truth** and derive the agent from it
(each model belongs to exactly one agent; `agentList` already carries the
mapping). Divergence becomes structurally impossible.

- **C1** — Persist only the model. Derive the agent at every read site: the WS
  query param, the new-session display `activeAgentId`, and the store's initial
  value.
- **C2** — Remove the hardcoded-`claude` default and the session-mirror as
  *sources* for what a new session runs. New session → the user's last model
  decides both; existing session → its own persisted model/agent stay
  authoritative (already true server-side).
- **C3 (done)** — **Inverted** the server-side reconciliation
  ([index.ts](../../src/server/orchestrator/index.ts)) so it's no longer just a
  passive guard: for an **unpinned** session the model is authoritative and the
  agent is derived from it (`agentRegistry.list()` owner lookup), so even an
  incoherent client pair (stale `agent=codex` + `model=opus`) runs Claude. Once
  the session is pinned (creds provisioned on the first turn) it flips to
  agent-authoritative and conforms the model. Reconnects still prefer the
  persisted `session.model` over the query param. Integration-tested in
  `codex-agent.test.ts`.

### Key files
- `src/client/utils/local-storage.ts` — model as source of truth; derive agent (C1)
- `src/client/hooks/useSessionWebSocket.ts` — derive agent query param from saved model (C1)
- `src/client/hooks/useConnectionSync.ts` — stop mirror feeding new-session agent (C2)
- `src/client/stores/ui-store.ts` — initial `activeAgentId` derived from model (C1)
- `src/client/App.tsx` — `handleModelChange` / `handleAgentChange` reconciliation (C1)

---

## Problem D — a worker HTTP timeout crashed the whole orchestrator

### Root cause (CONFIRMED on prod, 2026-05-21)

The dead token (Problem A) made session-worker calls hang. One of them — a
`POST /terminal/start` ([worker-http.ts](../../src/server/orchestrator/worker-http.ts))
— hit the 10s `DEFAULT_WORKER_TIMEOUT_MS` and rejected with a
`WorkerTimeoutError`. That rejection took down the **entire orchestrator**
(`RestartCount=1`; Docker restarted it ~2s later), stranding every live session.

Container log around the crash:

```
15:33:28 [runner:a0ea…] pushAgentSecrets failed: Worker request timed out after 10000ms: /secrets
15:34:45 SSE error: SSE stream stale (no activity within idle timeout)
15:35:06 WorkerTimeoutError: Worker request timed out after 10000ms: /terminal/start  → unhandled rejection → exit
15:35:08 [server] listening … (restart; Rediscovered 5 container(s))
```

The structural cause is in the WS dispatcher
([index.ts](../../src/server/orchestrator/index.ts)). Each case did
`return handler(ctx, msg)` from an `async socket.on("message")` callback that
**nobody awaits**. So a handler rejection floated out as an unhandled rejection,
and Node's default (terminate the process) applied. The subtlety that makes this
easy to reintroduce: a `try/catch` wrapped around `return promise` does **not**
catch the rejection — the function returns before the promise settles, so the
`await` has to happen for the `catch` to see it.

This is the same spirit as the CLAUDE.md rule *"WebSocket lifecycle MUST NOT
affect server behavior"*, extended one layer down: **a single session worker's
HTTP timeout must never kill the orchestrator that owns every other session.**

### Fix

- **D1 — Await + catch in the WS dispatcher.** The switch is now a local
  `dispatchSessionMessage(msg)` that the listener `await`s inside a try/catch. A
  handler rejection (most often a `WorkerTimeoutError`) degrades to a
  per-session `{type:"error"}` message; the connection and process stay up. This
  covers every WS handler at once — that was the audit conclusion: the dispatcher
  was the single floating point for the `return handler(...)` callsites.

- **D2 — Process-level `unhandledRejection` backstop** in `autoStart`
  ([app-lifecycle.ts](../../src/server/orchestrator/app-lifecycle.ts), production
  entry point only). Logs loudly and keeps the process alive, so any *future*
  floating worker call (e.g. an intentional `void handler()` fire-and-forget)
  can't crash the orchestrator either. `uncaughtException` is deliberately NOT
  swallowed — a thrown non-promise error can leave state corrupt, so Node's
  default restart is the right behavior there.

### Key files
- `src/server/orchestrator/index.ts` — `dispatchSessionMessage` + await/try/catch in the message listener (D1)
- `src/server/orchestrator/app-lifecycle.ts` — `unhandledRejection` backstop in `autoStart` (D2)
- `src/server/orchestrator/integration_tests/ws-handler-error-isolation.test.ts` — executable contract (rejecting handler → client error, not a dead process)

---

## Implementation order

Revised after review:

1. **C** (model source-of-truth) — **DONE** (PR #576). Also unblocked A's
   diagnosis: a new session now genuinely runs Claude, surfacing the real 401.
2. **B** (kill+restart + auth teardown) — **DONE** (PR #576).
3. **A** — root-caused on prod (see Problem A). Build order:
   **A1** (classify the 401 → recoverable) → **A-refresh** (orchestrator-owned
   central refresh) → **A3** (re-push on re-auth). A1 is low-risk and standalone;
   A-refresh needs the implementation decision below.

### A diagnosis — RESOLVED (2026-05-21)

Confirmed on prod: short-lived access token, expired, refresh token present;
`claude -p` inside the session 401s and leaves the credential file unchanged.
Both new and existing Claude sessions fail. Root cause is the rotating refresh
token vs. one-directional write-once copy (orchestrator never refreshes its own
source; sessions never write rotated tokens back). See Problem A above.

Open decision for **A-refresh**: how the orchestrator performs the refresh —
(1) direct OAuth token-endpoint call (fragile), or (2) invoke the `claude` CLI
on a timer to refresh `/credentials/.claude` in place (preferred — the CLI owns
the protocol). Pick before implementing.

> Operational note: if the experiment shows the orchestrator token is dead, a
> one-time **sign out + sign in** is required. The A fixes then ensure the state
> is reported honestly, propagated into the container, and recoverable without a
> stuck agent.

## Testing

- **A:** `auth.test.ts` for the expiry/refresh-token logic; integration test
  that a `result` error carrying a 401 emits `auth_required`, flips the auth
  card, and tears the agent down so the next send succeeds; a re-provision test
  asserting fresh creds land in a pinned session's dir on `auth_complete`.
- **B:** ws integration test — a persistent 409 triggers kill + restart and the
  turn proceeds; `auth_required` mid-turn clears the worker agent.
- **C:** client tests — agent derived from saved model; WS query param carries
  the derived agent; selecting a model never yields a display/agent mismatch.

## Checklist

- [x] C — model source-of-truth (done first; unblocks A diagnosis)
- [x] B — teardown + kill/restart recovery
- [ ] A: run the fresh-Claude-session experiment to root-cause (now possible)
- [ ] A1 — classify runtime 401 / `invalid authentication credentials`
- [x] A2 — DROPPED (token is long-lived; expiry check would never trip)
- [ ] A3 — re-provision Claude creds to pinned sessions on `auth_complete`
- [x] B1 — teardown worker agent + clear runner state on `auth_required`
- [x] B2 — kill + restart on persistent 409 in `_startAgentViaProxy`
- [x] C1 — derive agent from saved model in WS query param (`agentIdForModel`);
      always persist the picked model's agent in `ModelAgentSelector` (removed
      the stale in-memory `activeAgentId` guard — the precise bug)
- [ ] C2/C3 — server reconciliation left as a defensive guard; client now sends
      a coherent (derived-agent, model) pair so it should no longer fire. Verify
      in the experiment.
- [x] Tests for B (kill+restart, `auth_required` teardown) and C (`agentIdForModel`)
- [ ] Tests for A (after root-cause)
- [ ] Update `src/server/shipit-docs/` if any agent-facing auth behavior changes
