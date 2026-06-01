---
status: done
description: Fix the fast-install path deadlocking a session's first turn by resolving the install gate from the HTTP response instead of a racy SSE event.
---

# Fast-install gate race (first turn never starts)

## Symptom

On a fresh headless session whose repo hits the docs/148 fast-install cache,
the worker comes up, runs install (`[install] fast-path hit … took=3043ms`),
and then **nothing** — no `[streaming-claude] spawning`, no agent process, the
user's first message is never delivered. Reproduced on two separate headless
sessions; both took the fast-install path. Slow/real-install sessions are
unaffected.

## Root cause

The orchestrator gates the agent CLI start on any in-flight `agent.install`
(`_waitForInstallBeforeAgent` in `container-session-runner.ts`) to avoid the
install + CLI competing for the container's memory cgroup (docs/124 OOM
follow-up). That gate awaits `_installComplete`, a promise that was **only ever
resolved by the SSE-delivered `install_done` event** (`handleSSEEvent`'s
`install_done` case → `signalInstallComplete()`).

`signalInstallComplete()` is a no-op if `_resolveInstallComplete` is null at the
moment the event is processed. On the **fast path** the worker broadcasts
`install_done` within a few milliseconds — fast enough to be delivered/consumed
relative to a window where the gate's resolver is not armed (or the SSE
handshake is mid-flight). The only missed-event recovery
(`resyncInstallStateAfterReconnect`) ran **only on SSE reconnect**
(`onSseOpen` gated it on `isReconnect`), so on the very first connect there was
no fallback and the gate hung forever. The real-install (slow) path is wide
enough that the resolver is always armed first, which is why it never
reproduced.

## Fix

Make fast-path completion **deterministic** — independent of the SSE event:

1. **Primary (worker → HTTP response).** The worker's `POST /install` handler
   now attempts the fast-install materialize **synchronously inside the
   request**. On a cache **HIT** it finishes the install (writes the marker,
   latches state, broadcasts `install_done` for any viewers) and returns
   `{ completed: true, ok }`. The orchestrator's `runInstall` settles the gate
   directly from that response (`signalInstallComplete`), exactly like the
   existing `{ skipped: true }` marker branch — so a hit never depends on the
   racy SSE event. A **MISS** (or non-cacheable command set) still returns
   `{ started: true }` and streams the real install via SSE as before.

2. **Backstop (first-connect resync).** `onSseOpen` now runs
   `resyncInstallStateAfterReconnect()` whenever an install is in flight — on
   the **first** connect, not just reconnects. If the streamed real-install
   path's `install_done` is ever lost, the first-connect probe of
   `/install/status` recovers it. Idempotent against the real event and the
   HTTP-response resolution (`signalInstallComplete` fires once).

3. **Bounded install POST timeout.** A cache hit holds the `POST /install`
   response open while `node_modules` materializes (seconds for a large tree),
   so `workerInstall` now takes a timeout and `runInstall` /
   warm-pool `runPreInstall` pass a generous `180_000` ms bound — finite, so a
   genuinely wedged worker resolves the gate (as a failure) via the catch path
   rather than blocking the first turn forever. The timeout is a backstop, not
   the fix.

## Key files

- `src/server/session/session-worker.ts` — `POST /install` handler now resolves
  a fast-path HIT synchronously and returns `{ completed }`;
  `runInstallCommands` split into `runRealInstallCommands` (background, streamed)
  + `finishInstallOk` (shared latch/broadcast).
- `src/server/orchestrator/container-session-runner.ts` — `runInstall` handles
  the `{ completed }` response; `onSseOpen` runs the install resync on first
  connect; `INSTALL_POST_TIMEOUT_MS`.
- `src/server/orchestrator/worker-http.ts` — `workerInstall` accepts a timeout.
- `src/server/orchestrator/warm-pool-manager.ts` — `runPreInstall` handles
  `{ completed }` and passes the generous timeout.
- `src/server/orchestrator/integration_tests/fast-install-gate.test.ts` —
  regression tests: real worker reports `{ completed }` on a seeded nm-store
  hit; gate resolves from the HTTP response with the SSE `install_done` never
  delivered; first-connect `/install/status` resync recovers a lost event.

