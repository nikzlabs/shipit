import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { agentHome } from "../shared/agent-home.js";

export class TerminalProcess extends EventEmitter {
  private proc: IPty | null = null;

  start(cwd: string, cols = 80, rows = 24): void {
    if (this.proc) return;

    const shell = process.env.SHELL || "/bin/bash";
    this.proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
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

  write(data: string): void {
    if (this.proc) {
      this.proc.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.proc) {
      this.proc.resize(cols, rows);
    }
  }

  pause(): void {
    this.proc?.pause();
  }

  resume(): void {
    this.proc?.resume();
  }

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
