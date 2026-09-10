import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentProcess, AgentId, AgentEvent, AgentMcpWriteContext, AgentMcpWriteResult, AgentRunParams, PermissionMode, PermissionDecision } from "../shared/types.js";
import { WorkerTimeoutError } from "./worker-http.js";

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

export interface ProxyAgentRunner {
  _startAgentViaProxy(agentId: AgentId, params: AgentRunParams, runToken?: string, deliveryId?: string): Promise<void>;
  writeAgentStdin(data: string): Promise<void>;
  sendAgentMessage(text: string): Promise<void>;
  interruptAgentOnWorker(): Promise<void>;
  killAgentOnWorker(opts?: { victimRunToken?: string }): Promise<void>;
  setAgentPermissionModeOnWorker(mode: PermissionMode | undefined): Promise<void>;
  compactAgentOnWorker(instructions?: string): Promise<void>;
  resolvePermissionOnWorker(requestId: string, decision: PermissionDecision): Promise<void>;
}

export class ProxyAgentProcess extends EventEmitter<{
  event: [AgentEvent];
  done: [exitCode: number];
  error: [Error];
  auth_required: [];
  log: [source: string, text: string];
  superseded: [];
}> implements AgentProcess {
  readonly agentId: AgentId;
  /** Correlates spawn events to reject stale exits. Inherit it when adopting a running worker. */
  readonly runToken: string;
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    // The agent registry publishes the target's actual capabilities.
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  /** Durable work identity, distinct from the spawn's runToken. */
  deliveryId: string | undefined;

  private runner: ProxyAgentRunner;

  constructor(agentId: AgentId, runner: ProxyAgentRunner, opts?: { runToken?: string; deliveryId?: string }) {
    super();
    this.agentId = agentId;
    this.runner = runner;
    this.runToken = opts?.runToken ?? randomUUID();
    this.deliveryId = opts?.deliveryId;
  }

  setDeliveryId(deliveryId: string): void {
    this.deliveryId = deliveryId;
  }

  run(params: AgentRunParams): void {
    this.runner._startAgentViaProxy(this.agentId, params, this.runToken, this.deliveryId).catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "start"));
    });
  }

  writeStdin(data: string): void {
    this.runner.writeAgentStdin(data).catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "stdin"));
    });
  }

  readonly isStreaming = false;

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    console.log(
      `[steer-proxy] agentId=${this.agentId} → /agent/message (bytes=${text.length}, text=${JSON.stringify(text.slice(0, 80))})`,
    );
    void this._sendAgentMessageWithLogging(text);
  }

  private async _sendAgentMessageWithLogging(text: string): Promise<void> {
    try {
      await this.runner.sendAgentMessage(text);
      console.log(`[steer-proxy] /agent/message accepted (agentId=${this.agentId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[steer-proxy] /agent/message FAILED (agentId=${this.agentId}): ${msg}`);
      this.emit("error", describeWorkerError(err, "stdin"));
    }
  }

  interrupt(): void {
    this.runner.interruptAgentOnWorker().catch((err: unknown) => {
      this.emit("error", describeWorkerError(err, "interrupt"));
    });
  }

  // Log control failures; emitting error would end the active turn.
  setPermissionMode(mode: PermissionMode | undefined): void {
    this.runner.setAgentPermissionModeOnWorker(mode).catch((err: unknown) => {
      const msgText = err instanceof Error ? err.message : String(err);
      this.emit("log", "server", `Failed to change permission mode on worker: ${msgText}`);
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    this.runner.resolvePermissionOnWorker(requestId, decision).catch((err: unknown) => {
      const msgText = err instanceof Error ? err.message : String(err);
      this.emit("log", "server", `Failed to resolve permission on worker: ${msgText}`);
    });
  }

  compact(instructions?: string): void {
    this.runner.compactAgentOnWorker(instructions).catch((err: unknown) => {
      const msgText = err instanceof Error ? err.message : String(err);
      this.emit("log", "server", `Failed to compact agent on worker: ${msgText}`);
    });
  }

  // Target this spawn so a delayed kill cannot terminate its replacement.
  kill(): void {
    this.runner.killAgentOnWorker({ victimRunToken: this.runToken }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", "server", `Failed to kill agent on worker: ${msg}`);
    });
  }

  writeMcpConfig(_ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    throw new Error("writeMcpConfig is not supported on ProxyAgentProcess — the worker writes its own MCP config before spawning the in-container adapter");
  }
}
