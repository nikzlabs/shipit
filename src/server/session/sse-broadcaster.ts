
import type { ServerResponse } from "node:http";

export interface WorkerSSEEvent {
  type:
    | "agent_event" | "agent_done" | "agent_error" | "agent_auth_required" | "agent_log"
    | "terminal_data" | "terminal_exit"
    | "file_changes"
    | "service_request"
    | "install_log" | "install_done" | "install_error"
    | "mcp_server_status"
    | "present_content" | "present_cleared";
  data: unknown;
}

export interface SseClient {
  raw: ServerResponse;
}

export type BackpressureChange = (backpressured: boolean) => void;

export const DEFAULT_BUFFER_CAPACITY = 5000;

// Terminal state has its own replay; buffering its volume would evict agent events.
const UNBUFFERED_TYPES = new Set<WorkerSSEEvent["type"]>(["terminal_data"]);

interface BufferedEvent {
  seq: number;
  chunk: string;
  type: WorkerSSEEvent["type"];
}

export function serializeSSEEvent(event: WorkerSSEEvent, seq?: number): string {
  const idLine = seq !== undefined ? `id: ${seq}\n` : "";
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export class SseBroadcaster {
  private readonly clients = new Set<SseClient>();
  private readonly backpressured = new Set<ServerResponse>();
  private readonly onBackpressureChange?: BackpressureChange;

  private readonly buffer: BufferedEvent[] = [];
  private readonly bufferCapacity: number;
  private nextSeq = 1;

  constructor(opts: { onBackpressureChange?: BackpressureChange; bufferCapacity?: number } = {}) {
    this.onBackpressureChange = opts.onBackpressureChange;
    this.bufferCapacity = opts.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
  }

  attach(client: SseClient): SseClient {
    this.clients.add(client);
    return client;
  }

  detach(client: SseClient): void {
    this.clients.delete(client);
    if (this.backpressured.delete(client.raw)) {
      this.emitBackpressureState();
    }
  }

  // Buffer before checking clients: child agents can start before SSE attaches.
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
    for (const client of [...this.clients]) {
      this.sendChunk(client, chunk, event.type);
    }
  }

  sendTo(client: SseClient, event: WorkerSSEEvent): void {
    this.sendChunk(client, serializeSSEEvent(event), event.type);
  }

  // Replay may be partial after eviction; callers must check for sequence gaps.
  replaySince(client: SseClient, sinceSeq: number): void {
    if (this.buffer.length === 0) return;
    for (const entry of this.buffer) {
      if (entry.seq <= sinceSeq) continue;
      this.sendChunk(client, entry.chunk, entry.type);
    }
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get oldestSeq(): number {
    return this.buffer[0]?.seq ?? 0;
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  hasBackpressure(): boolean {
    return this.backpressured.size > 0;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  rawResponses(): IterableIterator<ServerResponse> {
    const list: ServerResponse[] = [];
    for (const c of this.clients) list.push(c.raw);
    return list[Symbol.iterator]();
  }

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
