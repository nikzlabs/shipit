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

Unify the agent-container and service log paths **end to end** — storage, transport, and rendering — so they are one mechanism with per-channel parameters, not two parallel implementations.

- A **single, durable log store** that both the agent-container log stream and every service log stream append to.
- Logs survive **orchestrator restart, runner disposal, idle eviction, and container destruction**. They are removed only when the session itself is archived/deleted.
- On attach, the backlog is replayed from this store — full retained history, not a slice that happened to survive in RAM.
- One store class, one **channel-keyed transport** (one snapshot + append + clear message set, replacing both `log_entry`/`clear_logs` and `service_log*`), and **one read-only renderer** (`<LogView channel=… />`) used by both the terminal Logs tab and the service drawer.

## Non-goals

- Merging the two **UI locations**. The agent Logs tab lives in the bottom terminal panel; service logs live in the preview-services drawer. They keep their own mount points and placement — they just both mount the same `<LogView>` component pointed at different channels. (Unifying the *component* ≠ merging the *panels*.)
- The **Shell** tab. That's a bidirectional interactive PTY (`InteractiveTerminal`), not a log view — out of scope.
- Unbounded retention. We keep a bounded, rotated backlog per `(session, channel)`, not the complete forever-history of a chatty dev server.
- Cross-session aggregation or a global log search UI.

## Design

### Why files, not SQLite

The first cut of this doc proposed a `container_logs` table in the shared `.shipit.db`. We rejected it: dev-server logs can be thousands of lines/sec, and every line is an `INSERT` + append-time prune that **serialises against chat-history / usage / session-metadata writes on the same database**. WAL helps readers, but a single writer still bottlenecks, and we'd be paying durability/transaction overhead for data that is fundamentally a scratch ring buffer. Log volume should never be able to slow down the metadata that actually needs ACID guarantees.

So logs live in **per-session append-only files** instead. Plain `fs.appendFile` to a dedicated fd is far cheaper than a transactional INSERT, contends with nothing, and rotates with a simple file swap.

### Where the files live

Per-session log files sit in a `logs/` directory **alongside** the git checkout, not inside it:

```
sessions/{sessionId}/
  workspace/            ← the git checkout (auto-committed, watched, in the file tree)
  logs/                 ← NEW: durable log backlog (host-side, never committed, never watched)
    agent.jsonl         ← the Logs-tab channel (structured entries)
    service-<name>.log  ← one raw-text file per preview service
```

This placement is deliberate:
- **Outside `workspace/`** → never picked up by `git add -A` (auto-commit) and never appears in the file watcher / file tree. Putting logs *inside* the checkout was rejected: `.shipit/` only stays out of git by ShipIt actively maintaining each repo's `.gitignore` (`github-ci-fix.ts`), which is unreliable for imported repos — a real risk of committing logs.
- **Host-side, outside the container** → survives container destruction, idle eviction, and orchestrator restart (the original durability requirement). It is *not* in the agent's `/workspace`.
- **Under the session dir** → naturally scoped to one session and removable with it (see Lifecycle).

### One store: `LogStore`

A new `LogStore` (`src/server/orchestrator/log-store.ts`) owns these files behind a single API consumed identically by the agent path and the service path:

```ts
type LogChannel = string; // "agent" | `service:${name}`

class LogStore {
  constructor(sessionsRoot: string);
  append(sessionId, channel, line): void;                   // O(1) append to the channel's fd
  snapshotEntries(sessionId, channel, maxLines): WsLogEntry[]; // structured replay (agent / JSONL)
  snapshotText(sessionId, channel, maxBytes): string;          // concatenated replay (service / raw)
  clear(sessionId, channel): void;                          // truncate the channel file(s)
  remove(sessionId): void;                                  // rm -rf sessions/{id}/logs
}
```

Only the two snapshot accessors differ in shape — `snapshotEntries` parses JSONL back into `WsLogEntry[]` for the structured, source-filtered Logs tab; `snapshotText` concatenates raw bytes for the xterm service panel. `append`, `clear`, and `remove` are byte-for-byte the same code for both channels.

- **Agent channel** (`agent.jsonl`): each appended line is a JSON object `{ ts, source, text }` where `source` ∈ `stderr|stdout|server|preview|install`. `snapshotEntries` reads the tail and `JSON.parse`s each line into a `WsLogEntry`.
- **Service channel** (`service-<name>.log`): raw `docker compose logs -f` chunk text, appended verbatim (ANSI preserved for the xterm panel; the HTTP route strips ANSI as it does today). `snapshotText` returns the tail bytes.

