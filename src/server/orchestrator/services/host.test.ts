/**
 * docs/128 — unit tests for getHostOverview (Host tab data source).
 */

import { describe, it, expect } from "vitest";
import type Docker from "dockerode";
import { getHostOverview } from "./host.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { CONTAINER_SESSION_ID_LABEL } from "../session-container.js";

function fakeSessionManager(titles: Record<string, string>): SessionManager {
  return {
    get: (id: string) => (titles[id] ? { id, title: titles[id] } : undefined),
  } as unknown as SessionManager;
}

function fakeRunnerRegistry(running: Record<string, boolean>): SessionRunnerRegistry {
  return {
    get: (id: string) => (id in running ? { running: running[id] } : undefined),
  } as unknown as SessionRunnerRegistry;
}

function fakeDocker(containers: Docker.ContainerInfo[]): Docker {
  return {
    listContainers: async () => containers,
  } as unknown as Docker;
}

function containerInfo(over: Partial<Docker.ContainerInfo>): Docker.ContainerInfo {
  return {
    Id: "abcdef0123456789",
    Names: ["/shipit-session-x"],
    Image: "shipit-worker:latest",
    State: "running",
    Status: "Up 2 minutes",
    Created: 1_700_000_000,
    Labels: {},
    ...over,
  } as Docker.ContainerInfo;
}

describe("getHostOverview", () => {
  it("reports docker unavailable when no docker client is present", async () => {
    const result = await getHostOverview({
      docker: null,
      sessionManager: fakeSessionManager({}),
      runnerRegistry: fakeRunnerRegistry({}),
    });
    expect(result.dockerAvailable).toBe(false);
    expect(result.containers).toHaveLength(0);
    expect(result.totals).toEqual({ containers: 0, running: 0 });
  });

  it("reports docker unavailable (never throws) when listContainers fails", async () => {
    const docker = {
      listContainers: async () => {
        throw new Error("socket gone");
      },
    } as unknown as Docker;
    const result = await getHostOverview({
      docker,
      sessionManager: fakeSessionManager({}),
      runnerRegistry: fakeRunnerRegistry({}),
    });
    expect(result.dockerAvailable).toBe(false);
    expect(result.containers).toHaveLength(0);
  });

  it("maps containers and correlates session title + agent running state", async () => {
    const docker = fakeDocker([
      containerInfo({
        Id: "111111111111aaaa",
        Names: ["/shipit-sess-a"],
        State: "running",
        Created: 200,
        Labels: { [CONTAINER_SESSION_ID_LABEL]: "sess-a" },
      }),
      containerInfo({
        Id: "222222222222bbbb",
        Names: ["/shipit-sess-b"],
        State: "exited",
        Status: "Exited (0) 1 hour ago",
        Created: 100,
        Labels: { [CONTAINER_SESSION_ID_LABEL]: "sess-b" },
      }),
    ]);
    const result = await getHostOverview({
      docker,
      sessionManager: fakeSessionManager({ "sess-a": "Fix login bug", "sess-b": "Ops — host" }),
      runnerRegistry: fakeRunnerRegistry({ "sess-a": true, "sess-b": false }),
    });

    expect(result.dockerAvailable).toBe(true);
    expect(result.totals).toEqual({ containers: 2, running: 1 });
    // Sorted most-recently-created first.
    expect(result.containers[0].id).toBe("111111111111");
    expect(result.containers[0].sessionId).toBe("sess-a");
    expect(result.containers[0].sessionTitle).toBe("Fix login bug");
    expect(result.containers[0].agentRunning).toBe(true);
    expect(result.containers[0].name).toBe("shipit-sess-a");
    expect(result.containers[1].sessionTitle).toBe("Ops — host");
    expect(result.containers[1].agentRunning).toBe(false);
  });

  it("handles containers without a session label gracefully", async () => {
    const docker = fakeDocker([
      containerInfo({ Id: "333333333333cccc", Labels: { "shipit-session": "true" } }),
    ]);
    const result = await getHostOverview({
      docker,
      sessionManager: fakeSessionManager({}),
      runnerRegistry: fakeRunnerRegistry({}),
    });
    expect(result.containers[0].sessionId).toBeUndefined();
    expect(result.containers[0].sessionTitle).toBeUndefined();
    expect(result.containers[0].agentRunning).toBeUndefined();
  });
});
