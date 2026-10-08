import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { SessionContainer, SessionContainerManagerEvents } from "./session-container.js";
import type { SessionGpu } from "./session-gpu.js";
import type { PersistedMessage } from "./chat-history.js";
import { announceGpuOnContainerStart } from "./gpu-container-start.js";

/** docs/325-session-gpu-access req 6: the user and the agent hear why, once. */

function setup() {
  const containers = new Map<string, Pick<SessionContainer, "gpu">>();
  const manager = Object.assign(new EventEmitter<SessionContainerManagerEvents>(), {
    get: (sessionId: string) => containers.get(sessionId) as SessionContainer | undefined,
  });
  const transcript: { sessionId: string; message: PersistedMessage }[] = [];
  const agentNotices: { id: string; notice: string }[] = [];
  announceGpuOnContainerStart({
    containerManager: manager,
    getRunner: () => undefined,
    chatHistory: {
      append: (sessionId, message) => { transcript.push({ sessionId, message }); },
      replaceInProgress: () => {},
    },
    sessionManager: { appendPendingAgentNotice: (id, notice) => { agentNotices.push({ id, notice }); } },
  });
  const start = (sessionId: string, gpu: SessionGpu) => {
    containers.set(sessionId, { gpu });
    manager.emit("container_started", sessionId);
  };
  return { start, transcript, agentNotices };
}

describe("announceGpuOnContainerStart", () => {
  it("says nothing when the session got the GPU, or never asked", () => {
    const { start, transcript, agentNotices } = setup();
    start("a", { state: "granted" });
    start("b", { state: "off" });

    expect(transcript).toEqual([]);
    expect(agentNotices).toEqual([]);
  });

  it("tells the user and the agent why the session has no GPU", () => {
    const { start, transcript, agentNotices } = setup();
    start("a", { state: "unavailable", reason: "could not select device driver" });

    expect(transcript).toHaveLength(1);
    expect(transcript[0].message).toMatchObject({ notice: true, noticeLevel: "warn" });
    expect(transcript[0].message.text).toContain("could not select device driver");
    expect(agentNotices).toHaveLength(1);
    expect(agentNotices[0].notice).toMatch(/^\[ShipIt\] .*could not select device driver/);
  });

  it("does not repeat itself when the container is created again for the same reason", () => {
    const { start, transcript } = setup();
    start("a", { state: "unavailable", reason: "no driver" });
    start("a", { state: "unavailable", reason: "no driver" });
    expect(transcript).toHaveLength(1);

    start("a", { state: "unavailable", reason: "runtime runsc has no nvproxy" });
    expect(transcript).toHaveLength(2);

    start("a", { state: "granted" });
    start("a", { state: "unavailable", reason: "no driver" });
    expect(transcript).toHaveLength(3);
  });
});
