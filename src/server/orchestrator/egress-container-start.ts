import type { EventEmitter } from "node:events";
import type { SessionContainerManagerEvents } from "./session-container.js";

/**
 * A container start fixes the network mode a session runs with, and that is what
 * `EgressSessionSettings.pendingRestart` compares against. So every start, by any
 * path, tells clients to re-read — otherwise a "pending" chip outlives the restart
 * that applied it.
 */
export function announceEgressOnContainerStart(
  containerManager: EventEmitter<SessionContainerManagerEvents>,
  sseBroadcast: (event: string, data: unknown) => void,
): void {
  containerManager.on("container_started", (sessionId) => {
    sseBroadcast("session_egress_changed", { sessionId });
  });
}
