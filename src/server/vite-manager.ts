import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";

const VITE_PORT = 5173;
const WORKSPACE_DIR = "/workspace";

// Resolve the vite binary from the project's own node_modules so we never
// trigger an npx download when spawning in /workspace.
const VITE_BIN = path.resolve(process.cwd(), "node_modules/.bin/vite");

export class ViteManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _running = false;
  private _port = VITE_PORT;

  get running(): boolean {
    return this._running;
  }

  get port(): number {
    return this._port;
  }

  /**
   * Start the Vite dev server in /workspace.
   * If already running, this is a no-op.
   */
  start(): void {
    if (this.proc) return;

    console.log("[vite-manager] starting Vite dev server on port", this._port);

    this.proc = spawn(VITE_BIN, ["--port", String(this._port), "--host", "0.0.0.0"], {
      cwd: WORKSPACE_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.log("[vite]", text.trim());

      // Detect when Vite is ready (it prints the local URL)
      if (text.includes("Local:") || text.includes("ready in")) {
        if (!this._running) {
          this._running = true;
          this.emit("ready", this._port);
        }
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[vite stderr]", text);
    });

    this.proc.on("close", (code) => {
      console.log("[vite-manager] Vite exited with code", code);
      this._running = false;
      this.proc = null;
      this.emit("stopped", code);
    });

    this.proc.on("error", (err) => {
      console.error("[vite-manager] spawn error:", err.message);
      this._running = false;
      this.proc = null;
      this.emit("error", err);
    });
  }

  /**
   * Stop the Vite dev server.
   */
  stop(): void {
    if (this.proc) {
      console.log("[vite-manager] stopping Vite dev server");
      this.proc.kill("SIGTERM");
      this.proc = null;
      this._running = false;
    }
  }

  /**
   * Restart the Vite dev server.
   */
  restart(): void {
    this.stop();
    this.start();
  }
}
