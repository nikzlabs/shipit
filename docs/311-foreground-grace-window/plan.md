---
issue: planning#602
title: Foreground grace window — design
description: Keep a foregrounded socket that answers a ping, force a fresh one only after a minute away, and stop the retry burst killing handshakes in flight.
---

# 311 — Foreground grace window: design

Implements [`requirements.md`](./requirements.md). Requirements are cited as `(req N)`.

## The path being fixed

`useForegroundSignal` fires on every resume — `visibilitychange` → visible, `pageshow`, `online`,
and a `focus` classified as external. `useWebSocket.reconnectForForeground` answers it by throwing
the current socket away and opening a fresh one, **unconditionally and however brief the absence**.
The fresh socket drives `status` through `connecting`, which is what raises the banner 1.5 s later
(`ConnectionBanner.tsx`) and what makes `send()` return `false` — the mobile file-picker failure,
since the picker backgrounds the page and the return lands the user on a socket that is still
connecting (req 1, req 2).

That teardown is not gratuitous. A mobile OS kills a backgrounded TCP connection without telling
the JS layer, so `readyState` keeps reading `OPEN` over a socket that will never deliver another
byte. Waiting for a `close` that never fires strands the UI on stale data until a page reload,
which is why the recovery was driven by page-lifecycle events rather than by the connection looking
unhealthy.

So the fix cannot be "skip the reconnect when the socket looks open": that is exactly the answer
that lies. It has to **stop trusting `readyState` and start proving liveness** (req 5).

## The design

### An application-level probe, because the transport-level one is not ours

On a resume, the client sends `{ type: "ping", id }` on the existing socket and waits
`PROBE_TIMEOUT_MS` (2 s) for evidence of life. Protocol-level WebSocket pings cannot serve here —
they are server-initiated and the browser answers them beneath JS, so a page has no way to send one
or observe one.

**Any inbound frame settles the probe alive**, not only the matching pong: bytes arriving from the
server prove the path works, whatever they say. The pong exists so that a server with nothing to
say still produces one. The pong frame is consumed inside `useWebSocket` and never reaches
`dispatchMessage`, because it is transport bookkeeping and not a message the app has any business
seeing.

- Probe answers within the window → **keep the socket**. `status` never leaves `open`, so there is
  no banner, no `historyLoaded` reset, no refetch, no attach burst, and `send()` keeps working
  throughout (req 1, req 2).
- Probe times out → **force a fresh socket**, which is exactly today's behaviour, delayed by up to
  2 s.

The probe runs on the *existing* socket while it is still `OPEN`, so the composer is live for its
whole duration — a message sent during the window goes out on a socket that is either healthy (the
common case) or was already dead before the user returned. That second case is the pre-existing
silent-loss hole documented on `UseWebSocketReturn.send`; closing it needs a server-side ack keyed
on `requestId` and is out of scope here.

### The one-minute rule is a cap on the probe, not a replacement for it

An absence of a minute or more skips the probe and forces a fresh socket outright (req 3). Away
time is measured from the evidence that the page actually left — `visibilitychange` → hidden,
`pagehide`, `freeze`, or a `blur` classified as external — and `useForegroundSignal` hands it to
its consumer as `onForeground({ awayMs })`. An absence it could not measure (`awayMs`
`undefined` — a `pageshow` or an `online` with no preceding away signal) probes rather than
forces: the probe is the cheaper answer and it is correct either way.

Nothing closes the socket while the page is hidden (req 4); the rule governs the return only, and
the reasoning is in the requirements doc's resolved questions.

### The retry burst only fires at a handshake old enough to be stalled

`reconnectForForeground` schedules extra reconnects at 300 ms, 1200 ms and 3000 ms, each of which
calls `openFreshSocket()` whenever the socket is not yet `OPEN`. A socket still `CONNECTING` is not
`OPEN`, and `openFreshSocket` re-runs the connect effect, whose cleanup closes the current socket —
so on any link where a handshake takes longer than 300 ms, which is every cellular link, the burst
**destroys the handshake it is waiting for**, three times, before backoff gets its own attempt
(req 6).

The burst exists for one case the backoff loop genuinely cannot cover: a socket that sits in
`CONNECTING` forever and never fires `close`, which is what a mobile radio that has not finished
waking produces. Everything else already reconnects through `onclose` → backoff. So the rule
becomes: **retry only against a handshake that has been in flight long enough to be considered
stalled.** The socket records `connectStartedAt` when it is created; a retry fires only if the
socket is not `OPEN` *and* the current attempt is at least `STALLED_HANDSHAKE_MS` (3 s) old, and
the delays move to 3 s / 9 s.

### SSE keeps reconnecting unconditionally

`useServerEvents` shares the same foreground signal and is deliberately left alone. `EventSource`
is unidirectional, so there is no probe to send; and its keepalive is an SSE comment, which the
browser never surfaces to JS, so the client cannot observe liveness at all. Its reconnect also
costs the user nothing visible — no banner, no composer gating. The two connections still listen
to the same signal set on the same terms; only the WebSocket can answer "are you alive", so only it
acts on the answer.

## Key files

| File | Change |
|---|---|
| `src/client/hooks/useForegroundSignal.ts` | Track away-since; hand `{ awayMs }` to `onForeground`. |
| `src/client/hooks/useWebSocket.ts` | Probe, grace decision, `connectStartedAt`, stalled-handshake retry rule. |
| `src/server/shared/types/ws-client-messages.ts` | `WsPing`. |
| `src/server/shared/types/ws-server-messages/misc.ts` | `WsPong`. |
| `src/server/orchestrator/route-registry.ts` | `ping` → `pong`, answered before any session work. |
| `docs/278-conditional-history-refetch/requirements.md` | Req 5 no longer holds; restated. |

## What this does not change

- Nothing closes a socket because the page is hidden, so a hidden tab keeps pinning its container
  exactly as before (req 4).
- A resume that finds the socket already `closed` or in backoff reconnects immediately, as today —
  there is nothing to probe.
- The history refetch path (`docs/278`) is untouched. A kept socket never resets `historyLoaded`,
  so the conditional refetch simply stops being reached on short switches.
