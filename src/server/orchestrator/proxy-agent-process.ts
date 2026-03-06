/**
 * ProxyAgentProcess — bridges worker events to the AgentProcess interface.
 * Extracted from container-session-runner.ts for single-responsibility.
 */

import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent, AgentRunParams, PermissionMode } from "../shared/types.js";

/**
 * Interface for the subset of ContainerSessionRunner methods that
 * ProxyAgentProcess needs. Avoids a circular import dependency.
 */
export interface ProxyAgentRunner {
  _startAgentViaProxy(agentId: AgentId, params: AgentRunParams): Promise<void>;
  writeAgentStdin(data: string): Promise<void>;
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
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Fire-and-forget POST to worker /agent/stdin. */
  writeStdin(data: string): void {
    this.runner.writeAgentStdin(data).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Fire-and-forget POST to worker /agent/interrupt. */
  interrupt(): void {
    this.runner.interruptAgentOnWorker().catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  /** Fire-and-forget POST to worker /agent/kill. */
  kill(): void {
    this.runner.killAgentOnWorker().catch(() => {
      // Swallow kill errors — the agent may already be dead
    });
  }
}
