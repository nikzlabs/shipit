---
issue: https://linear.app/shipit-ai/issue/SHI-108
title: Persistent container logs (agent + services)
description: A single durable, disk-backed log store so the agent-container Logs tab and preview-service log panels both show full history across container destruction, idle eviction, and orchestrator restart.
---

# Persistent container logs (agent + services)

## Problem

When the user opens the terminal **Logs** tab, they see agent-container logs **only from the moment they attached** — earlier output is gone. Preview-service logs were partially fixed (docs/… commit `3b3e023ff`) by snapshotting `docker compose logs --tail N` from the durable Docker-side source on attach, but the agent container never got equivalent treatment, and even the service fix is bounded by the container's lifetime.

Both log surfaces are backed by **volatile, in-memory buffers** that are lost on the events that matter most:

| Surface | Source today | Lost on |
|---|---|---|
| Agent Logs tab | `createLogBuffer()` in `app-lifecycle.ts` — `Map<sessionId, WsLogEntry[]>`, capped at `MAX_LOG_ENTRIES = 500` | orchestrator restart (deploy), runner disposal/idle eviction, 500-entry rotation |
| Service log panel | `ServiceManager.logBuffers` (80 KB ring) + on-demand `docker compose logs --tail` | reconcile/restart (`logBuffers.clear()`), container `rm` (idle eviction), Docker log rotation |

The user asked for **full persistence** and that **the exact same code path serve both** the agent container and the service containers.

## Goals

- A **single, durable log store** that both the agent-container log stream and every service log stream append to.
- Logs survive **orchestrator restart, runner disposal, idle eviction, and container destruction**. They are removed only when the session itself is archived/deleted.
- On attach (WS connect for the agent Logs tab; `subscribe_service_logs` / HTTP for a service), the backlog is replayed from this store — full retained history, not a slice that happened to survive in RAM.
- One store class, one append/snapshot/clear/remove API, consumed identically by the agent path and the service path.

## Non-goals

- Unifying the **rendering**. The Logs tab renders structured, source-filtered entries (`WsLogEntry`); the service panel renders a raw xterm buffer. Those client components stay as-is. Only the **persistence + snapshot/replay layer** is shared.
- Unbounded retention. We keep a bounded, pruned backlog per `(session, channel)`, not the complete forever-history of a chatty dev server.
- Cross-session aggregation or a global log search UI.

## Design

### One store: `LogStore`

A new `LogStore` (`src/server/orchestrator/log-store.ts`), backed by a dedicated SQLite table in the existing `.shipit.db` (the same durable store that already survives every event above — chat history, sessions, usage all live there). Choosing SQLite over per-session files means we inherit the existing migration machinery, WAL durability, and the disk-janitor/session-deletion hooks already keyed by `sessionId`.

```ts
type LogChannel = string; // "agent" | `service:${name}`

interface LogLine {
  sessionId: string;
  channel: LogChannel;
  seq: number;        // monotonic per (session, channel), assigned on append
  ts: string;         // ISO timestamp
  source: string;     // agent: "stderr"|"stdout"|"server"|"preview"|"install"; service: "" 
  text: string;       // one entry (agent) or one streamed chunk (service)
}

class LogStore {
  append(sessionId, channel, source, text): void;        // INSERT + prune-on-write
  snapshotEntries(sessionId, channel, maxLines): LogLine[];  // structured replay (agent)
  snapshotText(sessionId, channel, maxBytes): string;        // concatenated replay (service)
  clear(sessionId, channel): void;                       // DELETE one channel
  remove(sessionId): void;                               // DELETE all channels for a session
}
```

The **same** `append` / `snapshot` / `clear` / `remove` methods serve both surfaces; only the two thin snapshot accessors differ in shape (array of entries for the structured Logs tab; concatenated string for the xterm service panel) and both read the identical table.

### Schema (new migration in `database.ts`)

```sql
CREATE TABLE container_logs (
  session_id TEXT NOT NULL,
  channel    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  PRIMARY KEY (session_id, channel, seq)
);
CREATE INDEX idx_container_logs_lookup ON container_logs (session_id, channel, seq);
```

**Retention / pruning** runs on append (cheap, amortized): keep at most `MAX_AGENT_ENTRIES` (e.g. 5 000) rows per agent channel and at most `MAX_SERVICE_BYTES` (e.g. 1 MB) per service channel, deleting the lowest-`seq` rows beyond the cap. Byte accounting for the service cap is tracked per `(session, channel)` so we prune by total text length, mirroring today's `MAX_LOG_BUFFER` semantics.

### Integration — agent container (the Logs tab)

`broadcastLog` is already the single choke point every agent-log producer funnels through (agent stdout/stderr, "Agent process started/exited", container-creation failures, preview errors, install output, idle-dispose notices, user-interrupt, stack errors — full producer list in §"Producers"). We change `createLogBuffer` so `broadcastLog` writes through to `LogStore.append(sessionId, "agent", source, text)` instead of (or in addition to) the in-memory array.

On WS connect (`index.ts` ~line 1684), replace the `getLogBuffer(sessionId)` replay with `LogStore.snapshotEntries(sessionId, "agent", MAX_AGENT_ENTRIES)`. The existing `clear_logs`-then-replay handshake (so reconnecting viewers replace rather than append) is unchanged — it just replays from the durable store.

