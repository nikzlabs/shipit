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

## Problem A — the 401 is masked, undetected, and survives re-auth

### Root cause

Three separate gaps in the Claude auth path:

1. **Existence-only auth check.** `AuthManager.checkCredentials()`
   ([auth.ts](../../src/server/orchestrator/auth.ts) `checkCredentials`) reports
   authenticated whenever a credentials file *exists* on disk — it never
   inspects `expiresAt`, even though the module already has an `extractExpiresAt`
   helper. A dead OAuth/refresh token therefore still reads as "authenticated"
   in the UI.

2. **The runtime 401 is never classified as an auth failure.** The auth-error
   keyword detection in `ClaudeProcess` and `StreamingClaudeProcess`
   ([claude.ts](../../src/server/session/claude.ts)) matches phrases like
   `not authenticated`, `unauthorized`, `oauth`, `sign in` — but **not**
   `invalid authentication credentials` / `401`. Worse, the 401 arrives as a
   `result` event with `subtype: "error"` (structured JSON), not as a non-JSON
   stderr line, so it bypasses the keyword scan entirely. The turn dies as a
   generic error instead of emitting `auth_required`.

3. **Provisioning is write-once, so re-auth never reaches a pinned session.**
   `provisionAgentCredentials`
   ([session-credentials.ts](../../src/server/orchestrator/session-credentials.ts))
   copies the pinned agent's `.claude` subtree into the per-session credentials
   dir exactly once, gated on `!session.agentPinned`
   ([agent-execution.ts](../../src/server/orchestrator/ws-handlers/agent-execution.ts)).
   Once a session has taken a turn it is pinned, so signing out and back in
   refreshes the orchestrator's `/credentials/.claude` but the container keeps
   its stale copy. The user re-authenticates and still gets 401.

In container mode each session's container holds its own copy of
`.claude/.credentials.json` and the CLI refreshes that copy in place using the
refresh token. The 401 occurs when the refresh token itself is dead (revoked /
expired), which requires a fresh login — but gaps (1)–(3) hide that fact and
prevent the fresh login from taking effect.

### Fix

- **A1 — Classify the runtime 401.** Add `invalid authentication credentials`
  and `401` to the auth-error matching, and also inspect the text of
  `result` events whose `subtype` is `error`. A runtime 401 then emits
  `auth_required` (the same signal a startup auth prompt uses), which the
  orchestrator already wires to the OAuth flow.

- **A2 — DROPPED.** Originally "validate token expiry in `checkCredentials()`".
  Abandoned after review: the token's `expiresAt` is ≈1 year out, so an expiry
  check never trips and would be dead code. See "A is not yet root-caused"
  below — the failure is not expiry. Kept here only to record why it was cut.

- **A3 — Re-provision on re-auth (the both-modes fix).** On `auth_complete`
  for Claude ([api-routes-bootstrap.ts](../../src/server/orchestrator/api-routes-bootstrap.ts)),
  re-copy the fresh `.claude` subtree into the per-session credentials dir of
  every pinned **Claude** session. The dir is already mounted as a subpath, so a
  running container sees the new files immediately — no restart or remount. In
  local mode this is a no-op (the in-process CLI reads the orchestrator's
  credentials directly), so the same code path is correct in both modes. New
  helper alongside `provisionAgentCredentials`, e.g.
  `reprovisionAgentCredentialsForSessions(credentialsRoot, sessionIds, "claude")`.

### Key files
- `src/server/session/claude.ts` — auth-error classification (A1)
- `src/server/orchestrator/auth.ts` — `checkCredentials` expiry validation (A2)
- `src/server/orchestrator/session-credentials.ts` — re-provision helper (A3)
- `src/server/orchestrator/api-routes-bootstrap.ts` — call re-provision on `auth_complete` (A3)

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
- **C3** — Keep the server-side reconciliation as a defensive guard, but it
  stops firing once the client always sends a coherent pair.

### Key files
- `src/client/utils/local-storage.ts` — model as source of truth; derive agent (C1)
- `src/client/hooks/useSessionWebSocket.ts` — derive agent query param from saved model (C1)
- `src/client/hooks/useConnectionSync.ts` — stop mirror feeding new-session agent (C2)
- `src/client/stores/ui-store.ts` — initial `activeAgentId` derived from model (C1)
- `src/client/App.tsx` — `handleModelChange` / `handleAgentChange` reconciliation (C1)

---

## Implementation order

Revised after review:

1. **C** (model source-of-truth) — **first**, because it unblocks A's diagnosis.
   While a new session silently routes to Codex/gpt-5.5, you cannot create a
   clean *Claude* session to test the 401, so the discriminating experiment for
   A is impossible until C lands.
2. **B** (kill+restart + auth teardown) — makes the failure recoverable
   regardless of A's root cause; independent of the rest.
3. **A** — **deferred until C is in and the experiment is run** (see below).

Each workstream is a separate commit on the feature branch.

### A is not yet root-caused — diagnose before building

The original A2 ("validate token expiry") assumed a short-lived access token.
It isn't: the credential carries a long (≈1 year) `expiresAt`, so a plain
expiry check would never trip and **A2 is dropped**. ShipIt stores exactly one
token and never refreshes it itself — the in-container CLI refreshes via
`refreshToken` (see `auth.ts` `getOAuthToken` docstring).

Because the failure is **existing-session-only** with a long-lived token, the
leading hypothesis is a **stale/rotated copy**: the session's container holds
the token captured at provisioning time (write-once), and a later re-auth or
rotation invalidated it while a fresh session would copy the current, valid
token. That points at **A3 (re-provision on re-auth / propagate fresh creds)**
as the real fix.

Discriminating experiment (run once C lands):

- Create a fresh **Claude** session, send one turn.
  - **Works** → orchestrator token is valid; existing session 401s on a stale
    copy → **A3 is the fix**, A1 still wanted for recoverability.
  - **Also 401s** → the orchestrator token itself is dead → one-time re-auth
    required; **A1 (detect 401 → recover)** is the fix that matters, A3 still
    needed so the re-auth propagates into already-pinned sessions.

Optional hard confirmation on the box (no secret leakage):

```bash
for f in /credentials/.claude/.credentials.json \
         /credentials/sessions/<FAILING_SESSION_ID>/.claude/.credentials.json; do
  echo "== $f =="
  jq '{expiresAt: .claudeAiOauth.expiresAt,
       hasRefresh: (.claudeAiOauth.refreshToken|type=="string"),
       tokenTail: (.claudeAiOauth.accessToken[-6:])}' "$f"
done
```

Differing `tokenTail`/`expiresAt` confirms the stale-copy theory.

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
