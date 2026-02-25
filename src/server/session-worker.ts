/**
 * Session Worker — lightweight Fastify server that runs inside each container
 * (or as a subprocess in non-Docker mode for testing).
 *
 * Manages a single session's agent process and streams events back to the
 * orchestrator via SSE. The orchestrator talks to this server over HTTP
 * on port 9100 (or a configured port).
 *
 * Phase 1 scope: agent start/stop/interrupt + SSE event stream.
 * Phase 3 will add terminal, preview, and file watcher endpoints.
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentRunParams, AgentEvent, AgentId } from "./agents/agent-process.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event types sent over the SSE stream to the orchestrator. */
export interface WorkerSSEEvent {
  type: "agent_event" | "agent_done" | "agent_error" | "agent_auth_required" | "agent_log";
  data: unknown;
}

/** Factory function that creates an AgentProcess from an agent ID. */
export type WorkerAgentFactory = (agentId: AgentId) => AgentProcess;

export interface SessionWorkerDeps {
  /** Factory for creating agent processes. */
  agentFactory: WorkerAgentFactory;
  /** Port to listen on. Defaults to 9100. */
  port?: number;
  /** Host to bind to. Defaults to "0.0.0.0". */
  host?: string;
}

// ---------------------------------------------------------------------------
// SessionWorker
// ---------------------------------------------------------------------------

/**
 * The session worker manages a single agent process and exposes it over HTTP.
 * SSE clients connect to GET /events and receive real-time agent output.
 */
export class SessionWorker extends EventEmitter {
  private app: FastifyInstance;
  private agent: AgentProcess | null = null;
  private agentFactory: WorkerAgentFactory;
  private sseClients = new Set<(event: WorkerSSEEvent) => void>();
  private sseRawResponses = new Set<import("node:http").ServerResponse>();
  private port: number;
  private host: string;

  constructor(deps: SessionWorkerDeps) {
    super();
    this.agentFactory = deps.agentFactory;
    this.port = deps.port ?? 9100;
    this.host = deps.host ?? "0.0.0.0";
    this.app = this.buildApp();
  }

  private buildApp(): FastifyInstance {
    const app = Fastify({ logger: false });

    // Health check
    app.get("/health", async () => ({ status: "ok" }));

    // --- Agent endpoints ---

    app.post<{ Body: { agentId: AgentId; params: AgentRunParams } }>("/agent/start", async (request, reply) => {
      if (this.agent) {
        return reply.code(409).send({ error: "Agent already running" });
      }

      const { agentId, params } = request.body as { agentId: AgentId; params: AgentRunParams };
      if (!agentId || !params) {
        return reply.code(400).send({ error: "agentId and params are required" });
      }

      try {
        this.agent = this.agentFactory(agentId);
        this.wireAgentEvents(this.agent);
        this.agent.run(params);
        return { started: true };
      } catch (err) {
        this.agent = null;
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: message });
      }
    });

    app.post("/agent/interrupt", async (_request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.interrupt();
      return { interrupted: true };
    });

    app.post("/agent/kill", async (_request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.kill();
      this.agent = null;
      return { killed: true };
    });

    app.post<{ Body: { data: string } }>("/agent/stdin", async (request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      const { data } = request.body as { data: string };
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be a string" });
      }
      this.agent.writeStdin(data);
      return { written: true };
    });

    app.get("/agent/status", async () => ({
      running: this.agent !== null,
    }));

    // --- SSE event stream ---

    app.get("/events", (request, reply) => {
      // Hijack the response so Fastify doesn't manage it — this allows
      // the SSE stream to stay open without blocking Fastify shutdown.
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Send initial keepalive
      reply.raw.write(": connected\n\n");

      const sendEvent = (event: WorkerSSEEvent) => {
        try {
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        } catch {
          // Client disconnected
          this.sseClients.delete(sendEvent);
        }
      };

      this.sseClients.add(sendEvent);
      this.sseRawResponses.add(reply.raw);

      // Keep alive every 15s
      const keepalive = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(keepalive);
          this.sseClients.delete(sendEvent);
        }
      }, 15_000);

      // Clean up on disconnect
      request.raw.on("close", () => {
        clearInterval(keepalive);
        this.sseClients.delete(sendEvent);
        this.sseRawResponses.delete(reply.raw);
      });
    });

    return app;
  }

  /** Wire agent events to the SSE stream. */
  private wireAgentEvents(agent: AgentProcess): void {
    agent.on("event", (event: AgentEvent) => {
      this.broadcastSSE({ type: "agent_event", data: event });
    });

    agent.on("done", (exitCode: number) => {
      this.broadcastSSE({ type: "agent_done", data: { exitCode } });
      this.agent = null;
    });

    agent.on("error", (err: Error) => {
      this.broadcastSSE({ type: "agent_error", data: { message: err.message } });
      this.agent = null;
    });

    agent.on("auth_required", () => {
      this.broadcastSSE({ type: "agent_auth_required", data: {} });
    });

    agent.on("log", (source: string, text: string) => {
      this.broadcastSSE({ type: "agent_log", data: { source, text } });
    });
  }

  /** Send an SSE event to all connected clients. */
  private broadcastSSE(event: WorkerSSEEvent): void {
    for (const send of this.sseClients) {
      send(event);
    }
  }

  /** Start the worker server. Returns the address it's listening on. */
  async start(): Promise<string> {
    const address = await this.app.listen({ port: this.port, host: this.host });
    return address;
  }

  /** Stop the worker server and clean up. */
  async stop(): Promise<void> {
    if (this.agent) {
      this.agent.kill();
      this.agent = null;
    }
    // End all SSE connections so Fastify can close cleanly
    for (const raw of this.sseRawResponses) {
      try { raw.end(); } catch { /* already closed */ }
    }
    this.sseRawResponses.clear();
    this.sseClients.clear();
    await this.app.close();
  }

  /** Get the underlying Fastify instance (for testing). */
  getApp(): FastifyInstance { return this.app; }
}

// ---------------------------------------------------------------------------
// Standalone entry point (when run as a container process)
// ---------------------------------------------------------------------------

// Only auto-start when run directly (not when imported for testing)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  const { ClaudeProcess } = await import("./claude.js");
  const { ClaudeAdapter } = await import("./agents/claude-adapter.js");

  const worker = new SessionWorker({
    agentFactory: () => new ClaudeAdapter(new ClaudeProcess()),
    port: Number(process.env.WORKER_PORT) || 9100,
  });

  const address = await worker.start();
  console.log(`[session-worker] Listening on ${address}`);

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      console.log(`[session-worker] Received ${signal}, shutting down`);
      await worker.stop();
      process.exit(0);
    });
  }
}
