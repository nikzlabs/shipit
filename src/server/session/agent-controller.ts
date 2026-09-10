// Sub-agent spawns survive primary turns and interrupts; only their timeout or worker shutdown cancels them.

import type { FastifyInstance } from "fastify";
import type {
  AgentProcess,
  AgentEvent,
  AgentId,
} from "./agents/agent-process.js";
import type { PermissionMode, ServiceRouting, WorkerAgentKillBody, WorkerAgentStartBody, WorkerAgentStatus } from "../shared/types.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { WorkerSSEEvent } from "./sse-broadcaster.js";
import type { McpConfigController } from "./mcp-config-controller.js";
import { getErrorMessage } from "../shared/utils.js";
import { restoreFullResolutionScreenshots } from "./playwright-screenshot.js";
import {
  formatNodeRuntimeNotice,
  prefixPromptWithNotice,
  whenNodeRuntimeReady,
} from "./node-runtime.js";
import {
  runAgentToCompletion,
  buildSubAgentRunParams,
  type SubAgentRunHandle,
} from "../shared/sub-agent-run.js";

export type WorkerAgentFactory = (agentId: AgentId) => AgentProcess;

export interface AgentControllerDeps {
  agentFactory: WorkerAgentFactory;
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  permissionBroker: PermissionBroker;
  mcpConfig: McpConfigController;
  latestSseSeq: () => number;
  oldestSseSeq?: () => number;
  /** Include other work in the status snapshot used for container reclamation. */
  otherWorkerLiveness?: () => { terminalActive: boolean; installRunning: boolean };
}

export class AgentController {
  private agent: AgentProcess | null = null;

  private residentSpawn: { runToken?: string; streaming: boolean } | null = null;

  // Delivery identity belongs to the turn, not the resident process that can outlive it.
  private turnDeliveryId: string | undefined;

  private turnActive = false;
  private turnStartSseSeq = 0;

  private backgroundTaskCount = 0;
  private selfWakeActive = false;

  private readonly spawnedAgents = new Map<string, SubAgentRunHandle>();

  // Warn again after container recreation, which resolves the Node pin again.
  private nodeNoticeDelivered = false;

  constructor(private readonly deps: AgentControllerDeps) {}

  get currentAgentId(): AgentId | undefined {
    return this.agent?.agentId;
  }

