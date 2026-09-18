import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionContainerManager } from "./session-container.js";

const SESSION = "aa11bb22-cc33-dd44-ee55-ff6677889900";
const SERVICE_IP = "172.31.0.7";
const NEW_SERVICE_IP = "172.31.0.8";
const SESSION_SUBNET = "172.31.0.0/16";
const BROWSER_IP = "10.0.0.9";

interface Entry {
  Id: string;
  Labels: Record<string, string>;
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

function entry(id: string, sessionId: string, ip: string): Entry {
  return {
    Id: id,
    Labels: { "shipit-parent-session": sessionId },
    NetworkSettings: { Networks: { [`shipit-session-${sessionId}`]: { IPAddress: ip } } },
  };
}

function createFakeDocker(entries: Entry[]) {
  const state = {
    entries,
    fail: false,
    hang: false,
    networks: {} as Record<string, string>,
  };
  const listContainers = vi.fn(async (args?: { all?: boolean }) => {
    if (args?.all) return [];
    if (state.fail) throw new Error("dockerd unavailable");
    if (state.hang) await new Promise(() => { /* never settles */ });
    return state.entries;
  });
  const docker = {
    listContainers,
    getNetwork: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        const subnet = state.networks[name];
        if (!subnet) throw new Error(`no such network: ${name}`);
        return { IPAM: { Config: [{ Subnet: subnet }] } };
      }),
      disconnect: vi.fn(async () => undefined),
    })),
  };
  return { docker, state, listContainers };
}

function createManager(docker: unknown): SessionContainerManager {
  return new SessionContainerManager({
    docker: docker as never,
    imageName: "shipit-session-worker:test",
    networkName: "shipit-test",
    skipHealthCheck: true,
  });
}

describe("container-origin index", () => {
  let manager: SessionContainerManager;

  beforeEach(() => {
    vi.stubEnv("SESSION_EGRESS_ENFORCE", "1");
  });

  afterEach(async () => {
    await manager.dispose();
    vi.unstubAllEnvs();
  });

  it("stops asking dockerd about a browser IP once the index is warm", async () => {
    const { docker, listContainers } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    const afterFirst = listContainers.mock.calls.length;

    for (let i = 0; i < 25; i++) {
      expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    }
    expect(listContainers.mock.calls.length).toBe(afterFirst);

    // Cross the old one-second negative-cache window; immediate repeats would also pass before the fix.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    expect(listContainers.mock.calls.length).toBe(afterFirst);
  });

  it("still resolves a session container's IP to its session", async () => {
    const { docker } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("resolves it without any help from the session network ranges", async () => {
    const { docker } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);

    expect(await manager.getSessionByAnyContainerIp(SERVICE_IP)).toEqual({ sessionId: SESSION });
    expect(manager.isLikelySessionContainerIp(SERVICE_IP)).toBe(false);
  });

  it("resolves a container that comes up WHILE a topology bracket is open", async () => {
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    manager = createManager(docker);
    await manager.getSessionByAnyContainerIp(BROWSER_IP);

    const endBracket = manager.beginContainerTopologyChange();
    try {
      await manager.getSessionByAnyContainerIp(BROWSER_IP).catch(() => undefined);
      state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];

      expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
    } finally {
      endBracket();
    }

    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("brackets the egress containment that gives a running service a second address", async () => {
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    vi.stubEnv("SESSION_EGRESS_ENFORCE", "0");
    manager = createManager(docker);
    await manager.getSessionByAnyContainerIp(BROWSER_IP);

    state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];
    await manager.containComposeServices(SESSION, ["web"]);

    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });
  });

  it("knows the Docker-access bridge's TRUNCATED network name", async () => {
    const { docker, state } = createFakeDocker([]);
    state.networks[`shipit-session-${SESSION.slice(0, 12)}`] = SESSION_SUBNET;
    manager = createManager(docker);
    await manager.prepareComposeServiceStart(SESSION, []);

    expect(manager.isLikelySessionContainerIp(NEW_SERVICE_IP)).toBe(true);
  });

  it("does not read a miss inside a session subnet as a browser", async () => {
    const { docker, state } = createFakeDocker([entry("svc", SESSION, SERVICE_IP)]);
    state.networks[`shipit-session-${SESSION}`] = SESSION_SUBNET;
    manager = createManager(docker);
    await manager.prepareComposeServiceStart(SESSION, []);
    expect(manager.isLikelySessionContainerIp(NEW_SERVICE_IP)).toBe(true);

    await manager.getSessionByAnyContainerIp(BROWSER_IP);
    state.entries = [...state.entries, entry("svc-2", SESSION, NEW_SERVICE_IP)];

    expect(await manager.getSessionByAnyContainerIp(NEW_SERVICE_IP)).toEqual({ sessionId: SESSION });

    const before = docker.listContainers.mock.calls.length;
    expect(await manager.getSessionByAnyContainerIp(BROWSER_IP)).toBeUndefined();
    expect(docker.listContainers.mock.calls.length).toBe(before);
  });

  it("reports the index unavailable rather than holding a request on a hung daemon", async () => {
    const { docker, state } = createFakeDocker([]);
    state.hang = true;
    manager = createManager(docker);

    const startedAt = Date.now();
    await expect(manager.getSessionByAnyContainerIp(BROWSER_IP)).rejects.toThrow(/unavailable/);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("does not re-ask a failing daemon on every request", async () => {
    const { docker, state, listContainers } = createFakeDocker([]);
    state.fail = true;
    manager = createManager(docker);

    for (let i = 0; i < 5; i++) {
      await expect(manager.getSessionByAnyContainerIp(BROWSER_IP)).rejects.toThrow(/unavailable/);
    }

    expect(listContainers.mock.calls.length).toBe(1);
  });
});
