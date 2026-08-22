/**
 * Agent controller — owns the worker's single resident agent slot and the
 * in-flight sub-agent registry, and registers the `/agent/*` endpoints
 * (start, interrupt, kill, spawn, cancel, stdin, permission-mode, message,
 * compact, status).
 *
 * The single-occupant `this.agent` slot is the primary turn; sub-agent spawns
 * (docs/144) run OUTSIDE it as plain subprocesses keyed by spawnId. Agent
 * events are wired to the SSE stream here so the orchestrator sees them.
 */

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

/** Factory function that creates an AgentProcess from an agent ID. */
export type WorkerAgentFactory = (agentId: AgentId) => AgentProcess;

export interface AgentControllerDeps {
  agentFactory: WorkerAgentFactory;
  workspaceDir: string;
  broadcast: (event: WorkerSSEEvent) => void;
  permissionBroker: PermissionBroker;
  mcpConfig: McpConfigController;
  /** Reports the latest SSE sequence for `/agent/status`. */
  latestSseSeq: () => number;
  /**
   * docs/240 — reports the OLDEST sequence still in the SSE replay buffer.
   * `/agent/status` publishes it so an orchestrator adopting a turn that was
   * in flight across its restart can tell whether the buffer still covers the
   * whole turn (complete replay) or only its tail (partial). Optional so
   * existing constructions without the getter keep working.
   */
  oldestSseSeq?: () => number;
}

export class AgentController {
  private agent: AgentProcess | null = null;

  /**
   * docs/240 — metadata about the spawn occupying the slot, published via
   * `/agent/status` so an orchestrator that restarted mid-turn can re-create a
   * proxy with the SAME run token (keeping `isStaleSpawnEvent` correlation
   * intact) and in the right streaming mode.
   */
  private residentSpawn: { runToken?: string; streaming: boolean } | null = null;

  /**
   * planning#266 — the durable DELIVERY id of the turn currently in flight, when the
   * orchestrator dispatched it on behalf of a server-side delivery (a
   * notify-on-merge wake). Published via `/agent/status` so a restarted
   * orchestrator can re-identify the delivery and rebind its completion
   * settlement onto the adopted turn instead of dispatching a duplicate.
   *
   * Deliberately keyed to the TURN, not the spawn: a resident streaming process
   * outlives its turn, so a delivery held on `residentSpawn` would keep reading
   * as live after the turn ended (suppressing a legitimate redispatch forever)
   * and would leak onto the NEXT turn that `/agent/message` starts on the same
   * process. Cleared by {@link endTurn}.
   */
  private turnDeliveryId: string | undefined;

  /**
   * docs/240 — whether a turn is genuinely in flight on the resident process.
   * Set when a turn starts (`/agent/start`, or `/agent/message` into an idle
   * resident streaming process); cleared on `agent_result` and on process exit.
   */
  private turnActive = false;
  private turnStartSseSeq = 0;

  // docs/144 — in-flight sub-agent spawns, keyed by orchestrator-supplied
  // spawnId. These run OUTSIDE the single-occupant `this.agent` slot as plain
  // subprocesses and never broadcast to SSE; their output is returned
  // synchronously over the `/agent/spawn` HTTP response. Tracked so an explicit
  // `/agent/cancel` (or a primary-turn interrupt/kill) can SIGTERM them.
  private readonly spawnedAgents = new Map<string, SubAgentRunHandle>();

  /**
   * docs/248-repo-node-version req 8 — whether the "your Node pin isn't being honored" note has
   * already ridden a turn's prompt.
   *
   * Scoped to this controller, i.e. to the container: the pin is resolved once
   * at worker boot, so "the first turn" means the first turn *since that
   * resolution*, not the first of the session. A long-lived session whose
   * container is recreated re-resolves the pin and tells the agent again —
   * which is right, because the answer may have changed and the new agent
   * process never saw the old note.
   */
  private nodeNoticeDelivered = false;

  constructor(private readonly deps: AgentControllerDeps) {}

  /** The resident agent's id, if any — read by the permission endpoints. */
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

      // docs/248 — everything the agent runs (its bash tool, its builds, its
      // test runs) inherits this worker's PATH, so the pinned Node has to be on
      // it before the CLI spawns. Awaited outside the try: a provisioning
      // failure is already folded into a reported status and never throws.
      const nodeRuntime = await whenNodeRuntimeReady();

      // req 8 — and when the pin could NOT be honored, say so on the first turn
      // rather than leaving the agent to debug against a runtime it believes is
      // the project's. Rides the prompt, not the system prompt: the latter is
      // precomputed per (agentId, isOps) and must stay byte-stable for the
      // prompt cache. Silent for every session whose pin is honored or absent.
      const nodeNotice = this.nodeNoticeDelivered ? null : formatNodeRuntimeNotice(nodeRuntime);
      if (nodeNotice) this.nodeNoticeDelivered = true;

