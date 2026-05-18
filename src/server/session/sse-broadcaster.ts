/**
 * SseBroadcaster — fan-out for the worker's Server-Sent Events stream.
 *
 * Each SSE client is represented by an attached `SseClient` (the worker's
 * `GET /events` handler creates one per connection). The broadcaster owns:
 *   - serialization of `WorkerSSEEvent` into the SSE wire format
 *     (`event: <type>\ndata: <json>\n\n`),
 *   - the set of currently-attached clients,
 *   - per-client backpressure tracking, with a callback the worker uses to
 *     pause/resume the terminal PTY when one or more clients can't keep up.
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

/** Serialize a worker SSE event to the SSE wire chunk. Exported for tests. */
export function serializeSSEEvent(event: WorkerSSEEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class SseBroadcaster {
  private readonly clients = new Set<SseClient>();
  private readonly backpressured = new Set<ServerResponse>();
  private readonly onBackpressureChange?: BackpressureChange;

  constructor(opts: { onBackpressureChange?: BackpressureChange } = {}) {
    this.onBackpressureChange = opts.onBackpressureChange;
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
   * Broadcast an event to every attached client. Per-client write errors are
   * swallowed (the client is removed); `terminal_data` writes that return
   * `false` from `res.write()` mark the client as backpressured until its
   * `drain` event fires, so the worker can pause the terminal PTY.
   */
  broadcast(event: WorkerSSEEvent): void {
    if (this.clients.size === 0) return;
    const chunk = serializeSSEEvent(event);
    // Snapshot to allow mutation during iteration (e.g. detach on error).
    for (const client of [...this.clients]) {
      this.sendChunk(client, chunk, event.type);
    }
  }

  /** Send a single event to one specific attached client. */
  sendTo(client: SseClient, event: WorkerSSEEvent): void {
    this.sendChunk(client, serializeSSEEvent(event), event.type);
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
