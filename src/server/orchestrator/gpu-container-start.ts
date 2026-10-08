import type { EventEmitter } from "node:events";
import type { SessionContainer, SessionContainerManagerEvents } from "./session-container.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { emitNoticeInTurn, persistNoticeUnattached, type InProgressPersister } from "./chat-card-persistence.js";
import { getErrorMessage } from "./validation.js";

export interface GpuNoticeDeps {
  containerManager: EventEmitter<SessionContainerManagerEvents> & {
    get(sessionId: string): SessionContainer | undefined;
  };
  getRunner: (sessionId: string) => SessionRunnerInterface | undefined;
  chatHistory: InProgressPersister;
  sessionManager: { appendPendingAgentNotice(id: string, notice: string): void };
}

export function gpuUnavailableNotice(reason: string): string {
  return "⚠️ This session started without the GPU. GPU access is on, but Docker could not give the GPU "
    + `to this session's container: ${reason}\n\n`
    + "Code the agent runs, Compose services that declare a GPU, and containers the agent starts have no "
    + "GPU until this container starts again. Check the NVIDIA driver and Docker's GPU support on this "
    + "machine, or turn GPU access off in Settings → Advanced.";
}

export function gpuUnavailableAgentNotice(reason: string): string {
  return "[ShipIt] GPU access is on for this install, but this session's container started without the GPU, "
    + `because Docker could not give it: ${reason}. Code you run here has no GPU, and Compose services that `
    + "declare one start without it. The user has a notice about this in the transcript. When the task needs "
    + "the GPU, tell the user; it is a fix on the host, not in this container.";
}

/**
 * docs/325-session-gpu-access req 6: tell the user and the agent once per session and reason, so a
 * container recreated after an idle reclaim does not repeat a notice the user already has.
 */
export function announceGpuOnContainerStart(deps: GpuNoticeDeps): void {
  const announced = new Map<string, string>();
  deps.containerManager.on("container_started", (sessionId) => {
    const gpu = deps.containerManager.get(sessionId)?.gpu;
    if (gpu?.state !== "unavailable") {
      announced.delete(sessionId);
      return;
    }
    if (announced.get(sessionId) === gpu.reason) return;
    announced.set(sessionId, gpu.reason);
    // Separate: one failed write must not lose the other.
    try {
      const runner = deps.getRunner(sessionId);
      const message = gpuUnavailableNotice(gpu.reason);
      if (runner) emitNoticeInTurn(runner, sessionId, message, deps.chatHistory, "warn");
      else persistNoticeUnattached(deps.chatHistory, sessionId, message, "warn");
    } catch (err) {
      console.warn(`[gpu] transcript notice failed for ${sessionId}:`, getErrorMessage(err));
    }
    try {
      deps.sessionManager.appendPendingAgentNotice(sessionId, gpuUnavailableAgentNotice(gpu.reason));
    } catch (err) {
      console.warn(`[gpu] agent notice failed for ${sessionId}:`, getErrorMessage(err));
    }
  });
}