      try {
        // docs/240 — mark the turn in flight BEFORE the adapter can emit
        // anything, and record the seq the turn starts at. A restarted
        // orchestrator replays from exactly here, so the live turn's events are
        // re-delivered while the previous (already-persisted) turn's are not.
        this.beginTurn();
        // planning#266 — stamp the delivery AFTER `beginTurn` (which clears nothing,
        // but keeps the "turn identity is established first" reading) and
        // before anything can be emitted.
        this.turnDeliveryId = deliveryId;
        this.residentSpawn = { runToken, streaming: params.useStreaming === true };
        // docs/155 hair 10 — each adapter knows its own MCP wire format
        // (Claude: per-turn `--mcp-config` JSON; Codex: `config.toml` block;
        // Cursor: `mcp.json`). The worker hands over the cross-cutting
        // context (user-configured servers, review-bridge paths, SSE
        // failure channel) and consumes a uniform { mcpConfigPath?,
        // runtimeEnv?, cleanup? } result.
        this.agent = this.deps.agentFactory(agentId);
        this.wireAgentEvents(this.agent, runToken);
        // docs/193 — give an adapter with a native blocking approval channel
        // (Codex) the broker so its escalation requests surface the same
        // approve/deny card as Claude's sensitive-file gate, rather than being
        // silently auto-approved. Claude has no such channel here — its gate is
        // bridged via `--permission-prompt-tool` (the `shipit` bridge's permission tool).
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
      // docs/144 — interrupting the primary turn cancels any sub-agent running
      // on its behalf (symmetric cancel). Do this even when `this.agent` is null
      // (a sub-agent can outlive a transient primary-slot gap).
      this.cancelAllSpawns();
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.interrupt();
      return { interrupted: true };
    });

    app.post<{ Body: WorkerAgentKillBody | null }>("/agent/kill", async (request, reply) => {
      // Identity-guarded kill (prod incident 2026-08-09, session 468191f5): the
      // orchestrator's kill is fire-and-forget and can execute here long after
      // it was issued. planning#290 guarded the ORCHESTRATOR-side slot clear, but
      // the request itself carried no victim identity, so a late-executing kill
      // SIGTERMed whichever process was resident at execution time — including
      // a newer live one mid-turn (whose in-flight turn then died silently).
      // When the caller names its victim, refuse to kill anyone else. A body
      // without `runToken` (legacy caller / recovery paths that intentionally
      // clear whatever is resident) keeps the unconditional behavior. The
      // mismatch path deliberately does NOT `cancelAllSpawns()` either — the
      // resident (newer) primary's sub-agents are not the victim's.
      const victimRunToken = request.body?.runToken;
      if (typeof victimRunToken === "string" && this.residentSpawn?.runToken !== victimRunToken) {
        console.warn(
          `[agent-kill] victim runToken=${victimRunToken} is not the resident spawn `
          + `(resident=${this.residentSpawn?.runToken ?? "none"}) — kill ignored`,
        );
        return { killed: false, staleVictim: true };
      }
      this.cancelAllSpawns();
      if (!this.agent) {
        return reply.code(404).send({ error: "No agent running" });
      }
      this.agent.kill();
      this.agent = null;
      this.residentSpawn = null;
      this.endTurn();
      return { killed: true };
    });

    // docs/144 — spawn a one-shot SUB-AGENT subprocess. This is a NEW code path,
    // not a reuse of `/agent/start`: it instantiates a fresh per-agent adapter
    // OUTSIDE the single-occupant slot (`this.agent` is untouched), wires its
    // events into a local result accumulator instead of the broadcast SSE, and
    // returns the accumulated final assistant text synchronously. The
    // orchestrator (`services/sub-agent.ts`) owns authorization, credentials,
    // and the per-turn cap; the worker just runs the adapter. Two CLI processes
    // are alive during the spawn window (the primary, blocked on the caller's
    // `shipit agent` shell call, and this sub-agent).
    app.post<{ Body: { agentId: AgentId; prompt: string; spawnId: string; depth?: number; model?: string; serviceRouting?: ServiceRouting; homeDir?: string; reasoningEffort?: string; timeoutMs?: number; maxOutputChars?: number } }>(
      "/agent/spawn",
      async (request, reply) => {
        const { agentId, prompt, spawnId, depth, model, serviceRouting, homeDir, reasoningEffort, timeoutMs, maxOutputChars } = request.body ?? {};
        if (!agentId || typeof prompt !== "string" || !spawnId) {
          console.warn("[sub-agent] worker rejected spawn: agentId, prompt, and spawnId are required");
          return reply.code(400).send({ error: "agentId, prompt, and spawnId are required" });
        }
        // docs/261 req 7 — a spawn that names no model is REFUSED, not run on
        // whatever the CLI would pick. The orchestrator already refuses an
        // incomplete call at its own edge; this is the same rule at the boundary
        // where the blank would actually be filled, so a propagation slip
        // between the two fails loudly instead of quietly reinstating the
        // per-harness default this feature deleted.
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
        // planning#280 — this whole path used to be silent, so a consult that never
        // produced an artifact left nothing in the worker logs either.
        console.log(
          `[sub-agent] worker spawn=${spawnId} agent=${agentId} depth=${depth ?? 0} `
          + `promptBytes=${Buffer.byteLength(prompt)} model=${model ?? "default"} `
          + `effort=${reasoningEffort ?? "default"} home=${homeDir ?? "session"}`,
        );

        const runOpts = {
          prompt,
          cwd: this.deps.workspaceDir,
          ...(model !== undefined ? { model } : {}),
          // docs/252 phase 3 — a consult runs on its own selection, so it needs
          // the same base-URL/credential shaping a primary turn gets.
          ...(serviceRouting !== undefined ? { serviceRouting } : {}),
          // A same-harness spawn's isolated per-spawn HOME (container path) —
          // keeps its credentials off the subtree the live primary CLI reads.
          ...(homeDir !== undefined ? { homeDir } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
        };
        const handle = runAgentToCompletion(agent, runOpts, Date.now());
        this.spawnedAgents.set(spawnId, handle);
        try {
          // Stamp SHIPIT_AGENT_DEPTH = caller depth + 1 on the subprocess env so
          // the sub-agent's own `shipit agent` calls forward a non-zero depth and
          // are rejected by the orchestrator's recursion guard. withTemporaryEnv
          // restores process.env after the synchronous spawn; the child has
          // already captured the value.
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

    // docs/144 — explicitly cancel an in-flight sub-agent spawn by id.
    app.post<{ Body: { spawnId?: string } }>("/agent/cancel", async (request, reply) => {
      const spawnId = request.body?.spawnId;
      if (!spawnId) {
        return reply.code(400).send({ error: "spawnId is required" });
      }
      const handle = this.spawnedAgents.get(spawnId);
      if (!handle) {
        return reply.code(404).send({ error: "No such spawn" });
      }
      handle.cancel();
      return { cancelled: true };
    });

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

    // POST /agent/permission-mode — change the resident agent's permission
    // mode mid-stream without a restart. The adapter pushes a
    // `set_permission_mode` control_request onto the streaming CLI's stdin;
    // adapters that don't support mid-stream switching (one-shot) no-op.
    // See docs/138 / docs/140 for the protocol details. `mode: null` is the
    // wire encoding for ShipIt "auto" (no flag), so the JSON body always
    // travels as a string-or-null.
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

    // POST /agent/message — inject a user message (live steering, docs/140)
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
        // docs/140 diag — confirm the worker accepted and forwarded to the
        // adapter. The adapter (`[claude-adapter]`) and CLI-stdin
        // (`[streaming-claude]`) logs follow.
        console.log(
          `[steer-worker] /agent/message → agent.sendUserMessage (bytes=${text.length}, text=${snippet})`,
        );
        // docs/240 — a message into an IDLE resident streaming process starts a
        // new turn (this is how every turn after the first runs under live
        // steering), so it must mark the turn in flight and anchor the replay
        // cursor. A message into a turn already in flight is a mid-turn steer:
        // leave the existing anchor alone so the whole turn stays replayable.
        if (!this.turnActive) this.beginTurn();
        this.agent.sendUserMessage(text);
        return { success: true };
      },
    );

    // POST /agent/compact — trigger a context compaction on the resident agent
    // (docs/178). Claude (streaming) injects the `/compact` slash command; Codex
    // (live thread) sends the `thread/compact/start` RPC. Adapters that don't
    // implement compact(), or have no resident process to talk to, no-op — the
    // orchestrator handles the non-resident case by spawning a `/compact` turn.
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
      ...(this.residentSpawn?.runToken !== undefined ? { runToken: this.residentSpawn.runToken } : {}),
      ...(this.turnDeliveryId !== undefined ? { deliveryId: this.turnDeliveryId } : {}),
      ...(this.agent ? { agentId: this.agent.agentId } : {}),
      ...(this.residentSpawn
        ? { streaming: this.residentSpawn.streaming || this.agent?.isStreaming === true }
        : {}),
    }));
  }

  /**
   * docs/240 — mark a turn as in flight and anchor the SSE replay cursor at the
   * seq the turn starts from. Called before anything the turn emits, so a
   * restarted orchestrator replaying from `turnStartSseSeq` sees the whole turn
   * and none of the previous (already-persisted) one.
   */
  private beginTurn(): void {
    this.turnActive = true;
    this.turnStartSseSeq = this.deps.latestSseSeq();
  }

  /** docs/240 — the turn ended (result, process exit, or kill). */
  private endTurn(): void {
    this.turnActive = false;
    // planning#266 — the delivery belongs to the turn that just ended; a later
    // `/agent/status` must not report it as still live.
    this.turnDeliveryId = undefined;
  }

  /** Kill the resident agent and cancel all sub-agent spawns (worker shutdown). */
  stop(): void {
    this.cancelAllSpawns();
    if (this.agent) {
      this.agent.kill();
      this.agent = null;
      this.residentSpawn = null;
      this.endTurn();
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

  /** docs/144 — SIGTERM every in-flight sub-agent spawn (symmetric cancel). */
  private cancelAllSpawns(): void {
    for (const [spawnId, handle] of this.spawnedAgents) {
      console.warn(`[sub-agent] worker cancelling spawn=${spawnId} (primary interrupt/kill)`);
      try { handle.cancel(); } catch { /* best-effort */ }
    }
  }

  /**
   * Wire agent events to the SSE stream.
   *
   * `runToken` is the orchestrator's per-SPAWN correlation token (see
   * `ProxyAgentProcess.runToken`). It is captured in the done/error/
   * auth_required closures and stamped onto those SSE events so the
   * orchestrator can tell a stale exit from a previous spawn apart from the
   * current one and refuse to null the live `_agent` slot. Undefined for
   * callers that don't supply one (legacy / direct test starts) — the
   * orchestrator then falls back to its object-identity guards.
   */
  private wireAgentEvents(agent: AgentProcess, runToken?: string): void {
    agent.on("event", (event: AgentEvent) => {
      // A Playwright screenshot arrives shrunk to fit the model's token budget;
      // the full-resolution capture is on disk beside it. Swap it in here, on
      // the one path every backend's events pass through, so what ShipIt
      // persists and renders is the sharp one. The model's copy is already
      // delivered and is not affected. See `playwright-screenshot.ts`.
      const forWire = restoreFullResolutionScreenshots(event);
      // planning#290 — the event channel carries the spawn token too. It used to be
      // the only channel that didn't, so a retired process's late `agent_result`
      // (the canonical turn-ended signal) was routed into whatever proxy held
      // the orchestrator's slot, settling a turn that had just started. The
      // orchestrator strips the token back off before handing the event to the
      // proxy, so `AgentEvent` consumers never see it.
      this.deps.broadcast({ type: "agent_event", data: { ...forWire, runToken } });
      // docs/240 — `agent_result` is the canonical turn-ended signal (the same
      // one the orchestrator keys its post-turn flow off). A resident streaming
      // process stays in the slot afterwards, so `running` alone can't tell an
      // in-flight turn from an idle-resident one — this can.
      if (event.type === "agent_result" && this.agent === agent) this.endTurn();
    });

    // Capture `agent` in the closure so the done/error handlers compare against
    // the specific instance they were wired to. Without this guard, a late
    // `done` from an OLD streaming process (killed by /agent/kill during the
    // 409-retry dance in container-session-runner.ts) would null out the
    // freshly-spawned NEW agent that already replaced `this.agent`, stranding
    // the worker with no agent reference while the new CLI keeps running.
    //
    // The captured `runToken` is the orchestrator-side correlation for the SAME
    // purpose across the SSE boundary: the orchestrator can't compare process
    // identity, so it compares this token (see container-session-runner.ts
    // `isStaleSpawnEvent`).
    agent.on("done", (exitCode: number) => {
      // docs/193 — the backend process is gone; settle any held permission
      // promise internally so the worker doesn't leak. This broadcasts nothing,
      // so an unanswered card stays `pending` (no synthetic "expired" — ShipIt
      // imposes no deadline on the user's decision).
      this.deps.permissionBroker.clearPending();
      this.deps.broadcast({ type: "agent_done", data: { exitCode, runToken } });
      if (this.agent === agent) {
        this.agent = null;
        this.residentSpawn = null;
        this.endTurn();
      }
    });

    agent.on("error", (err: Error) => {
      this.deps.permissionBroker.clearPending();
      this.deps.broadcast({ type: "agent_error", data: { message: err.message, runToken } });
      if (this.agent === agent) {
        this.agent = null;
        this.residentSpawn = null;
        this.endTurn();
      }
    });

    agent.on("auth_required", () => {
      this.deps.broadcast({ type: "agent_auth_required", data: { runToken } });
    });

    agent.on("log", (source: string, text: string) => {
      this.deps.broadcast({ type: "agent_log", data: { source, text } });
    });

    // docs/088: per-MCP-server liveness reported by the CLI (Claude's init
    // event populates this; Codex never emits). One SSE event per server so
    // the orchestrator's relay (container-session-runner.ts) doesn't need to
    // unpack arrays.
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
