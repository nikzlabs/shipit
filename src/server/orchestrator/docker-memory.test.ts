import { describe, it, expect } from "vitest";
import Docker from "dockerode";
import { readDockerMemoryStats } from "./docker-memory.js";

/**
 * docs/284 — the per-session breakdown is what lets the idle enforcer subtract
 * what a reclaim actually freed. Without it the enforcer cannot tell whether
 * one container covered the shortfall, and falls back to stopping a single
 * session per pass, so the attribution is load-bearing rather than cosmetic.
 */
function fakeDocker(containers: { Id: string; Labels: Record<string, string>; usage: number; failStats?: boolean }[]): Docker {
  return {
    info: async () => ({ MemTotal: 1000 }),
    listContainers: async () => containers.map(({ Id, Labels }) => ({ Id, Labels })),
    getContainer: (id: string) => ({
      stats: async () => {
        const c = containers.find((x) => x.Id === id);
        if (c?.failStats) throw new Error("stats unavailable");
        return { memory_stats: { usage: c?.usage ?? 0 } };
      },
    }),
  } as unknown as Docker;
}

describe("readDockerMemoryStats", () => {
  it("attributes agent and service containers to their session", async () => {
    const stats = await readDockerMemoryStats(fakeDocker([
      { Id: "agent-a", Labels: { "shipit-session-id": "a" }, usage: 100 },
      { Id: "web-a", Labels: { "shipit-parent-session": "a" }, usage: 30 },
      { Id: "db-a", Labels: { "shipit-parent-session": "a" }, usage: 20 },
      { Id: "agent-b", Labels: { "shipit-session-id": "b" }, usage: 50 },
    ]));

    expect(stats?.usedBytes).toBe(200);
    expect(stats?.totalBytes).toBe(1000);
    expect(stats?.bySession).toEqual({
      a: { agentBytes: 100, serviceBytes: 50 },
      b: { agentBytes: 50, serviceBytes: 0 },
    });
  });

  // A session whose agent container was already reclaimed still has a stack,
  // and tier 2 needs to know what stopping it would give back.
  it("attributes a session that has services but no agent container", async () => {
    const stats = await readDockerMemoryStats(fakeDocker([
      { Id: "web-a", Labels: { "shipit-parent-session": "a" }, usage: 40 },
    ]));

    expect(stats?.bySession).toEqual({ a: { agentBytes: 0, serviceBytes: 40 } });
  });

  it("counts unlabelled containers in the total but attributes them to nobody", async () => {
    const stats = await readDockerMemoryStats(fakeDocker([
      { Id: "orchestrator", Labels: {}, usage: 70 },
      { Id: "agent-a", Labels: { "shipit-session-id": "a" }, usage: 30 },
    ]));

    expect(stats?.usedBytes).toBe(100);
    expect(stats?.bySession).toEqual({ a: { agentBytes: 30, serviceBytes: 0 } });
  });

  // A failed per-container read is UNKNOWN, not zero. Left as a zero entry the
  // enforcer would read the session as "measured, frees nothing" and keep
  // reclaiming other sessions on the strength of a number nobody read.
  it("omits a session whose container stats could not be read", async () => {
    const stats = await readDockerMemoryStats(fakeDocker([
      { Id: "agent-a", Labels: { "shipit-session-id": "a" }, usage: 100 },
      { Id: "web-a", Labels: { "shipit-parent-session": "a" }, usage: 0, failStats: true },
      { Id: "agent-b", Labels: { "shipit-session-id": "b" }, usage: 50 },
    ]));

    expect(stats?.bySession).toEqual({ b: { agentBytes: 50, serviceBytes: 0 } });
    // The readable containers still count toward the global shortfall.
    expect(stats?.usedBytes).toBe(150);
  });

  it("returns null when Docker is unreachable", async () => {
    const broken = { info: async () => { throw new Error("no docker"); } } as unknown as Docker;
    expect(await readDockerMemoryStats(broken)).toBeNull();
  });
});