## Verification

`npx vitest run src/server/orchestrator/integration_tests/fast-install-gate.test.ts`.
Reverting either the orchestrator `{ completed }` branch or the first-connect
resync makes the corresponding gate-resolution test hang (5s timeout),
confirming the tests bite.

## Follow-up: warm-pool turn hangs PAST the gate (un-timed env-prep await)

After the gate fix above, fresh sessions were fine but **warm-standby** quick
sessions still stalled on their first turn: the install gate resolved
(`{ completed:true }`, two `[install] fast-path hit` lines), yet the worker
still never received `/agent/start` — no `[claude] spawning`, no error.

### Root cause

The hang moved one layer down — into the dispatched-turn **pre-spawn env-prep**,
not the install gate. `executeAgentTurn` (`turn-executor.ts`) awaits
`deps.prepareAgentEnv(...)` → `prepareSessionAgentEnvironment`
(`session-agent-env.ts`) **before** the fire-and-forget `agent.run(...)`. Step 3
of that function, `refreshExpiredMcpOAuthTokens` → `refreshOAuthTokens`, did
`await fetch(provider.tokenEndpoint, …)` with **no timeout**. A slow/hung MCP
OAuth token endpoint (Linear/Notion) therefore stalled the turn indefinitely,
before the agent could spawn. The module's own docstring says "env prep must
not block a turn" — an un-timed awaited network call violated that. The WS /
interactive path didn't reproduce because ops sessions have no MCP OAuth tokens
to refresh. (Step 4's `tryPushAgentSecrets` was already 10s-bounded by the
worker HTTP client, but its `await _workerReady` could still hang, so it's
bounded here too.)

### Fix (fail-open timeouts on every pre-spawn network/worker await)

- `session-agent-env.ts` — new `withFailOpenTimeout()` wraps step 3 (MCP-OAuth
  refresh, `MCP_OAUTH_REFRESH_TIMEOUT_MS = 8s`) and step 4 (worker secrets push,
  `PUSH_AGENT_SECRETS_TIMEOUT_MS = 12s`). On timeout it logs and **continues to
  the spawn** — a stale MCP token at worst fails the first MCP call (the worker
  surfaces `mcp_server_status`); a skipped secrets push is retried by the next
  compose reconcile. Both strictly better than a dead turn.
- `services/mcp-oauth.ts` — every outbound OAuth fetch (token exchange, refresh,
  dynamic client registration) now carries `AbortSignal.timeout(7s)`
  (`OAUTH_FETCH_TIMEOUT_MS`) so the underlying socket is actually aborted, not
  just abandoned by the caller's fail-open.
- `turn-executor.ts` — timing logs around `prepareAgentEnv` and `buildRunParams`
  (`[turn] env-prep … took Nms`, `[turn] build-run-params … took Nms; spawning
  agent`) so any future pre-spawn stall is immediately localizable.

`_systemTurnDeps` being unset was ruled out: `onRunnerCreated` (which calls
`setSystemTurnDeps`) fires synchronously inside `SessionRunnerRegistry.getOrCreate`,
so a freshly-created warm-reconnect runner always has deps before `dispatch()`.

### Follow-up key files

- `src/server/orchestrator/session-agent-env.ts` — `withFailOpenTimeout`,
  exported `MCP_OAUTH_REFRESH_TIMEOUT_MS` / `PUSH_AGENT_SECRETS_TIMEOUT_MS`.
- `src/server/orchestrator/services/mcp-oauth.ts` — `OAUTH_FETCH_TIMEOUT_MS`,
  `oauthFetchSignal()` on all three OAuth fetches.
- `src/server/orchestrator/turn-executor.ts` — pre-spawn timing logs.
- `src/server/orchestrator/session-agent-env.test.ts` — fails-open when the
  worker secrets push hangs forever (fake timers).
- `src/server/orchestrator/session-runner.test.ts` — dispatch still spawns the
  agent (`agent.run` fires) when env prep's network step hangs.
