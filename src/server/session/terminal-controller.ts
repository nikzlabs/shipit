/**
 * Terminal controller — owns the worker's single PTY (`TerminalProcess`) and
 * registers the `/terminal/*` endpoints (start, input, resize). Streams PTY
 * output over SSE and mirrors the SSE broadcaster's backpressure onto the PTY
 * so a slow consumer pauses the shell instead of unbounded buffering.
 */

import type { FastifyInstance } from "fastify";
import type { TerminalProcess } from "./terminal.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";

export interface TerminalControllerDeps {
  createTerminal: () => TerminalProcess;
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  /** Whether any SSE client is currently backpressured. */
  hasBackpressure: () => boolean;
}

export class TerminalController {
  private terminal: TerminalProcess | null = null;

  // Terminal backpressure state. The SseBroadcaster owns the per-client set
  // of backpressured responses and invokes the worker's `onBackpressureChange`
  // callback when the aggregate state flips; `_terminalPaused` then mirrors
  // whether we've actually paused the PTY.
  private _terminalPaused = false;

  constructor(private readonly deps: TerminalControllerDeps) {}

  /** Whether a PTY is currently running — read by the SSE reconnect path. */
  hasActiveTerminal(): boolean {
    return this.terminal !== null;
  }

  registerRoutes(app: FastifyInstance): void {
    app.post<{ Body: { cols?: number; rows?: number } }>("/terminal/start", async (request) => {
      if (this.terminal) {
        return { started: true, existing: true };
      }

      const body = (request.body ?? {});
      const cols = typeof body.cols === "number" ? Math.max(1, Math.min(500, body.cols)) : 80;
      const rows = typeof body.rows === "number" ? Math.max(1, Math.min(200, body.rows)) : 24;

      this.terminal = this.deps.createTerminal();
      this.wireTerminalEvents(this.terminal);
      this.terminal.start(this.deps.workspaceDir, cols, rows);
      return { started: true };
    });

    app.post<{ Body: { data: string } }>("/terminal/input", async (request, reply) => {
      if (!this.terminal) {
        return reply.code(404).send({ error: "No terminal running" });
      }
      const { data } = request.body;
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be a string" });
      }
      this.terminal.write(data);
      return { written: true };
    });

    app.post<{ Body: { cols: number; rows: number } }>("/terminal/resize", async (request, reply) => {
      if (!this.terminal) {
        return reply.code(404).send({ error: "No terminal running" });
      }
      const body = request.body;
      const cols = typeof body.cols === "number" ? Math.max(1, Math.min(500, body.cols)) : 80;
      const rows = typeof body.rows === "number" ? Math.max(1, Math.min(200, body.rows)) : 24;
      this.terminal.resize(cols, rows);
      return { resized: true };
    });
  }

  /**
   * Pause or resume the terminal PTY based on SSE backpressure state.
   * Invoked by the SseBroadcaster's onBackpressureChange callback whenever
   * the aggregate "any client backpressured" state flips.
   */
  applyBackpressure(): void {
    if (this.deps.hasBackpressure()) {
      if (!this._terminalPaused && this.terminal) {
        this.terminal.pause();
        this._terminalPaused = true;
      }
    } else {
      if (this._terminalPaused && this.terminal) {
        this.terminal.resume();
        this._terminalPaused = false;
      }
    }
  }

  /** Kill the PTY (worker shutdown). */
  stop(): void {
    if (this.terminal) {
      this.terminal.kill();
      this.terminal = null;
      this._terminalPaused = false;
    }
  }

  /** Wire terminal events to the SSE stream. */
  private wireTerminalEvents(terminal: TerminalProcess): void {
    terminal.on("data", (data: string) => {
      this.deps.broadcast({ type: "terminal_data", data: { data } });
    });

    terminal.on("exit", (exitCode: number | null) => {
      this._terminalPaused = false;
      this.deps.broadcast({ type: "terminal_exit", data: { exitCode } });
      this.terminal = null;
    });
  }
}
