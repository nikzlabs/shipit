---
issue: planning#602
title: Foreground grace window — checklist
---

# 311 — Foreground grace window: checklist

- [x] `WsPing` client message + `WsPong` server message, both in their unions
- [x] `ping` → `pong` dispatch case in `route-registry.ts`, with the echoed id bounded
- [x] `useForegroundSignal` measures away time and passes `{ awayMs }`; `onAway` for the release
- [x] `useWebSocket` probes a live socket on resume and keeps it when the probe answers
- [x] `useWebSocket` forces a fresh socket past the away limit and on probe failure
- [x] `send()` refuses while a probe is pending, so no confirmation outruns an unproven socket
- [x] Hidden release, including a socket opened while the page was already hidden
- [x] Pong frames consumed by the transport, never dispatched
- [x] Retry burst fires only at a handshake at least `STALLED_HANDSHAKE_MS` old
- [x] Client tests: keep-on-probe-success, force-on-timeout, force-past-cap, send refusal,
      release paths, retry does not kill a young handshake
- [x] `useForegroundSignal` tests for the measured away time and `onAway`
- [x] Server tests: `ping` answered with a matching `pong`, and the id bounded
- [x] `docs/278-conditional-history-refetch` req 5 restated, and planning#324 told
- [x] Lint, typecheck, affected tests
- [x] Verified in a real browser against the running orchestrator: a brief switch away sends one
      ping and keeps the socket with no banner; 60 s hidden closes it with no background
      reconnect; returning opens exactly one new socket
- [x] Independent review against the numbered requirements; all five findings fixed
