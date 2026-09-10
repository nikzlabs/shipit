
import type { FastifyInstance } from "fastify";
import type { TerminalProcess } from "./terminal.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import { whenNodeRuntimeReady } from "./node-runtime.js";

export interface TerminalControllerDeps {
  createTerminal: () => TerminalProcess;
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  hasBackpressure: () => boolean;
}

export class TerminalController {
  private terminal: TerminalProcess | null = null;

  private _terminalPaused = false;

  constructor(private readonly deps: TerminalControllerDeps) {}

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

      // The shell must inherit PATH after the repo-pinned Node is selected.
      await whenNodeRuntimeReady();

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

  stop(): void {
    if (this.terminal) {
      this.terminal.kill();
      this.terminal = null;
      this._terminalPaused = false;
    }
  }

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
