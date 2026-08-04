/**
 * Shared stubs and helpers for container/worker integration tests.
 *
 * Used by worker-terminal.test.ts, worker-file-watcher.test.ts, and the
 * fake-Docker container fixtures (container-lifecycle, standby-container,
 * warm-pool-staleness, child-message-resume).
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

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
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  runCalled = false;
  lastParams: AgentRunParams | null = null;
  killed = false;
  interrupted = false;
  stdinData: string[] = [];

  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    this.runCalled = true;
    this.lastParams = params;
  }
  writeStdin(data: string): void { this.stdinData.push(data); }
  sendUserMessage(text: string): void { this.writeStdin(text); }
  interrupt(): void { this.interrupted = true; }
  kill(): void { this.killed = true; }
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
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

/**
 * Allocate a loopback TCP port that is guaranteed to have no listener.
 *
 * Fake-Docker container fixtures need a `workerPort` (and IP) whose resulting
 * worker URL (a) can NEVER reach a real session worker and (b) fails
 * instantly. Both constraints are load-bearing:
 *
 * - The production worker port (9100) must never appear in a fixture. When
 *   this suite runs inside a ShipIt session container (dogfooding), the
 *   session's REAL worker listens on 127.0.0.1:9100 — a fixture pointing
 *   there makes the test orchestrator's persistent-409 recovery
 *   (container-session-runner.ts, docs/142 Problem B2) POST /agent/kill and
 *   SIGTERM the very agent running vitest, mid-turn. Observed in production.
 * - Bridge IPs (172.18.x) are no safer: inside a session container they can
 *   be live NEIGHBOR session workers on the shared Docker network, and in
 *   some CI network namespaces they blackhole, resolving only on a 12s
 *   fail-open timeout that blows the per-test budget.
 * - Loopback + a dead port yields an instant ECONNREFUSED everywhere, so the
 *   env-prep secret pushes, SSE connects, and /agent/start calls that
 *   ContainerSessionRunner fires at the fixture URL fail fast and touch
 *   nothing real.
 *
 * Binding port 0 lets the kernel pick a free ephemeral port; closing the
 * listener frees it dead. The kernel cycles through the ephemeral range
 * before reusing a port, so it stays dead for the lifetime of a test run.
 *
 * Fixture IPs may be any distinct `127.0.0.x` (the whole 127/8 block is
 * loopback on Linux) — with the dead port they all refuse instantly, and
 * distinctness keeps per-container IP assertions meaningful.
 */
export async function allocateDeadLoopbackPort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      resolve((srv.address() as net.AddressInfo).port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    srv.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

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
