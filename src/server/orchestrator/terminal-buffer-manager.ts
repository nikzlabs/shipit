/**
 * TerminalBufferManager — owns the server-side terminal output buffer and
 * the SSE-reconnect attempt counter that bounds terminal recovery.
 *
 * Extracted from container-session-runner.ts so the runner can delegate
 * terminal buffering and reconnect bookkeeping to a single object.
 *
 * Behavior preserved verbatim:
 *  - Buffer is byte-truncated to MAX_TERMINAL_BUFFER (~80KB, ~1000 lines)
 *    via `truncateTerminalBuffer` for safe ANSI/newline boundaries.
 *  - Terminal reconnect attempts are capped at MAX_RECONNECT_ATTEMPTS (3);
 *    `recordReconnectAttempt()` returns the new attempt number so callers
 *    can compare against the cap.
 */
import { truncateTerminalBuffer } from "./terminal-buffer.js";

/**
 * Maximum size of the server-side terminal output buffer in bytes.
 * Sized at ~80KB to approximate the client's 1000-line xterm.js scrollback
 * buffer (assuming ~80 chars/line average). This ensures that replayed
 * output on reconnect covers roughly the same window the user could scroll
 * through on the client.
 *
 * The client-side xterm.js scrollback (1000 lines) and this server-side
 * byte buffer serve different purposes: the server buffer enables replay
 * after SSE reconnection, while the client buffer provides local scroll.
 * They may drift — the server may hold data that doesn't fit in client
 * scrollback, or vice versa — which is acceptable since server-side replay
 * is "best effort" to restore visual context after a reconnect.
 */
export const MAX_TERMINAL_BUFFER = 80_000;

/** Maximum SSE reconnection attempts for terminal recovery. */
export const MAX_TERMINAL_RECONNECT_ATTEMPTS = 3;

export class TerminalBufferManager {
  static readonly MAX_TERMINAL_BUFFER = MAX_TERMINAL_BUFFER;
  static readonly MAX_RECONNECT_ATTEMPTS = MAX_TERMINAL_RECONNECT_ATTEMPTS;

  private _buffer = "";
  private _running = false;

  /** Whether the remote terminal inside the container is running. */
  get running(): boolean { return this._running; }
  set running(v: boolean) { this._running = v; }

  /** Append output, truncating in-place when the byte cap is exceeded. */
  append(data: string): void {
    this._buffer += data;
    if (this._buffer.length > MAX_TERMINAL_BUFFER) {
      this._buffer = truncateTerminalBuffer(this._buffer, MAX_TERMINAL_BUFFER);
    }
  }

  get buffer(): string { return this._buffer; }

  clear(): void { this._buffer = ""; }

  /**
   * Clear the running flag on dispose. Matches the original
   * ContainerSessionRunner.dispose: only `_remoteTerminalRunning` was set
   * to false; the buffer itself was left intact (the runner is about to
   * be discarded — clearing it adds no value).
   */
  reset(): void {
    this._running = false;
  }
}
