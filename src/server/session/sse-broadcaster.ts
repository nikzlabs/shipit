/**
 * SseBroadcaster — fan-out for the worker's Server-Sent Events stream.
 *
 * Each SSE client is represented by an attached `SseClient` (the worker's
 * `GET /events` handler creates one per connection). The broadcaster owns:
 *   - serialization of `WorkerSSEEvent` into the SSE wire format
 *     (`id: <seq>\nevent: <type>\ndata: <json>\n\n`),
 *   - the set of currently-attached clients,
 *   - a bounded ring buffer of recent events keyed by monotonic seq number,
 *     so a late-connecting or reconnecting orchestrator can replay events
 *     it would otherwise have missed (see `replaySince`),
 *   - per-client backpressure tracking, with a callback the worker uses to
 *     pause/resume the terminal PTY when one or more clients can't keep up.
 *
 * Why the buffer: spawned-child sessions POST /agent/start before any
 * SSE consumer is attached, and the agent CLI starts emitting events
 * immediately. Without buffering, those events (agent_init, agent_assistant,
 * agent_result, agent_done) are silently dropped and the orchestrator's
 * `running` flag is stuck on forever. With the buffer, the events sit
 * until a consumer connects and pulls them via `?since=N`. This also
 * makes SSE reconnects mid-turn lossless.
 *
 * `terminal_data` is deliberately excluded from the buffer — it's
 * high-volume (would evict the events we care about) and the worker
 * already has a separate "current state" replay path on /events connect.
 *
 * The broadcaster never owns the keep-alive interval or the underlying
 * Fastify response lifecycle — those stay in the worker because they're
 * coupled to the HTTP request/reply objects. The broadcaster only cares
 * about the `send` and `raw` references the worker hands it.
 */

import type { ServerResponse } from "node:http";

/** Event types sent over the SSE stream to the orchestrator. */
export interface WorkerSSEEvent {
  type:
    | "agent_event" | "agent_done" | "agent_error" | "agent_auth_required" | "agent_log"
    | "terminal_data" | "terminal_exit"
    | "file_changes"
    | "service_request"
    | "install_log" | "install_done" | "install_error"
    | "mcp_server_status";
  data: unknown;
}

/**
 * A single attached SSE client. `raw` is the underlying Node response so the
 * broadcaster can write to it and react to `drain`; the worker creates this
 * value once per `/events` connection and hands it off via `attach()`.
 */
export interface SseClient {
  raw: ServerResponse;
}

export type BackpressureChange = (backpressured: boolean) => void;

/**
 * Default ring-buffer capacity. Sized to cover several full agent turns
 * (each turn can emit hundreds of streaming-token events) so an orchestrator
 * that disconnects for tens of seconds can still catch up losslessly.
 */
export const DEFAULT_BUFFER_CAPACITY = 5000;

/** Event types that are NOT pushed into the replay buffer. */
const UNBUFFERED_TYPES = new Set<WorkerSSEEvent["type"]>(["terminal_data"]);

interface BufferedEvent {
  seq: number;
  chunk: string;
  type: WorkerSSEEvent["type"];
}

