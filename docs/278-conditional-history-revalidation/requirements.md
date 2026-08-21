# Conditional chat-history revalidation (per-session transcript revision)

Tracker: planning#324 (migrated from Linear SHI-322). Adjacent: planning#375 (the
body-hash ETag + client revalidation this builds on), planning#268 (windowed
loading, a future consumer of the same primitive).

1. Returning focus to a ShipIt tab must not re-download or re-parse the chat
   transcript when the session's persisted transcript has not changed since the
   client last loaded it. The tab-focus reconnect itself stays exactly as it is
   (see req 2) — only the history payload may be elided.
2. The WebSocket must keep reconnecting unconditionally on tab focus. Mobile OSes
   silently kill backgrounded sockets while `readyState` still reads OPEN, so
   gating the reconnect on a health check is useless and forbidden.
3. Eliding the payload must be a *validated* conditional request answered by the
   server — never the client deciding on its own that its copy is still good.
   HTTP history is the only path that recovers transcript mutations that happened
   while the client was disconnected, so a blind skip can strand a stale or
   truncated transcript.
4. The server-side validator must move on EVERY mutation of a session's
   persisted transcript: appends, in-place card updates (a lifecycle transition
   patches an existing row — neither the max row id nor the row count changes),
   and full rewrites alike. A validator computed from row ids and counts alone
   does not satisfy this.
5. Deciding whether the payload changed must not require reading and
   re-materializing the session's messages. The whole point is that the common
   case (nothing changed, healthy connection, alt-tab back) stops paying the
   transcript-sized cost on either side of the wire.

## Open questions

(none)

## Resolved questions

- 2026-08-21 — BENCHMARK ASSUMPTION (no human available in this session): the
  response ETag changes from a hash of the full response body to a validator
  derived from the per-session transcript revision plus the small non-transcript
  sources (commits, runner state, usage, presentations, rewind snapshot). Every
  client holding a pre-change tag gets one full 200 after deploy, then normal
  revalidation. Chosen because the body hash cannot answer without building the
  megabyte payload (req 5), and the issue's proposed fix names exactly this
  counter.
- 2026-08-21 — BENCHMARK ASSUMPTION: the revision counter counts mutations of
  the session's `messages` rows only. Rewind-snapshot rows are not transcript,
  but they ride the response, so they are covered by hashing them directly into
  the same validator rather than by bumping the counter.
- 2026-08-21 — BENCHMARK ASSUMPTION: the browser client needs no change. It has
  sent `If-None-Match` and reused its cached parse on a 304 since planning#375;
  the ETag is opaque to it. This feature is the server-side validator that lets
  the 304 be decided cheaply and survive in-place updates.
