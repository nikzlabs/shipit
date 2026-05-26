/**
 * SseConnectionManager — owns the SSE connection state for ContainerSessionRunner.
 *
 * Encapsulates:
 *  - the single active SSE handle to the worker's /events stream
 *  - reconnect bookkeeping (exponential backoff up to MAX_RECONNECT_DELAY_MS)
 *  - the "first-open" Promise consumed by callers that want to await readiness
 *  - the SSE idle-keepalive timeout passed through to `connectSSE`
 *  - the "last activity" timestamp surfaced by the container health endpoint
 *
 * Extracted from container-session-runner.ts. The reconnect cadence, idle
 * timeout, and the use of a single resolved-once promise are preserved
 * byte-for-byte from the original implementation — only the ownership of
 * the state moves.
 *
 * The runner still owns higher-level reconnect side effects (terminal-replay
 * emission, install-state resync, terminal-reconnect attempt cap) because
 * those touch runner state that doesn't belong to the SSE layer. The
 * `onOpen` and `onDisconnect` callbacks let the runner hook in without
 * exposing the SSE handle.
 */
import { connectSSE } from "./sse-client.js";
import type { SSEEvent } from "./sse-client.js";

/**
 * Idle timeout for the SSE stream. The worker sends a keepalive
 * comment every 15s (`session-worker.ts`); we treat ≥3 missed
 * keepalives (45s) as a silently-dead connection and force a
 * reconnect. Without this, half-open TCP sockets (NAT idle drops,
 * frozen worker processes) appear "connected" indefinitely and the
 * agent / terminal / preview surfaces freeze with no recovery.
 */
export const SSE_IDLE_TIMEOUT_MS = 45_000;

/** Cap on the exponential reconnect backoff. */
export const MAX_RECONNECT_DELAY_MS = 10_000;

export interface SseConnectionManagerOpts {
  /** Log label (typically the session id) for console diagnostics. */
  logLabel: string;
  /** Base URL of the worker — `/events` is appended. */
  getWorkerUrl: () => string;
  /** Resolves when the worker URL is real (not a placeholder). */
  workerReady: () => Promise<void>;
  /** Called with each parsed SSE event. */
  onEvent: (event: SSEEvent) => void;
  /**
   * Called after the underlying http response opens. `isReconnect` is true
   * when at least one prior reconnect attempt happened in this manager.
   */
  onOpen?: (isReconnect: boolean) => void;
  /**
   * Called when the SSE stream errors or closes unexpectedly. The runner
   * uses this to emit `terminal_reconnecting` messages and to enforce the
   * terminal-only reconnect cap. The manager itself schedules the actual
   * reconnect attempt — this hook is purely informational.
   *
   * Returning `false` aborts the auto-reconnect for this disconnect cycle.
   * Returning `true` (or `undefined`) lets the manager proceed with its
   * exponential-backoff schedule.
   */
  onDisconnect?: (attempt: number) => boolean | undefined;
  /** True if the manager should treat closes as silent (no reconnect). */
  isDisposed: () => boolean;
  /** True if worker resources have been started — gates onClose reconnects. */
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
  /**
   * Highest seq number observed on any event from the worker. Passed
   * back as `?since=N` on every (re)connect so the worker's ring buffer
   * replays only events we haven't already processed. Survives reconnect
   * cycles for the life of this manager — the only way to reset it is
   * to dispose the runner.
   */
  private _lastSeenSeq = 0;

  constructor(opts: SseConnectionManagerOpts) {
    this.opts = opts;
  }

  /** Whether an SSE connection is currently established (handle present). */
  get isConnected(): boolean { return this.sseConnection !== null; }

  /** Timestamp of the most recent SSE byte from the worker (0 = never). */
  get lastActivityAt(): number { return this._lastActivityAt; }
  /** Manually advance the activity gauge (e.g. from a parsed event). */
  markActivity(): void { this._lastActivityAt = Date.now(); }

  /**
   * Connect to the worker SSE stream. Returns a promise that resolves once
   * the connection is open. Idempotent: a second call while connected
   * returns the same promise (or a resolved one if already opened).
   */
  connect(): Promise<void> {
    if (this.sseConnection || this.opts.isDisposed()) {
      return this._sseConnected ?? Promise.resolve();
    }

    this._sseConnected = new Promise<void>((resolve) => {
      this._resolveSseConnected = resolve;
    });

    // Wait for the container to be ready before connecting
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
    // Always pass `since` (0 on first connect, last-seen seq on reconnect).
    // The worker treats 0 as "send me everything you have," which is
    // exactly right: events the worker buffered before our first connect
    // get replayed losslessly.
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
        // onOpen — SSE connection established
        // Reset reconnect counter only on successful connection
        this.sseReconnectAttempts = 0;
        if (this._resolveSseConnected) {
          this._resolveSseConnected();
          this._resolveSseConnected = null;
        }
        this.opts.onOpen?.(isReconnect);
      },
      {
        idleTimeoutMs: SSE_IDLE_TIMEOUT_MS,
        // Advance the liveness gauge on every byte from the worker,
        // including keepalive comments. The event-dispatch path also
        // marks activity; keeping both write paths means the gauge
        // reflects connection health (not just "agent emitted something").
        onActivity: () => { this._lastActivityAt = Date.now(); },
      },
    );
  }

  /**
   * Called by the manager when the SSE stream errors or closes. Invokes
   * `onDisconnect` (so the runner can react) and schedules a reconnect
   * unless the runner explicitly aborts the cycle.
   */
  private handleDisconnect(): void {
    const attempt = this.sseReconnectAttempts + 1;
    const proceed = this.opts.onDisconnect?.(attempt);
    if (proceed === false) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.opts.isDisposed() || this.sseReconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 10s (capped)
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

  /** Close the active SSE connection and cancel any pending reconnect timer. */
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

  /**
   * Unblock any awaiter of `connect()` even if the SSE stream never opened.
   * Called from runner.dispose() so a pending `connect()` chain doesn't leak
   * — awaiters that proceed past it must check `isDisposed` and bail.
   */
  resolvePendingConnect(): void {
    if (this._resolveSseConnected) {
      this._resolveSseConnected();
      this._resolveSseConnected = null;
    }
  }
}
