/**
 * Shared stubs and helpers for container/worker integration tests.
 *
 * Used by worker-terminal.test.ts, worker-preview.test.ts, and
 * worker-file-watcher.test.ts.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

export class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as import("../../shared/types.js").PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
  };

  runCalled = false;
  lastParams: AgentRunParams | null = null;
  killed = false;
  interrupted = false;
  stdinData: string[] = [];

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(data: string): void { this.stdinData.push(data); }
  interrupt(): void { this.interrupted = true; }
  kill(): void { this.killed = true; }
}

/** Stub TerminalProcess that doesn't spawn a real PTY. */
export class StubTerminal extends EventEmitter {
  startCalled = false;
  lastCwd = "";
  lastCols = 0;
  lastRows = 0;
  writtenData: string[] = [];
  resizedTo: { cols: number; rows: number }[] = [];
  killed = false;
  paused = false;

  start(cwd: string, cols: number, rows: number): void {
    this.startCalled = true;
    this.lastCwd = cwd;
    this.lastCols = cols;
    this.lastRows = rows;
  }

  write(data: string): void { this.writtenData.push(data); }
  resize(cols: number, rows: number): void { this.resizedTo.push({ cols, rows }); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  kill(): void { this.killed = true; }
  get running(): boolean { return this.startCalled; }
}

/** Stub PreviewManager that doesn't spawn real processes. */
export class StubPreview extends EventEmitter {
  private _running = false;
  private _ports: number[] = [];
  startCalled = false;
  stopCalled = false;

  get running() { return this._running; }
  get ports() { return this._ports; }

  async start(_cwd: string) {
    this.startCalled = true;
    this._running = true;
  }

  stop() {
    this.stopCalled = true;
    this._running = false;
  }

  removeAllListeners() { super.removeAllListeners(); return this; }

  /** Test helper: simulate becoming ready with ports. */
  simulateReady(ports: number[]) {
    this._ports = ports;
    this.emit("ready", ports);
  }

  /** Test helper: simulate stopped event. */
  simulateStopped(code: number | null) {
    this._running = false;
    this.emit("stopped", code);
  }

  /** Test helper: simulate log event. */
  simulateLog(source: string, text: string) {
    this.emit("log", { source, text });
  }
}

/** Stub FileWatcher that doesn't watch the filesystem. */
export class StubWatcher extends EventEmitter {
  startCalled = false;
  stopCalled = false;
  lastPath = "";

  start(path: string): void {
    this.startCalled = true;
    this.lastPath = path;
  }

  stop(): void { this.stopCalled = true; }
  removeAllListeners() { super.removeAllListeners(); return this; }

  /** Test helper: simulate file changes. */
  simulateChanges(paths: string[]) {
    this.emit("changes", paths);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect SSE events from a raw HTTP connection to the worker. */
export function collectSSE(
  workerUrl: string,
  onEvent: (type: string, data: unknown) => void,
): { close: () => void } {
  const url = new URL("/events", workerUrl);
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { Accept: "text/event-stream" } },
    (res) => {
      let buffer = "";
      let currentEvent = "";
      let currentData = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
          else if (line.startsWith("data: ")) currentData = line.slice(6);
          else if (line === "") {
            if (currentEvent && currentData) {
              try { onEvent(currentEvent, JSON.parse(currentData)); } catch { /* ignore */ }
            }
            currentEvent = "";
            currentData = "";
          }
        }
      });
    },
  );
  req.end();
  return { close: () => req.destroy() };
}

/** Wait for a condition to become true. */
export async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}