  registerRoutes(app: FastifyInstance): void {
    app.post<{ Body: WorkerAgentStartBody }>("/agent/start", async (request, reply) => {
      if (this.agent) {
        return reply.code(409).send({ error: "Agent already running" });
      }

      const { agentId, params, runToken, deliveryId } = request.body;
      if (!agentId || !params) {
        return reply.code(400).send({ error: "agentId and params are required" });
      }

      const nodeRuntime = await whenNodeRuntimeReady();

      // Add the notice to the turn prompt so the cached system prompt stays byte-stable.
      const nodeNotice = this.nodeNoticeDelivered ? null : formatNodeRuntimeNotice(nodeRuntime);
      if (nodeNotice) this.nodeNoticeDelivered = true;

      try {
        // Capture turn identity and replay position before the adapter emits anything.
        this.beginTurn();
        this.turnDeliveryId = deliveryId;
        this.residentSpawn = { runToken, streaming: params.useStreaming === true };
        this.agent = this.deps.agentFactory(agentId);
        this.wireAgentEvents(this.agent, runToken);
        this.agent.setPermissionRequester?.((input) => this.deps.permissionBroker.request(input));
        const mcpWrite = this.deps.mcpConfig.invokeAgentMcpWriter(this.agent, params);

        this.withTemporaryEnv(mcpWrite.runtimeEnv ?? {}, () => {
          this.agent?.run({
            ...params,
            ...(nodeNotice ? { prompt: prefixPromptWithNotice(params.prompt, nodeNotice) } : {}),
            cwd: this.deps.workspaceDir,
            mcpConfigPath: mcpWrite.mcpConfigPath,
          });
        });

        if (mcpWrite.cleanup) {
          this.agent.on("done", mcpWrite.cleanup);
        }

        return { started: true };
      } catch (err) {
        this.agent = null;
        this.endTurn();
        return reply.code(500).send({ error: getErrorMessage(err) });
      }
    });

    app.post("/agent/interrupt", async (_request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.interrupt();
      return { interrupted: true };
    });

    app.post<{ Body: WorkerAgentKillBody | null }>("/agent/kill", async (request, reply) => {
      // A delayed kill must not target a replacement process. Missing tokens retain legacy behavior.
      const victimRunToken = request.body?.runToken;
      if (typeof victimRunToken === "string" && this.residentSpawn?.runToken !== victimRunToken) {
        console.warn(
          `[agent-kill] victim runToken=${victimRunToken} is not the resident spawn `
          + `(resident=${this.residentSpawn?.runToken ?? "none"}) — kill ignored`,
        );
        return { killed: false, staleVictim: true };
      }
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.kill();
      this.vacateSlot();
      return { killed: true };
    });

    app.post<{ Body: { agentId: AgentId; prompt: string; spawnId: string; depth?: number; model?: string; serviceRouting?: ServiceRouting; homeDir?: string; reasoningEffort?: string; timeoutMs?: number; maxOutputChars?: number } }>(
      "/agent/spawn",
      async (request, reply) => {
        const { agentId, prompt, spawnId, depth, model, serviceRouting, homeDir, reasoningEffort, timeoutMs, maxOutputChars } = request.body ?? {};
        if (!agentId || typeof prompt !== "string" || !spawnId) {
          console.warn("[sub-agent] worker rejected spawn: agentId, prompt, and spawnId are required");
          return reply.code(400).send({ error: "agentId, prompt, and spawnId are required" });
        }
        if (!model) {
          console.warn(`[sub-agent] worker rejected spawn=${spawnId}: no model named`);
          return reply.code(400).send({ error: "model is required — a spawn names the model it runs" });
        }
        let agent: AgentProcess;
        try {
          agent = this.deps.agentFactory(agentId);
        } catch (err) {
          console.warn(`[sub-agent] worker rejected spawn=${spawnId}: unknown agent ${agentId}`);
          return reply.code(400).send({ error: `Unknown agent: ${agentId} (${getErrorMessage(err)})` });
        }
        console.log(
          `[sub-agent] worker spawn=${spawnId} agent=${agentId} depth=${depth ?? 0} `
          + `promptBytes=${Buffer.byteLength(prompt)} model=${model ?? "default"} `
          + `effort=${reasoningEffort ?? "default"} home=${homeDir ?? "session"}`,
        );

        const runOpts = {
          prompt,
          cwd: this.deps.workspaceDir,
          ...(model !== undefined ? { model } : {}),
          ...(serviceRouting !== undefined ? { serviceRouting } : {}),
          ...(homeDir !== undefined ? { homeDir } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
        };
        const handle = runAgentToCompletion(agent, runOpts, Date.now());
        this.spawnedAgents.set(spawnId, handle);
        try {
          // The child captures this depth synchronously; the orchestrator uses it to reject recursion.
          const childDepth = String((depth ?? 0) + 1);
          this.withTemporaryEnv({ SHIPIT_AGENT_DEPTH: childDepth }, () => {
            agent.run(buildSubAgentRunParams(runOpts));
          });
          const result = await handle.promise;
          console.log(
            `[sub-agent] worker done spawn=${spawnId} status=${result.status} `
            + `durationMs=${result.durationMs} outputChars=${result.text.length} `
            + `truncated=${result.truncated}`,
          );
          return result;
        } catch (err) {
          console.warn(`[sub-agent] worker failed spawn=${spawnId}: ${getErrorMessage(err)}`);
          return await reply.code(500).send({ error: getErrorMessage(err) });
        } finally {
          this.spawnedAgents.delete(spawnId);
          try { agent.kill(); } catch { /* already exited */ }
        }
      },
    );

    app.post<{ Body: { data: string } }>("/agent/stdin", async (request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      const { data } = request.body;
      if (typeof data !== "string") {
        return reply.code(400).send({ error: "data must be a string" });
      }
      this.agent.writeStdin(data);
      return { written: true };
    });

    const ALLOWED_MODES = new Set(["plan", "guarded", "auto"]);
    app.post<{ Body: { mode: string | null } }>(
      "/agent/permission-mode",
      async (request, reply) => {
        if (!this.agent) {
          return reply.code(404).send({ error: "No agent running" });
        }
        if (!this.agent.setPermissionMode) {
          return reply.code(400).send({ error: "Agent does not support mid-stream permission-mode changes" });
        }
        const raw = request.body?.mode;
        let mode: PermissionMode | undefined;
        if (raw === null || raw === undefined) {
          mode = undefined;
        } else if (typeof raw === "string" && ALLOWED_MODES.has(raw)) {
          mode = raw as PermissionMode;
        } else {
          return reply.code(400).send({ error: `Invalid mode: ${JSON.stringify(raw)}` });
        }
        this.agent.setPermissionMode(mode);
        return { success: true };
      },
    );

    app.post<{ Body: { text: string } }>(
      "/agent/message",
      async (request, reply) => {
        const text = request.body?.text;
        const snippet = typeof text === "string" ? JSON.stringify(text.slice(0, 80)) : "<non-string>";
        if (!this.agent) {
          console.warn(`[steer-worker] /agent/message rejected: no agent running (text=${snippet})`);
          return reply.code(400).send({ error: "No agent running" });
        }
        if (typeof text !== "string" || !text) {
          console.warn(`[steer-worker] /agent/message rejected: text is required (got ${typeof text})`);
          return reply.code(400).send({ error: "text is required" });
        }
        console.log(
          `[steer-worker] /agent/message → agent.sendUserMessage (bytes=${text.length}, text=${snippet})`,
        );
        // Preserve the replay anchor when steering an active turn.
        if (!this.turnActive) this.beginTurn();
        this.agent.sendUserMessage(text);
        return { success: true };
      },
    );

    app.post<{ Body: { instructions?: string } }>("/agent/compact", async (request, reply) => {
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      if (!this.agent.compact) {
        return reply.code(400).send({ error: "Agent does not support compaction" });
      }
      const instructions = typeof request.body?.instructions === "string" ? request.body.instructions : undefined;
      this.agent.compact(instructions);
      return { success: true };
    });

    app.get("/agent/status", async (): Promise<WorkerAgentStatus> => ({
      running: this.agent !== null,
      latestSseSeq: this.deps.latestSseSeq(),
      oldestSseSeq: this.deps.oldestSseSeq?.() ?? 0,
      turnActive: this.turnActive,
      turnStartSseSeq: this.turnStartSseSeq,
      backgroundTaskCount: this.backgroundTaskCount,
      selfWakeActive: this.selfWakeActive,
      terminalActive: this.deps.otherWorkerLiveness?.().terminalActive ?? false,
      installRunning: this.deps.otherWorkerLiveness?.().installRunning ?? false,
      ...(this.residentSpawn?.runToken !== undefined ? { runToken: this.residentSpawn.runToken } : {}),
      ...(this.turnDeliveryId !== undefined ? { deliveryId: this.turnDeliveryId } : {}),
      ...(this.agent ? { agentId: this.agent.agentId } : {}),
      ...(this.residentSpawn
        ? { streaming: this.residentSpawn.streaming || this.agent?.isStreaming === true }
        : {}),
    }));
  }

  private beginTurn(): void {
    this.turnActive = true;
    this.turnStartSseSeq = this.deps.latestSseSeq();
  }

  // Clear process state here: late done events fail the identity guard after a kill.
  private vacateSlot(): void {
    this.agent = null;
    this.residentSpawn = null;
    this.endTurn();
    this.backgroundTaskCount = 0;
  }

  private endTurn(): void {
    this.turnActive = false;
    // Background tasks can outlive a turn; retain their count until the process ends.
    this.selfWakeActive = false;
    this.turnDeliveryId = undefined;
  }

  stop(): void {
    this.cancelAllSpawns();
    if (this.agent) {
      this.agent.kill();
      this.vacateSlot();
    }
  }

  private withTemporaryEnv<T>(values: Record<string, string>, fn: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  private cancelAllSpawns(): void {
    for (const [spawnId, handle] of this.spawnedAgents) {
      console.warn(`[sub-agent] worker cancelling spawn=${spawnId} (worker shutting down)`);
      try { handle.cancel(); } catch { /* best-effort */ }
    }
  }

  // Capture instance and token so late events cannot clear a replacement locally or across SSE.
  private wireAgentEvents(agent: AgentProcess, runToken?: string): void {
    agent.on("event", (event: AgentEvent) => {
      const forWire = restoreFullResolutionScreenshots(event);
      this.deps.broadcast({ type: "agent_event", data: { ...forWire, runToken } });
      if (this.agent !== agent) return;
      if (event.type === "agent_result") this.endTurn();
      else if (event.type === "agent_background_tasks") this.backgroundTaskCount = event.tasks.length;
      else if (event.type === "agent_self_wake") this.selfWakeActive = true;
    });

    agent.on("done", (exitCode: number) => {
      this.deps.permissionBroker.clearPending();
      this.deps.broadcast({ type: "agent_done", data: { exitCode, runToken } });
      if (this.agent === agent) this.vacateSlot();
    });

    agent.on("error", (err: Error) => {
      this.deps.permissionBroker.clearPending();
      this.deps.broadcast({ type: "agent_error", data: { message: err.message, runToken } });
      if (this.agent === agent) this.vacateSlot();
    });

    agent.on("auth_required", () => {
      this.deps.broadcast({ type: "agent_auth_required", data: { runToken } });
    });

    agent.on("log", (source: string, text: string) => {
      this.deps.broadcast({ type: "agent_log", data: { source, text } });
    });

    agent.on("mcp_status", (statuses) => {
      for (const status of statuses) {
        this.deps.broadcast({
          type: "mcp_server_status",
          data: status,
        });
      }
    });
  }
}
