/**
 * ProxyAgentProcess — bridges worker events to the AgentProcess interface.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, AgentMcpWriteContext, AgentMcpWriteResult, AgentRunParams, PermissionMode } from "../shared/types.js";
import { WorkerTimeoutError } from "./worker-http.js";

/**
 * Translate a worker HTTP failure into a user-facing chat error message.
 * `WorkerTimeoutError` ("Worker request timed out after 10000ms: /agent/stdin")
 * carries no actionable hint — wrap it in copy that points the user at the
 * recovery affordances (Rescue session, Kill agent) instead. Note that
 * `/agent/start` itself is unbounded (see `_startAgentViaProxy`) — SSE owns
 * worker-liveness signalling — so the "start" branch below is reached only
 * for non-timeout transport errors.
 *
 * See docs/124-session-rescue-and-diagnostics §1.3.
 */
function describeWorkerError(err: unknown, op: "start" | "stdin" | "interrupt"): Error {
  if (err instanceof WorkerTimeoutError) {
    const hint = op === "start"
      ? "The agent container is not responding. Try Rescue session if this persists."
      : op === "interrupt"
        ? "Interrupt request timed out. Try Kill agent."
        : "Failed to send input — the agent container is not responding.";
    const wrapped = new Error(hint);
    wrapped.cause = err;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Interface for the subset of ContainerSessionRunner methods that
 * ProxyAgentProcess needs. Avoids a circular import dependency.
 */
export interface ProxyAgentRunner {
  _startAgentViaProxy(agentId: AgentId, params: AgentRunParams): Promise<void>;
  writeAgentStdin(data: string): Promise<void>;
  sendAgentMessage(text: string): Promise<void>;
  interruptAgentOnWorker(): Promise<void>;
  killAgentOnWorker(): Promise<void>;
}

/**
 * A proxy AgentProcess that doesn't own a real process — it represents
 * the agent running inside the worker. Events are pushed in by the
 * ContainerSessionRunner's SSE listener. Methods delegate to the worker
 * via HTTP through the parent ContainerSessionRunner.
 */
export class ProxyAgentProcess extends EventEmitter<{
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
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    // Conservative default — the proxy doesn't know its target's capabilities
    // here; the orchestrator publishes the real flag via the agent registry,
    // which is what the client uses to gate the AI review affordance.
    supportsReview: false,
    supportsSteering: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  private runner: ProxyAgentRunner;

  constructor(agentId: AgentId, runner: ProxyAgentRunner) {
    super();
    this.agentId = agentId;
    this.runner = runner;
  }

  /** Fire-and-forget POST to worker /agent/start. Errors emitted as events. */
  run(params: AgentRunParams): void {
    this.runner._startAgentViaProxy(this.agentId, params).catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "start"));
    });
  }

  /** Fire-and-forget POST to worker /agent/stdin. */
  writeStdin(data: string): void {
    this.runner.writeAgentStdin(data).catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "stdin"));
    });
  }

  readonly isStreaming = false;

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    // Delegate to worker /agent/message so the real streaming logic inside
    // the session container handles the injection (docs/140).
    this.runner.sendAgentMessage(text).catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "stdin"));
    });
  }

  /** Fire-and-forget POST to worker /agent/interrupt. */
  interrupt(): void {
    this.runner.interruptAgentOnWorker().catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "interrupt"));
    });
  }

  /**
   * Fire-and-forget POST to worker /agent/kill. Surfaces failures via the
   * `log` event (Logs panel) rather than `error` because:
   *   - the agent may legitimately already be dead (benign race), and an
   *     `error` event would clear runner state + dump a chat error;
   *   - on a wedged worker, the user clicking Interrupt or Rescue session
   *     deserves *some* feedback that the kill failed, not silence.
   * The Logs panel is the right surface — visible, badged, but
   * non-disruptive. See docs/124-session-rescue-and-diagnostics §1.4.
   */
  kill(): void {
    this.runner.killAgentOnWorker().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", "server", `Failed to kill agent on worker: ${msg}`);
    });
  }

  /**
   * MCP-config writing happens inside the worker container, on the real
   * Claude/Codex adapter the worker constructs there — not on this
   * orchestrator-side proxy. The worker calls `agent.writeMcpConfig(...)`
   * unconditionally before spawn (see `session-worker.ts` /agent/start).
   * Reaching this method on the proxy means the worker delegated MCP
   * writing to the orchestrator, which is the wrong direction and would
   * skip per-turn JSON / config.toml regeneration — fail loudly.
   */
  writeMcpConfig(_ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    throw new Error("writeMcpConfig is not supported on ProxyAgentProcess — the worker writes its own MCP config before spawning the in-container adapter");
  }
}
