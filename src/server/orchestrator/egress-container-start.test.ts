import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { announceEgressOnContainerStart } from "./egress-container-start.js";
import type { SessionContainerManagerEvents } from "./session-container.js";

describe("announceEgressOnContainerStart", () => {
  it("tells clients to re-read the session's network mode when its container starts", () => {
    const emitter = new EventEmitter<SessionContainerManagerEvents>();
    const sseBroadcast = vi.fn();
    announceEgressOnContainerStart(emitter, sseBroadcast);

    emitter.emit("container_started", "s1");

    expect(sseBroadcast).toHaveBeenCalledWith("session_egress_changed", { sessionId: "s1" });
  });

  it("does not announce on other container events", () => {
    const emitter = new EventEmitter<SessionContainerManagerEvents>();
    const sseBroadcast = vi.fn();
    announceEgressOnContainerStart(emitter, sseBroadcast);

    emitter.emit("container_destroyed", "s1", false);
    emitter.emit("container_exited", "s1", 1);

    expect(sseBroadcast).not.toHaveBeenCalled();
  });
});
