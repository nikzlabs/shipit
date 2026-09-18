import { connectSSE } from "./sse-client.js";
import type { SSEEvent } from "./sse-client.js";

// Three missed 15-second worker keepalives.
export const SSE_IDLE_TIMEOUT_MS = 45_000;
export const MAX_RECONNECT_DELAY_MS = 10_000;

export interface SseConnectionManagerOpts {
  logLabel: string;
  getWorkerUrl: () => string;
  workerReady: () => Promise<void>;
  onEvent: (event: SSEEvent) => void;
  onOpen?: (isReconnect: boolean) => void;
  /** Return false to stop reconnect attempts for this disconnect. */
  onDisconnect?: (attempt: number) => boolean | undefined;
  isDisposed: () => boolean;
  resourcesStarted: () => boolean;
}

export class SseConnectionManager {
  static readonly SSE_IDLE_TIMEOUT_MS = SSE_IDLE_TIMEOUT_MS;
  static readonly MAX_RECONNECT_DELAY_MS = MAX_RECONNECT_DELAY_MS;

  private opts: SseConnectionManagerOpts;
  private sseConnection: { close: () => void } | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectAttempts = 0;
  private _sseConnected: Promise<void> | null = null;
  private _resolveSseConnected: (() => void) | null = null;
  private _lastActivityAt = 0;
  private _streamDownSince = 0;
  private _lastSeenSeq = 0;

  constructor(opts: SseConnectionManagerOpts) {
    this.opts = opts;
  }

  // A request handle can exist before the response opens.
  get isConnected(): boolean { return this.sseConnection !== null; }

  get streamDownSince(): number { return this._streamDownSince; }

  // Skip an idle worker's old turn events before starting a fresh agent.
  fastForwardLastSeenSeq(seq: number): void {
    if (this.sseConnection) return;
    if (!Number.isFinite(seq) || seq <= this._lastSeenSeq) return;
    this._lastSeenSeq = seq;
  }

  get lastActivityAt(): number { return this._lastActivityAt; }
  markActivity(): void { this._lastActivityAt = Date.now(); }

  connect(): Promise<void> {
    if (this.sseConnection || this.opts.isDisposed()) {
      return this._sseConnected ?? Promise.resolve();
    }

    this._sseConnected = new Promise<void>((resolve) => {
      this._resolveSseConnected = resolve;
    });

    // eslint-disable-next-line no-restricted-syntax -- waits for container readiness in sync context
    void this.opts.workerReady().then(() => {
      if (this.sseConnection || this.opts.isDisposed()) return;
      this.connectNow();
    });

    return this._sseConnected;
  }

  private connectNow(): void {
    const isReconnect = this.sseReconnectAttempts > 0;
    const workerUrl = this.opts.getWorkerUrl();
    // since=0 replays events buffered before the first connection.
    const eventsUrl = `${workerUrl}/events?since=${this._lastSeenSeq}`;
    this.sseConnection = connectSSE(
      eventsUrl,
      (event) => {
        if (event.seq !== undefined && event.seq > this._lastSeenSeq) {
          this._lastSeenSeq = event.seq;
        }
        this.opts.onEvent(event);
      },
      (err) => {
        console.error(`[${this.opts.logLabel}] SSE error:`, err.message);
        this.sseConnection = null;
        this.handleDisconnect();
      },
      () => {
        this.sseConnection = null;
        if (this.opts.resourcesStarted() && !this.opts.isDisposed()) {
          this.handleDisconnect();
        }
      },
      () => {
        this.sseReconnectAttempts = 0;
        this._streamDownSince = 0;
        if (this._resolveSseConnected) {
          this._resolveSseConnected();
          this._resolveSseConnected = null;
        }
        this.opts.onOpen?.(isReconnect);
      },
      {
        idleTimeoutMs: SSE_IDLE_TIMEOUT_MS,
        onActivity: () => { this._lastActivityAt = Date.now(); },
      },
    );
  }

  private handleDisconnect(): void {
    // Latch before the callback: downtime must grow even if retries stop.
    if (this._streamDownSince === 0) this._streamDownSince = Date.now();
    const attempt = this.sseReconnectAttempts + 1;
    const proceed = this.opts.onDisconnect?.(attempt);
    if (proceed === false) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.opts.isDisposed() || this.sseReconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.sseReconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    this.sseReconnectAttempts++;

    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      void this.connect();
    }, delay);
  }

  disconnect(): void {
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
  }

  // Disposal unblocks connect(); awaiters must check isDisposed afterwards.
  resolvePendingConnect(): void {
    if (this._resolveSseConnected) {
      this._resolveSseConnected();
      this._resolveSseConnected = null;
    }
  }
}
