---
issue: planning#602
title: Foreground grace window — checklist
---

# 311 — Foreground grace window: checklist

- [ ] `WsPing` client message + `WsPong` server message, both in their unions
- [ ] `ping` → `pong` dispatch case in `route-registry.ts`
- [ ] `useForegroundSignal` measures away time and passes `{ awayMs }`
- [ ] `useWebSocket` probes a live socket on resume and keeps it when the probe answers
- [ ] `useWebSocket` forces a fresh socket past the one-minute cap and on probe failure
- [ ] Pong frames consumed by the transport, never dispatched
- [ ] Retry burst fires only at a handshake at least `STALLED_HANDSHAKE_MS` old
- [ ] Client tests: keep-on-probe-success, force-on-timeout, force-past-cap, retry does not kill a
      young handshake
- [ ] `useForegroundSignal` test for the measured away time
- [ ] Server test: `ping` is answered with a matching `pong`
- [ ] `docs/278-conditional-history-refetch` req 5 restated, and planning#324 told
- [ ] Lint, typecheck, affected tests
- [ ] Independent review against the numbered requirements