### Retention via file rotation (no per-write prune)

Each channel is size-capped with **two-file rotation**, which keeps appends O(1) and confines trimming to the (rare) rotation moment — no read-modify-write on the hot path:

- Track the active file's size in memory. On append, if it would exceed the cap, rename `agent.jsonl → agent.jsonl.1` (replacing any prior `.1`) and start a fresh active file.
- A snapshot reads `.1` then the active file and returns the last `maxLines` / `maxBytes`.
- Caps: `MAX_AGENT_BYTES` and `MAX_SERVICE_BYTES` per channel (e.g. ~1 MB each). Worst-case disk per channel is `2 × cap`. (Exact values in Open Questions.)

This is strictly cheaper than the rejected SQLite `INSERT`+prune-every-write, and bounds disk without a background timer.

### Unified transport: one channel-keyed message set

Today there are two parallel WS vocabularies — `log_entry` + `clear_logs` (agent) and `subscribe_service_logs` + `service_log_buffer` + `service_log` (services). We collapse both into one channel-keyed set built around a single record type:

```ts
type LogSource = "stderr" | "stdout" | "server" | "preview" | "install";
interface WsLogRecord { ts: string; source?: LogSource; text: string }

// client → server
{ type: "subscribe_logs", channel: string }           // replaces subscribe_service_logs + (implicit) agent attach
{ type: "log_clear",      channel: string }            // replaces clear_logs

// server → client
{ type: "log_snapshot", channel: string, records: WsLogRecord[] }  // replaces service_log_buffer + the connect-time replay
{ type: "log_append",   channel: string, records: WsLogRecord[] }  // replaces log_entry + service_log
```

A record is the common denominator: **agent** records carry `source` (so the client can filter and color them); **service** records omit `source` and carry a raw `-f` chunk verbatim in `text` (ANSI preserved). One envelope, one append path, one clear path — the only per-channel difference is whether `source` is populated.

The store's two snapshot accessors map cleanly: `snapshotEntries` → `WsLogRecord[]` with `source`; `snapshotText` → a single `WsLogRecord` (or a small batch) with raw `text` and no `source`.

### Unified rendering: one `<LogView>` component

Both surfaces render through a single read-only xterm component, replacing **both** `ServiceLogViewer` and the bespoke DOM list inside `TerminalPanel`:

```tsx
<LogView channel="agent" showSource />        // bottom terminal "Logs" tab
<LogView channel={`service:${name}`} />       // preview-services drawer
```

`LogView` owns the xterm instance (the existing `ServiceLogViewer` theme + fit + web-links logic, lifted verbatim) plus the `@xterm/addon-search` `SearchAddon`, and an in-memory `records[]` **model**:

- On mount: `send({ type: "subscribe_logs", channel })`.
- `log_snapshot` seeds the model and writes it; `log_append` pushes and writes incrementally; `log_clear` resets.
- **Rendering a record:** with `showSource` (agent), records are written as `dim(HH:MM:SS) {sourceColor}[src]{reset} text` — so each line still shows its origin and color, *and* the agent tab finally renders ANSI from CLI output (which the old DOM list stripped). Service records write `text` raw.

**Search, not filtering.** We drop the per-source filter chips (`err/out/srv/pre/ins`) entirely — they were cryptic and rarely used — and replace them with a **search box** wired to the `SearchAddon`: type to highlight matches, Enter / Shift-Enter (and ⌘/Ctrl-F to focus) for next / previous, with a match count. This is strictly simpler than the rejected filter approach (no buffer re-write on toggle), is what users actually reach for in a log pane, and works **identically for both channels** — services get search too, for free. `source` stays in the record for *display* (prefix + color via `showSource`); it just isn't a filter axis anymore.

This is a net **upgrade** for the agent Logs tab (true ANSI, terminal scrollback, web-links, copy, search) and deletes the second renderer entirely.

### Integration — agent container (the Logs tab)

`broadcastLog` is already the single choke point every agent-log producer funnels through (agent stdout/stderr, "Agent process started/exited", container-creation failures, preview errors, install output, idle-dispose notices, user-interrupt, stack errors — full producer list in §"Producers"). We change `createLogBuffer` so `broadcastLog` writes the entry through to `LogStore.append(sessionId, "agent", { ts, source, text })` (JSONL) instead of (or in addition to) the in-memory array.

