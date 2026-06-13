import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { agentHome } from "../shared/agent-home.js";

/**
 * Manages an interactive shell process via node-pty.
 * Emits "data" for output and "exit" when the shell closes.
 */
export class TerminalProcess extends EventEmitter {
  private proc: IPty | null = null;

  /**
   * Spawn an interactive shell in the given directory.
   * No-op if a shell is already running.
   */
  start(cwd: string, cols = 80, rows = 24): void {
    if (this.proc) return;

    const shell = process.env.SHELL || "/bin/bash";
    this.proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // docs/150 — terminal shell runs as the unprivileged `shipit` user
      // (HOME=/home/shipit); agentHome() resolves to /root in local mode.
      env: { ...process.env, HOME: agentHome(), TERM: "xterm-256color", NODE_ENV: "development" },
    });

    this.proc.onData((data: string) => {
      this.emit("data", data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.emit("exit", exitCode);
      this.proc = null;
    });
  }

  /** Write user input to the shell. */
  write(data: string): void {
    if (this.proc) {
      this.proc.write(data);
    }
  }

  /** Resize the terminal. */
  resize(cols: number, rows: number): void {
    if (this.proc) {
      this.proc.resize(cols, rows);
    }
  }

  /** Pause reading from the PTY (backpressure flow control). */
  pause(): void {
    this.proc?.pause();
  }

  /** Resume reading from the PTY after a pause. */
  resume(): void {
    this.proc?.resume();
  }

  /** Kill the shell process. */
  kill(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