`clear_logs` → `LogStore.clear(sessionId, "agent")`.

### Integration — service containers (the log panels)

In `ServiceManager.streamLogs`, the `handleData` chunk handler that appends to `logBuffers` also calls `LogStore.append(sessionId, "service:" + name, "", chunk)`. The live `emit("service_log", …)` path is unchanged (live streaming stays in-memory + WS).

`ServiceManager.snapshotLogs(name)` (used by both `handleSubscribeServiceLogs` and the `/services/:name/logs` HTTP route) reads from `LogStore.snapshotText(sessionId, "service:" + name, MAX_SERVICE_BYTES)` as the source of truth. **Backfill on (re)start:** when a stream first starts, we still run `docker compose logs --since <lastPersistedTs>` once to capture lines Docker retained while the orchestrator was down, append them to the store, then attach the live `-f` follower — so an orchestrator restart doesn't punch a hole in service history.

`logBuffers.clear()` on reconcile/stop no longer loses user-visible history, because the durable copy lives in `LogStore`. We stop treating the in-memory ring as the backlog source.

### Lifecycle & retention

- **Append-time prune** keeps each channel bounded (above).
- **`clear_logs` / service clear** → `LogStore.clear(session, channel)`.
- **Session archive / delete / full reset** → `LogStore.remove(sessionId)`, wired next to the existing `removeLogBuffer` / chat-history cleanup call sites.
- **Disk janitor** (`disk-janitor.ts`): add a sweep that deletes `container_logs` rows for sessions no longer present in the session manager (mirrors the orphan-volume / orphan-cache sweeps). Logs for a live-but-idle-evicted session are **kept** — that's the whole point.

### Client

No structural client changes. The agent Logs tab and `ServiceLogViewer` already consume `log_entry` / `service_log_buffer` + live streams; they now simply receive a fuller backlog. We verify the existing `clear_logs`-replace + idempotent-append behavior still holds so a reconnect replaying a larger backlog doesn't duplicate.

## Producers (agent channel) — must all keep flowing through `broadcastLog`

`agent-listeners.ts` (stdout/stderr relay, process start/exit, errors, steer-rejected, interrupts), `app-lifecycle.ts` (container-creation OOM/failure), `api-routes-preview.ts` (preview errors), `misc-handlers.ts` (user interrupt), `service-manager-setup.ts` (stack errors), `idle-enforcer.ts` (idle dispose notice), `turn-executor.ts` (container exit). The write-through lives inside `broadcastLog`, so every existing and future producer is covered without touching call sites.

## Testing

- `log-store.test.ts` — append/snapshot round-trip (both shapes), per-channel isolation, prune-at-cap (entries and bytes), `clear` vs `remove`, monotonic `seq`.
- Extend `terminal-logs-relay.test.ts` — agent logs survive a simulated orchestrator "restart" (new `LogStore` over the same DB) and replay on a fresh connect; cross-session non-leak still holds; `clear_logs` empties the durable store.
- Service path — `service-manager` test: streamed chunks land in the store; `snapshotLogs` reads the store; reconcile/`logBuffers.clear()` does **not** drop the durable backlog.
- No-duplicate-on-reconnect: replaying a larger backlog after a reconnect doesn't double-render (client idempotency).

## Migration / rollout

- One additive migration (new table + index) — no backfill; pre-existing in-memory logs are simply not retroactively persisted.
- Behind no flag by default; the in-memory ring buffers can be kept transiently during rollout but the durable store is the replay source of truth. (Open question below.)

## Open questions

1. **Keep the in-memory rings as a hot cache, or delete them entirely?** Leaning: keep `ServiceManager.logBuffers` only as the live-stream fan-out scratch, make `LogStore` the sole backlog source; delete `createLogBuffer`'s array (the Map becomes a thin shim over `LogStore`).
2. **Retention caps** — confirm `MAX_AGENT_ENTRIES` (5 000?) and `MAX_SERVICE_BYTES` (1 MB/service?) and whether service retention should be line-count instead of bytes.
3. **DB volume** — high-frequency dev-server logging means frequent INSERT+prune. Validate WAL throughput; if it's a problem, batch appends (e.g. coalesce service chunks on a short timer) before the first write.

## Key files

- `src/server/orchestrator/log-store.ts` *(new)* — the store.
- `src/server/shared/database.ts` — `container_logs` migration.
- `src/server/orchestrator/app-lifecycle.ts` — `createLogBuffer` → write-through to `LogStore`.
- `src/server/orchestrator/index.ts` — WS-connect replay from `LogStore`.
- `src/server/orchestrator/service-manager.ts` — `streamLogs` append + `snapshotLogs` read from `LogStore`; `--since` backfill.
- `src/server/orchestrator/ws-handlers/service-handlers.ts`, `api-routes-preview.ts` — unchanged call shape; now durable underneath.
- `src/server/orchestrator/disk-janitor.ts` — orphan-session log sweep.
- session archive/delete/full-reset paths — `LogStore.remove(sessionId)`.
