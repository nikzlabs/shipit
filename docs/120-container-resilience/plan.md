---
status: done
---

# Container resilience — auto-recovery from silent disconnects

## Problem

Users report that the agent container and preview containers "often get
detached" and then *nothing works* — neither the agent, the preview, nor
the logs. Restarting the session is the only way out.

Feature 112 (container recovery) shipped the *manual* recovery surface:
the SessionHealthStrip exposes diagnostics and Kill-agent /
Restart-container buttons. But manual recovery only helps if the user
knows something is wrong. The bigger pain is *automatic* resilience
gaps that let the orchestrator drift out of sync with the actual
container state without ever surfacing the failure.

This feature catalogs those gaps, fixes the two with the highest
confidence-to-risk ratio (A + B below), and tracks the rest for
follow-up.

## Failure mode catalog

The "detached" symptom is a cluster of distinct bugs sharing one face.
Each gap can independently produce the user's reported state.

### Gap A — SSE silently dies, never reconnects *(this feature)*

`src/server/orchestrator/sse-client.ts` has no idle timeout. When the
TCP socket goes half-open — Docker network blip, NAT idle timeout,
worker process freeze without container exit — Node's `http.request`
sits forever waiting for bytes that never arrive. Reconnect only fires
on explicit `error` / `end` events, which require the kernel to notice
the dead peer (it often doesn't).

The worker sends a keepalive comment every 15s
(`session-worker.ts:585`), but the orchestrator never enforces a
matching deadline. So a silently-dead SSE stream looks "connected"
indefinitely, all agent / terminal / preview events stop arriving, and
the user sees a frozen UI.

Bonus bug: `connectSSE` only invokes `onEvent` for fully-formed `event:`
+ `data:` pairs. Server keepalive comments (`: keepalive`) are dropped
on the floor, so `_lastSseEventAt` doesn't advance during idle periods
even though the connection is healthy. The SessionHealthStrip's "events
stale" indicator becomes noisy and unreliable.

### Gap B — Docker event stream silently dies *(this feature)*

`src/server/orchestrator/container-health.ts:85-88` listens for Docker
`die` and `oom` events. On stream error the handler sets
`state.eventStream = null` with a comment "will be restarted on next
call" — but **nothing calls it**. After a Docker daemon restart, network
blip, or socket EAGAIN, `container_exited` events stop firing forever.
A real container OOM or crash then becomes invisible: the runner stays
in the registry with a stale worker URL, the SessionHealthStrip's
container state column shows "running," and every HTTP call to the
worker fails silently.

### Gap C — No proactive worker watchdog *(deferred — see 112C)*

A wedged-but-alive worker process (Fastify deadlock, GC stall, OOM that
didn't kill the container) is invisible until a user opens the Terminal
tab and notices the SessionHealthStrip. Feature 112C designed a
periodic `/health` probe with `container_unresponsive` banner; it's
explicitly deferred pending tuning data on false-positive rate during
slow agent turns. Track in `docs/112-container-recovery/checklist.md`.

### Gap D — Compose `pollStatus` swallows Docker errors

`src/server/orchestrator/service-manager.ts:830-833` warns and returns
when `docker compose ps` fails. Stale `status: "running"` then makes
the preview proxy route to a dead container; the logs endpoint returns
the empty buffer of the original (now-dead) log streamer. Polls every
5s, so the window is short — but a Docker daemon restart can leave
services frozen in stale states across the whole session.

Track separately; not part of this feature.

### Gap E — SSE reconnect retries forever, capped at 10s

`container-session-runner.ts:783-797` schedules reconnect attempts
indefinitely. There's no bound on retries and no notification path when
the worker is permanently gone. The UI keeps looking "alive" while
recovery is impossible.

Track separately; not part of this feature.

### Gap F — Compose log streamer doesn't restart when service comes back

When a compose service crashes and later recovers, the `docker compose
logs -f` process spawned at first start has already exited. `logBuffers`
gets no new entries; the logs endpoint returns stale content.

Track separately; not part of this feature.

## Design — A + B

### A. SSE idle timeout + activity tracking

**`sse-client.ts`** grows two related capabilities:

1. **`idleTimeoutMs` option** — when set, a timer arms on every byte
   received from the server (including keepalive comments). If the
   timer expires before the next byte, the stream is treated as
   silently dead: the request is destroyed and `onError` fires with a
   `"SSE stream stale"` error. The existing reconnect path
   (`handleSSEDisconnect` → `scheduleReconnect`) handles recovery.

2. **`onActivity` callback** — fires whenever any bytes arrive,
   including SSE comments that the parser would otherwise discard.
   Lets the runner advance `_lastSseEventAt` on keepalives so the
   SessionHealthStrip's "events stale" gauge reflects connection
   liveness, not just "did the agent emit something recently."

**`container-session-runner.ts`** passes:
- `idleTimeoutMs: 45_000` — 3× the worker's 15s keepalive cadence.
  Three missed keepalives is a robust dead-connection signal.
- `onActivity` — sets `this._lastSseEventAt = Date.now()`.

The reconnect machinery is unchanged. On stale detection, the existing
exponential-backoff reconnect kicks in. If the worker comes back, the
new SSE connection works and `sseReconnectAttempts` resets to 0. If the
worker is permanently dead, terminal reconnect fails out at 3 attempts
(existing behavior) and the SessionHealthStrip surfaces the worker as
unreachable.

### B. Auto-restart Docker event stream

**`container-health.ts`** changes:

1. Track a `stopped` flag in `HealthMonitorState` so an explicit
   `stopHealthMonitor()` call (e.g., shutdown) is distinguishable from
   a transient stream error.
2. On stream error or unexpected end, schedule a restart with a 5s
   debounce (avoids tight reconnect loop if the daemon is genuinely
   down). The restart re-enters `startHealthMonitor` with the same
   deps; the function is already idempotent (`if (state.eventStream)
   return;`).
3. `stopHealthMonitor` sets `stopped = true` and clears any pending
   restart timer.

This means a Docker daemon restart, socket EAGAIN, or any other
transient stream failure self-heals without user intervention.
`container_exited` events resume firing as soon as the new stream is
established.

## Key files

### Server

- `src/server/orchestrator/sse-client.ts` — add `ConnectSSEOpts`
  (`idleTimeoutMs`, `onActivity`), arm idle timer on every byte, fire
  `onError` on idle expiry.
- `src/server/orchestrator/sse-client.test.ts` *(new)* — unit tests
  for idle timeout, keepalive activity tracking, normal event
  delivery.
- `src/server/orchestrator/container-session-runner.ts` — pass
  `idleTimeoutMs` and `onActivity` when calling `connectSSE`; advance
  `_lastSseEventAt` from `onActivity`.
- `src/server/orchestrator/container-health.ts` — track `stopped`
  flag, debounce-restart on stream error, clear restart timer on
  explicit stop.
- `src/server/orchestrator/session-container.test.ts` — extend health
  monitor tests to cover the auto-restart path.

## Patterns this fits into

- **WebSocket lifecycle independence** (CLAUDE.md): the SSE stream
  between orchestrator and worker is *server-internal* — not the
  browser WS. So treating it as a transient channel that auto-recovers
  matches the same principle: transport-level failures must not affect
  state.
- **Idempotent recovery**: both restart paths (SSE reconnect, Docker
  event stream restart) are idempotent. Calling them while already
  connected is a no-op; calling them while disposed is a no-op.

## Out of scope (tracked elsewhere)

- **C — proactive worker watchdog** → `docs/112-container-recovery/checklist.md` (deferred section).
- **D — compose `pollStatus` silent failures** → new follow-up doc.
- **E — bounded SSE reconnect with surfaced error** → new follow-up doc.
- **F — compose log streamer restart on service recovery** → new follow-up doc.