A `subscribe_logs { channel: "agent" }` (sent by `<LogView>` on mount, and re-sent on every WS reconnect) replies with a `log_snapshot` built from `LogStore.snapshotEntries(sessionId, "agent", …)`. This replaces the old connect-time `clear_logs` + per-entry replay loop in `index.ts` (~line 1684): the snapshot *is* the replace, so the reconnect-dedup problem the old handshake worked around disappears (a snapshot wholesale-seeds the client model).

`log_clear { channel: "agent" }` → `LogStore.clear(sessionId, "agent")`.

### Integration — service containers (the log panels)

In `ServiceManager.streamLogs`, the `handleData` chunk handler that appends to `logBuffers` also calls `LogStore.append(sessionId, "service:" + name, chunk)`. The live emit becomes a `log_append { channel: "service:<name>", records: [{ ts, text: chunk }] }` (same envelope as the agent path) instead of the bespoke `service_log`.

The `subscribe_logs { channel: "service:<name>" }` reply is a `log_snapshot` from `LogStore.snapshotText(...)`. Both `handleSubscribeServiceLogs` and the `/services/:name/logs` HTTP route read the store as the source of truth. **Backfill on (re)start:** when a stream first starts, we still run `docker compose logs --since <lastPersistedTs>` once to capture lines Docker retained while the orchestrator was down, append them to the store, then attach the live `-f` follower — so an orchestrator restart doesn't punch a hole in service history.

`logBuffers.clear()` on reconcile/stop no longer loses user-visible history, because the durable copy lives in `LogStore`. We stop treating the in-memory ring as the backlog source.

### Lifecycle & cleanup

The user's ask was that logs be "automatically cleaned up eventually." Three layers deliver that:

- **Rotation** caps each channel's footprint continuously (above) — steady-state disk is bounded without anything else running.
- **Session archive / delete / full reset** → `LogStore.remove(sessionId)` (`rm -rf sessions/{id}/logs`), wired next to the existing `fs.rm(session.workspaceDir, …)` call (`index.ts` archive path, ~line 490) and `removeLogBuffer` cleanup. Note the existing cleanup removes the `workspace/` checkout but leaves the `sessions/{id}` parent, so the `logs/` sibling needs its own explicit removal — this is the one new wiring point the file location costs us.
- **Disk janitor** (`disk-janitor.ts`): add a `logs/` sweep alongside the existing orphan-workspace / orphan-cache sweeps — delete `sessions/{id}/logs` for any `{id}` not present in the session manager. Safety net for archives where the explicit `remove` didn't run (unclean shutdown), exactly like the orphan-workspace sweep it sits next to.

Logs for a **live-but-idle-evicted** session are intentionally **kept** (the session still exists; only its container was reclaimed) — that's the whole point of moving off the in-RAM buffers.

### Client

The client work is the rendering unification, not just a bigger backlog:

