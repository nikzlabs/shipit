/**
 * ContainerSessionRunner — SessionRunner implementation that delegates to a
 * remote session worker over HTTP + SSE.
 *
 * Implements the same SessionRunnerInterface as the direct SessionRunner.
 * From the perspective of HandlerContext, WebSocket handlers, and the registry,
 * this is indistinguishable from a direct runner.
 *
 * Phase 1: agent start/stop/interrupt + SSE event forwarding.
 * Phase 3: terminal, preview, file watcher proxy.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams } from "./agents/agent-process.js";
import type { WsServerMessage, ClaudeContentBlockToolUse } from "./types.js";
import type { TerminalProcess } from "./terminal.js";
import type { PreviewManager } from "./preview-manager.js";
import type { FileWatcher } from "./file-watcher.js";
import type { SessionRunnerInterface, SessionRunnerEvents, QueuedMessage } from "./session-runner.js";

// ---------------------------------------------------------------------------
// SSE Client — connects to the worker's /events endpoint
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;
  data: string;
}

/**
 * Minimal SSE client using raw http.request. Avoids the EventSource polyfill
 * dependency. Parses "event:" and "data:" fields from the SSE stream.
 */
function connectSSE(
  url: string,
  onEvent: (event: SSEEvent) => void,
  onError: (err: Error) => void,
  onClose: () => void,
): { close: () => void } {
  const parsedUrl = new URL(url);
  let destroyed = false;

  const req = http.request(
    {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    },
    (res) => {
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete last line

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "") {
            // End of event
            if (currentEvent && currentData) {
              onEvent({ type: currentEvent, data: currentData });
            }
            currentEvent = "";
            currentData = "";
          }
          // Skip comments (lines starting with ":")
        }
      });

      res.on("end", () => {
        if (!destroyed) onClose();
      });

      res.on("error", (err) => {
        if (!destroyed) onError(err);
      });
    },
  );

  req.on("error", (err) => {
    if (!destroyed) onError(err);
  });

  req.end();

  return {
    close: () => {
      destroyed = true;
      req.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: POST JSON to worker
// ---------------------------------------------------------------------------

async function workerPost(baseUrl: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid response from worker: ${data}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Proxy AgentProcess — bridges worker events to the AgentProcess interface
// ---------------------------------------------------------------------------

/**
 * A proxy AgentProcess that doesn't own a real process — it represents
 * the agent running inside the worker. Events are pushed in by the
 * ContainerSessionRunner's SSE listener.
 */
class ProxyAgentProcess extends EventEmitter<{
  event: [AgentEvent];
  done: [exitCode: number];
  error: [Error];
  auth_required: [];
  log: [source: string, text: string];
}> implements AgentProcess {
  readonly agentId: AgentId;
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as import("./types.js").PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
  };

  constructor(agentId: AgentId) {
    super();
    this.agentId = agentId;
  }

  // These are no-ops — the real process lives in the worker.
  // Start/stop/interrupt are handled via HTTP to the worker.
  run(_params: AgentRunParams): void { /* no-op — worker handles this */ }
  writeStdin(_data: string): void { /* no-op — use workerPost /agent/stdin */ }
  interrupt(): void { /* no-op — use workerPost /agent/interrupt */ }
  kill(): void { /* no-op — use workerPost /agent/kill */ }
}

// ---------------------------------------------------------------------------
// ContainerSessionRunner
// ---------------------------------------------------------------------------

export class ContainerSessionRunner extends EventEmitter<SessionRunnerEvents> implements SessionRunnerInterface {
  readonly sessionId: string;
  readonly sessionDir: string;

  // Worker connection
  private workerUrl: string;
  private sseConnection: { close: () => void } | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sseReconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 10_000;

  // Agent state (mirrored locally for synchronous access by HandlerContext)
  private _agent: ProxyAgentProcess | null = null;
  private _agentId: AgentId;
  private _isRunning = false;
  private _wasInterrupted = false;
  private _accumulatedText = "";
  private _accumulatedToolUse: ClaudeContentBlockToolUse[] = [];
  private _turnSummary = "";
  private _chatMessageGroups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> = [];
  private _needsNewMessageGroup = true;

  // Message queue
  private _messageQueue: QueuedMessage[] = [];
  private static readonly MAX_QUEUE_SIZE = 50;

  // Terminal (Phase 3)
  private _terminal: TerminalProcess | null = null;
  private _terminalOutputBuffer = "";
  private static readonly MAX_TERMINAL_BUFFER = 10_000;

  // Auto-push timer
  private _pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn event buffer
  private _turnEventBuffer: WsServerMessage[] = [];
  private static readonly MAX_TURN_BUFFER = 1000;

  // Viewer tracking
  private _viewerCount = 0;

  // Per-session detected ports
  private _detectedPorts: number[] = [];

  // Idle timer
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleTimeoutMs: number;

  private _disposed = false;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    workerUrl: string;
    idleTimeoutMs?: number;
    createPreviewManager?: () => PreviewManager;
    createFileWatcher?: () => FileWatcher;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this._agentId = opts.defaultAgentId;
    this.workerUrl = opts.workerUrl;
    this._idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000;
    this.resetIdleTimer();
  }

  // --- Agent state (same interface as SessionRunner) ---

  get running(): boolean { return this._isRunning; }
  set running(v: boolean) { this._isRunning = v; }

  get wasInterrupted(): boolean { return this._wasInterrupted; }
  set wasInterrupted(v: boolean) { this._wasInterrupted = v; }

  get accumulatedText(): string { return this._accumulatedText; }
  set accumulatedText(s: string) { this._accumulatedText = s; }

  get accumulatedToolUse(): ClaudeContentBlockToolUse[] { return this._accumulatedToolUse; }
  set accumulatedToolUse(blocks: ClaudeContentBlockToolUse[]) { this._accumulatedToolUse = blocks; }

  get turnSummary(): string { return this._turnSummary; }
  set turnSummary(s: string) { this._turnSummary = s; }

  get chatMessageGroups(): Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }> { return this._chatMessageGroups; }
  set chatMessageGroups(groups: Array<{ text: string; toolUse: ClaudeContentBlockToolUse[] }>) { this._chatMessageGroups = groups; }

  get needsNewMessageGroup(): boolean { return this._needsNewMessageGroup; }
  set needsNewMessageGroup(v: boolean) { this._needsNewMessageGroup = v; }

  get agentId(): AgentId { return this._agentId; }
  set agentId(id: AgentId) { this._agentId = id; }

  getAgent(): AgentProcess | null { return this._agent; }

  setAgent(a: AgentProcess | null): void {
    // When the orchestrator sets the agent, it's creating a new one to run.
    // For the container runner, we create a proxy that receives events via SSE.
    this._agent = a as ProxyAgentProcess | null;
  }

  // --- Message queue ---

  get messageQueue(): QueuedMessage[] { return this._messageQueue; }
  get queueLength(): number { return this._messageQueue.length; }

  enqueue(msg: QueuedMessage): number {
    if (this._messageQueue.length >= ContainerSessionRunner.MAX_QUEUE_SIZE) {
      throw new Error(`Message queue is full (max ${ContainerSessionRunner.MAX_QUEUE_SIZE})`);
    }
    this._messageQueue.push(msg);
    return this._messageQueue.length;
  }

  dequeue(): QueuedMessage | undefined {
    return this._messageQueue.shift();
  }

  clearQueue(): void {
    this._messageQueue.length = 0;
  }

  getQueueSnapshot(): Array<{ text: string; position: number }> {
    return this._messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  // --- Terminal ---

  getTerminal(): TerminalProcess | null { return this._terminal; }
  setTerminal(t: TerminalProcess | null): void { this._terminal = t; }

  appendTerminalOutput(data: string): void {
    this._terminalOutputBuffer += data;
    if (this._terminalOutputBuffer.length > ContainerSessionRunner.MAX_TERMINAL_BUFFER) {
      this._terminalOutputBuffer = this._terminalOutputBuffer.slice(
        -ContainerSessionRunner.MAX_TERMINAL_BUFFER,
      );
    }
  }

  getTerminalOutputBuffer(): string { return this._terminalOutputBuffer; }
  clearTerminalOutputBuffer(): void { this._terminalOutputBuffer = ""; }

  // --- Auto-push timer ---

  getPushTimer(): ReturnType<typeof setTimeout> | null { return this._pushTimer; }
  setPushTimer(t: ReturnType<typeof setTimeout> | null): void { this._pushTimer = t; }

  clearPushTimer(): void {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
  }

  // --- Turn event buffer ---

  getTurnEventBuffer(): WsServerMessage[] { return [...this._turnEventBuffer]; }
  clearTurnEventBuffer(): void { this._turnEventBuffer = []; }

  emitMessage(msg: WsServerMessage): void {
    if (this._turnEventBuffer.length < ContainerSessionRunner.MAX_TURN_BUFFER) {
      this._turnEventBuffer.push(msg);
    } else if (this._turnEventBuffer.length === ContainerSessionRunner.MAX_TURN_BUFFER) {
      const keep = 10;
      const recent = this._turnEventBuffer.length - keep;
      this._turnEventBuffer = [
        ...this._turnEventBuffer.slice(0, keep),
        ...this._turnEventBuffer.slice(recent),
        msg,
      ];
    }
    this.emit("message", msg);
  }

  // --- Detected ports ---

  get detectedPorts(): number[] { return this._detectedPorts; }
  set detectedPorts(ports: number[]) { this._detectedPorts = ports; }

  // --- Viewer management ---

  get viewerCount(): number { return this._viewerCount; }

  getPreview(): PreviewManager | null { return null; /* Phase 3 */ }
  getFileWatcher(): FileWatcher | null { return null; /* Phase 3 */ }

  attachViewer(): void {
    this._viewerCount++;
    if (this._viewerCount === 1 && !this._disposed) {
      this.connectEventStream();
    }
  }

  detachViewer(): void {
    this._viewerCount = Math.max(0, this._viewerCount - 1);
    if (this._viewerCount === 0) {
      this.disconnectEventStream();
    }
  }

  buildPreviewStatus(): WsServerMessage {
    // Phase 3: query worker for preview status
    if (this._detectedPorts.length > 0) {
      return {
        type: "preview_status",
        running: true,
        port: this._detectedPorts[0],
        url: `http://localhost:${this._detectedPorts[0]}`,
        source: "detected",
        detectedPorts: this._detectedPorts,
      };
    }
    return {
      type: "preview_status",
      running: false,
      port: 5173,
      url: "http://localhost:5173",
    };
  }

  // --- Worker communication ---

  /**
   * Start an agent on the worker. Creates a proxy AgentProcess locally
   * that receives events via the SSE stream.
   */
  async startAgentOnWorker(agentId: AgentId, params: AgentRunParams): Promise<ProxyAgentProcess> {
    const proxy = new ProxyAgentProcess(agentId);
    this._agent = proxy;

    await workerPost(this.workerUrl, "/agent/start", { agentId, params });

    // Ensure SSE is connected to receive events
    if (!this.sseConnection) {
      this.connectEventStream();
    }

    return proxy;
  }

  /** Interrupt the agent running on the worker. */
  async interruptAgentOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/agent/interrupt");
  }

  /** Kill the agent running on the worker. */
  async killAgentOnWorker(): Promise<void> {
    await workerPost(this.workerUrl, "/agent/kill");
    this._agent = null;
  }

  /** Write to the agent's stdin on the worker. */
  async writeAgentStdin(data: string): Promise<void> {
    await workerPost(this.workerUrl, "/agent/stdin", { data });
  }

  // --- SSE connection management ---

  private connectEventStream(): void {
    if (this.sseConnection || this._disposed) return;

    this.sseConnection = connectSSE(
      `${this.workerUrl}/events`,
      (event) => this.handleSSEEvent(event),
      (err) => {
        console.error(`[container-runner:${this.sessionId}] SSE error:`, err.message);
        this.sseConnection = null;
        this.scheduleReconnect();
      },
      () => {
        this.sseConnection = null;
        if (this._viewerCount > 0 && !this._disposed) {
          this.scheduleReconnect();
        }
      },
    );

    this.sseReconnectAttempts = 0;
  }

  private disconnectEventStream(): void {
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._disposed || this.sseReconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 10s (capped)
    const delay = Math.min(
      1000 * Math.pow(2, this.sseReconnectAttempts),
      ContainerSessionRunner.MAX_RECONNECT_DELAY_MS,
    );
    this.sseReconnectAttempts++;

    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      this.connectEventStream();
    }, delay);
  }

  private handleSSEEvent(event: SSEEvent): void {
    try {
      const data = JSON.parse(event.data);

      switch (event.type) {
        case "agent_event":
          // Forward to the proxy agent process so wireAgentListeners picks it up
          if (this._agent) {
            this._agent.emit("event", data as AgentEvent);
          }
          break;

        case "agent_done":
          if (this._agent) {
            this._agent.emit("done", data.exitCode ?? 0);
          }
          break;

        case "agent_error":
          if (this._agent) {
            this._agent.emit("error", new Error(data.message ?? "Unknown worker error"));
          }
          break;

        case "agent_auth_required":
          if (this._agent) {
            this._agent.emit("auth_required");
          }
          break;

        case "agent_log":
          if (this._agent) {
            this._agent.emit("log", data.source ?? "worker", data.text ?? "");
          }
          break;
      }
    } catch (err) {
      console.error(`[container-runner:${this.sessionId}] Failed to parse SSE event:`, err);
    }
  }

  // --- Lifecycle ---

  onAgentFinished(): void {
    if (!this._isRunning && this._messageQueue.length === 0) {
      this.resetIdleTimer();
      this.emit("idle");
    }
  }

  private resetIdleTimer(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this._isRunning && this._messageQueue.length === 0 && this._viewerCount === 0) {
        this.dispose();
      }
    }, this._idleTimeoutMs);
  }

  get disposed(): boolean { return this._disposed; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Kill agent on worker (fire and forget)
    if (this._agent) {
      workerPost(this.workerUrl, "/agent/kill").catch(() => {});
      this._agent = null;
    }

    this.disconnectEventStream();
    this.clearPushTimer();
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this._messageQueue.length = 0;
    this._turnEventBuffer = [];
    this._isRunning = false;
    this.emit("disposed");
    this.removeAllListeners();
  }
}
