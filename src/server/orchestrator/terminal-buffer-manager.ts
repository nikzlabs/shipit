import { truncateTerminalBuffer } from "./terminal-buffer.js";

// Approximate 1,000 lines of 80 characters for reconnect replay.
export const MAX_TERMINAL_BUFFER = 80_000;

export const MAX_TERMINAL_RECONNECT_ATTEMPTS = 3;

export class TerminalBufferManager {
  static readonly MAX_TERMINAL_BUFFER = MAX_TERMINAL_BUFFER;
  static readonly MAX_RECONNECT_ATTEMPTS = MAX_TERMINAL_RECONNECT_ATTEMPTS;

  private _buffer = "";
  private _running = false;

  get running(): boolean { return this._running; }
  set running(v: boolean) { this._running = v; }

  append(data: string): void {
    this._buffer += data;
    if (this._buffer.length > MAX_TERMINAL_BUFFER) {
      this._buffer = truncateTerminalBuffer(this._buffer, MAX_TERMINAL_BUFFER);
    }
  }

  get buffer(): string { return this._buffer; }

  clear(): void { this._buffer = ""; }

  reset(): void {
    this._running = false;
  }
}