/** Serialize a worker SSE event to the SSE wire chunk. Exported for tests. */
export function serializeSSEEvent(event: WorkerSSEEvent, seq?: number): string {
  const idLine = seq !== undefined ? `id: ${seq}\n` : "";
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class SseBroadcaster {
  private readonly clients = new Set<SseClient>();
  private readonly backpressured = new Set<ServerResponse>();
  private readonly onBackpressureChange?: BackpressureChange;

  // Ring buffer of recent broadcast events. Indexed by insertion order;
  // when full, the oldest entry is dropped. Each entry carries the
  // already-serialized SSE chunk so replay is a straight `write()`.
  private readonly buffer: BufferedEvent[] = [];
  private readonly bufferCapacity: number;
  private nextSeq = 1;

  constructor(opts: { onBackpressureChange?: BackpressureChange; bufferCapacity?: number } = {}) {
    this.onBackpressureChange = opts.onBackpressureChange;
    this.bufferCapacity = opts.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  /** Attach a new SSE client. Returns the same client for chaining. */
  attach(client: SseClient): SseClient {
    this.clients.add(client);
    return client;
  }

  /**
   * Detach an SSE client. Also clears any backpressure state for the client's
   * underlying response and fires the backpressure callback if the global
   * state changed as a result.
   */
  detach(client: SseClient): void {
    this.clients.delete(client);
    if (this.backpressured.delete(client.raw)) {
      this.emitBackpressureState();
    }
  }

  /**
   * Broadcast an event to every attached client AND record it in the ring
   * buffer (unless its type is unbuffered, e.g. `terminal_data`). Per-client
   * write errors are swallowed (the client is removed); `terminal_data`
   * writes that return `false` from `res.write()` mark the client as
   * backpressured until its `drain` event fires, so the worker can pause
   * the terminal PTY.
   *
   * Events are buffered regardless of whether any clients are currently
   * attached — this is the whole point of the replay system.
   */
  broadcast(event: WorkerSSEEvent): void {
    const buffered = !UNBUFFERED_TYPES.has(event.type);
    const seq = buffered ? this.nextSeq++ : undefined;
    const chunk = serializeSSEEvent(event, seq);
    if (buffered && seq !== undefined) {
      this.buffer.push({ seq, chunk, type: event.type });
      if (this.buffer.length > this.bufferCapacity) {
        this.buffer.shift();
      }
    }
    if (this.clients.size === 0) return;
    // Snapshot to allow mutation during iteration (e.g. detach on error).
    for (const client of [...this.clients]) {
      this.sendChunk(client, chunk, event.type);
    }
  }

  /** Send a single event to one specific attached client. Not buffered. */
  sendTo(client: SseClient, event: WorkerSSEEvent): void {
    this.sendChunk(client, serializeSSEEvent(event), event.type);
  }

  /**
   * Replay buffered events with seq > `sinceSeq` to a single client.
   * Called by the worker's /events handler when a connecting client passes
   * `?since=<seq>` (or 0 / omitted, meaning "everything I have").
   *
   * If `sinceSeq` is older than the oldest buffered seq, this still replays
   * what we have — the client may have lost some events, but partial replay
   * is strictly better than no replay. Higher layers can detect a gap by
   * comparing the first replayed seq against `sinceSeq + 1`.
   */
  replaySince(client: SseClient, sinceSeq: number): void {
    if (this.buffer.length === 0) return;
    for (const entry of this.buffer) {
      if (entry.seq <= sinceSeq) continue;
      this.sendChunk(client, entry.chunk, entry.type);
    }
  }

  /** Highest seq number broadcast so far (0 if none). For diagnostics/tests. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Current number of buffered events. For diagnostics/tests. */
  get bufferSize(): number {
    return this.buffer.length;
  }

  /** Whether any attached client is currently backpressured. */
  hasBackpressure(): boolean {
    return this.backpressured.size > 0;
  }

  /** Number of currently attached clients (for diagnostics/testing). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Iterate the raw responses of attached clients. The worker uses this
   * during shutdown to close every connection without having to track the
   * `ServerResponse` set itself.
   */
  rawResponses(): IterableIterator<ServerResponse> {
    const list: ServerResponse[] = [];
    for (const c of this.clients) list.push(c.raw);
    return list[Symbol.iterator]();
  }

  /** Clear all attached clients without writing to them. */
  clear(): void {
    this.clients.clear();
    const wasBackpressured = this.backpressured.size > 0;
    this.backpressured.clear();
    if (wasBackpressured) this.emitBackpressureState();
  }

  private sendChunk(client: SseClient, chunk: string, eventType: WorkerSSEEvent["type"]): void {
    try {
      const ok = client.raw.write(chunk);
      if (!ok && eventType === "terminal_data" && !this.backpressured.has(client.raw)) {
        this.backpressured.add(client.raw);
        this.emitBackpressureState();
        client.raw.once("drain", () => {
          if (this.backpressured.delete(client.raw)) {
            this.emitBackpressureState();
          }
        });
      }
    } catch {
      this.clients.delete(client);
      if (this.backpressured.delete(client.raw)) {
        this.emitBackpressureState();
      }
    }
  }

  private emitBackpressureState(): void {
    this.onBackpressureChange?.(this.backpressured.size > 0);
  }
}