- **New `LogView` component** (lifts `ServiceLogViewer`'s xterm setup) consuming the channel-keyed messages and owning the `records[]` model + the `SearchAddon` search box. `ServiceLogViewer` is deleted.
- **`TerminalPanel`** keeps its Logs/Shell sub-tab switcher but **drops the source-filter chips**; the Logs content becomes `<LogView channel="agent" showSource />` with a search box, and the DOM-list rendering + the `terminal-store` `LogEntry[]` array + `hiddenSources` filter state are removed (the model now lives in `LogView`).
- **`PreviewServicesDrawer`** swaps `ServiceLogViewer` for `<LogView channel={"service:"+name} />`.
- **Message handlers** (`hooks/message-handlers/`) collapse `log_entry` + the `service_log*` handlers into one `log_snapshot` / `log_append` / `log_clear` path keyed by channel.
- Snapshot-seeds-the-model means a reconnect can't duplicate (the snapshot replaces the model), so the old `clear_logs`-first dance is no longer needed; we still test the reconnect path.

## Producers (agent channel) — must all keep flowing through `broadcastLog`

`agent-listeners.ts` (stdout/stderr relay, process start/exit, errors, steer-rejected, interrupts), `app-lifecycle.ts` (container-creation OOM/failure), `api-routes-preview.ts` (preview errors), `misc-handlers.ts` (user interrupt), `service-manager-setup.ts` (stack errors), `idle-enforcer.ts` (idle dispose notice), `turn-executor.ts` (container exit). The write-through lives inside `broadcastLog`, so every existing and future producer is covered without touching call sites.

## Testing

- `log-store.test.ts` — append/snapshot round-trip (both shapes), per-channel isolation, rotation at cap (`.1` swap, snapshot spans both files), `clear` (truncate) vs `remove` (rm dir), JSONL parse tolerance for a torn last line.
- Extend `terminal-logs-relay.test.ts` — agent logs survive a simulated orchestrator "restart" (new `LogStore` over the same `sessions/{id}/logs` dir) and replay on a fresh connect; cross-session non-leak still holds; `clear_logs` empties the durable file.
- Service path — `service-manager` test: streamed chunks land in the channel file; `snapshotLogs` reads the file; reconcile/`logBuffers.clear()` does **not** drop the durable backlog.
- No-duplicate-on-reconnect: a `log_snapshot` after reconnect replaces the model rather than appending (client idempotency).
- `LogView` component test: snapshot seeds + writes; append writes incrementally; `log_clear` resets; search highlights matches and next/prev cycles them; `showSource` renders the source prefix while a service channel does not.

## Migration / rollout

- No DB migration. The `logs/` directory is created lazily on first append; pre-existing in-memory logs are simply not retroactively persisted.
- The in-memory rings can be kept transiently during rollout but the durable files are the replay source of truth. (Open question below.)

## Open questions

1. **Source filtering → RESOLVED: drop the chips, add search.** The `err/out/srv/pre/ins` chips were cryptic and underused; replaced by a `SearchAddon` search box (next/prev/highlight/count) that works for both channels. `source` is kept for display (prefix + color) only. This also removes the filter-rewrite complexity entirely.
2. **Full-file search (future)?** Client search covers the loaded scrollback/snapshot (a large tail). Searching the *entire* persisted backlog would need a server-side grep over the channel file — deferred; the snapshot tail is expected to be enough.
3. **Keep the in-memory rings as a hot cache, or delete them entirely?** Leaning: keep `ServiceManager.logBuffers` only as the live-stream fan-out scratch, make `LogStore` the sole backlog source; collapse `createLogBuffer`'s array into a thin shim over `LogStore`.
4. **Retention caps** — confirm `MAX_AGENT_BYTES` / `MAX_SERVICE_BYTES` (~1 MB/channel?), and whether the agent cap should be line-count rather than bytes.
5. **Write batching** — append per line is fine for the agent channel; for chatty services consider coalescing `-f` chunks on a short timer (or relying on the OS write buffer) so we don't `appendFile` on every tiny chunk. Validate before optimising.
6. **fd lifecycle** — keep a long-lived append fd per active channel (fast, but must close on session dispose / rotate), or open-append-close per write (simpler, slightly slower). Leaning long-lived with close-on-dispose.

## Key files

- `src/server/orchestrator/log-store.ts` *(new)* — the file-backed store (`sessions/{id}/logs/`, two-file rotation).
- `src/server/orchestrator/app-lifecycle.ts` — `createLogBuffer` → write-through to `LogStore`.
- `src/server/orchestrator/index.ts` — WS-connect replay from `LogStore`; `LogStore.remove` on archive/delete.
- `src/server/orchestrator/service-manager.ts` — `streamLogs` append + `snapshotLogs` read from `LogStore`; `--since` backfill. (`ServiceManager` is constructed with the session dir, so it can resolve `logs/`.)
- `src/server/orchestrator/ws-handlers/service-handlers.ts` — `subscribe_service_logs`/`service_log*` → channel-keyed `subscribe_logs`/`log_*` handlers (shared with the agent channel).
- `src/server/orchestrator/api-routes-preview.ts` — `/services/:name/logs` reads the store.
- `src/server/orchestrator/disk-janitor.ts` — orphan-session `logs/` sweep.
- `src/server/orchestrator/session-dir-factory.ts` — reference for `sessions/{id}` layout (logs are a sibling of `workspace/`).
- `src/server/shared/types/ws-*-messages.ts` + `terminal-types.ts` — `WsLogRecord` + `subscribe_logs` / `log_snapshot` / `log_append` / `log_clear`; remove `log_entry` / `clear_logs` / `service_log*`.
- `src/client/components/LogView.tsx` *(new)* — unified xterm renderer + `SearchAddon` search box (replaces `ServiceLogViewer.tsx`, deleted).
- `src/client/components/TerminalPanel.tsx`, `PreviewServicesDrawer.tsx` — mount `<LogView>`; drop the DOM list, source chips, and `terminal-store` `LogEntry[]`/`hiddenSources`.
- `src/client/hooks/message-handlers/` — collapse log/service-log handlers into the channel-keyed path.
- `package.json` — add `@xterm/addon-search` (exact version, ≥7 days old, compatible with `@xterm/xterm` 6.0.0; run `npm install` + `npm run check-deps`).
