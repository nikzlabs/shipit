import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import {
  releaseSessionNetwork,
  releaseSessionNetworkQueued,
  type SessionNetworkDocker,
} from "./session-network-release.js";
import { fakeNetworkDocker } from "./session-network-test-helpers.js";
import { serializeStackOp } from "./stack-op-queue.js";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NETWORK = `shipit-session-${SESSION}`;
const SELF = "0123456789ab";
const AGENT = "agent-aaaaaaaa-bbb";
const ORCHESTRATOR = os.hostname();

describe("releaseSessionNetwork", () => {
  afterEach(() => vi.restoreAllMocks());

  const release = (docker: SessionNetworkDocker, orchestratorId = SELF) =>
    releaseSessionNetwork(docker, NETWORK, { orchestratorId });

  it("detaches the orchestrator and removes a network that nothing else names", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);

    expect(await release(h.docker)).toBe("removed");

    expect(h.has(NETWORK)).toBe(false);
    expect(h.calls).toEqual([`disconnect:${NETWORK}:${SELF}`, `remove:${NETWORK}`]);
  });

  it("removes a network that has no endpoint at all", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK);

    expect(await release(h.docker)).toBe("removed");
    expect(h.calls).toEqual([`remove:${NETWORK}`]);
  });

  it("leaves a network that another container is attached to, and stays attached itself", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF, AGENT]);

    expect(await release(h.docker)).toBe("in-use");

    expect(h.attached(NETWORK)).toEqual([SELF, AGENT]);
    expect(h.calls).toEqual([]);
  });

  // Docker removes a network under a container that is not running, and that container can then never start.
  it("leaves a network that a created container names before it runs", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);
    h.createContainers(NETWORK, ["web-1"]);

    expect(await release(h.docker)).toBe("in-use");

    expect(h.calls).toEqual([]);
    expect(() => h.composeStart(["web-1"])).not.toThrow();
  });

  it("leaves a network that a stopped container names", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF, "web-1"]);
    h.stopContainer("web-1");

    expect(await release(h.docker)).toBe("in-use");
    expect(h.calls).toEqual([]);
  });

  it("asks Docker for the containers under each name the caller gives for the network", async () => {
    const h = fakeNetworkDocker();
    const listContainers = vi.fn(h.docker.listContainers);

    await releaseSessionNetwork({ ...h.docker, listContainers }, "net-id", { orchestratorId: SELF, names: [NETWORK] });

    expect(listContainers.mock.calls[0][0]).toMatchObject({ all: true, filters: { network: ["net-id", NETWORK] } });
  });

  it("reports an absent network", async () => {
    const h = fakeNetworkDocker();

    expect(await release(h.docker)).toBe("absent");
    expect(h.has(NETWORK)).toBe(false);
  });

  it("re-attaches the orchestrator when a container joined after the listing", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);
    const racing: SessionNetworkDocker = {
      ...h.docker,
      getNetwork: (name) => {
        const handle = h.docker.getNetwork(name);
        return {
          ...handle,
          disconnect: async (options) => {
            await handle.disconnect(options);
            h.seed(NETWORK, ["web-1"]);
          },
        };
      },
    };

    expect(await release(racing)).toBe("in-use");

    expect(h.attached(NETWORK)).toEqual([SELF, "web-1"]);
  });

  it("reports a failure when it cannot put the orchestrator back on a network it kept", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stuck: SessionNetworkDocker = {
      ...h.docker,
      getNetwork: (name) => {
        const handle = h.docker.getNetwork(name);
        return {
          ...handle,
          disconnect: async (options) => {
            await handle.disconnect(options);
            h.seed(NETWORK, ["web-1"]);
          },
          connect: async () => { throw new Error("daemon unreachable"); },
        };
      },
    };

    expect(await release(stuck)).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("matches the orchestrator by the id prefix that a default hostname is", async () => {
    const fullId = `${SELF}${"c".repeat(52)}`;
    const h = fakeNetworkDocker();
    h.seed(NETWORK);
    const named: SessionNetworkDocker = {
      listContainers: async () => [{ Id: fullId, Names: ["/shipit-shipit-1"] }],
      getNetwork: (name) => ({ ...h.docker.getNetwork(name), disconnect: async () => {} }),
    };

    expect(await release(named)).toBe("removed");
  });

  it("does not match another container's id by a short, named hostname", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [`cafe${"0".repeat(60)}`]);

    expect(await release(h.docker, "cafe")).toBe("in-use");
    expect(h.calls).toEqual([]);
  });

  it("is quiet when a concurrent release took the network first", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second: SessionNetworkDocker = {
      ...h.docker,
      listContainers: async (options) => {
        const seen = await h.docker.listContainers(options);
        await releaseSessionNetwork(h.docker, NETWORK, { orchestratorId: SELF });
        return seen;
      },
    };

    expect(await release(second)).toBe("absent");
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives each Docker call a time limit", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [SELF]);
    const signals: (AbortSignal | undefined)[] = [];
    const observed: SessionNetworkDocker = {
      listContainers: (options) => { signals.push(options.abortSignal); return h.docker.listContainers(options); },
      getNetwork: (name) => {
        const handle = h.docker.getNetwork(name);
        return {
          ...handle,
          disconnect: (options) => { signals.push(options.abortSignal); return handle.disconnect(options); },
          remove: (options) => { signals.push(options?.abortSignal); return handle.remove(options); },
        };
      },
    };

    const timeout = vi.spyOn(AbortSignal, "timeout");

    await release(observed);

    expect(timeout.mock.results.map((result) => result.value)).toEqual(signals);
    expect(signals).toHaveLength(3);
  });

  it("reports a failure, and does not reject, when Docker does not answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: SessionNetworkDocker = {
      listContainers: async () => { throw new Error("daemon unreachable"); },
      getNetwork: () => { throw new Error("daemon unreachable"); },
    };

    expect(await release(broken)).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("releaseSessionNetworkQueued", () => {
  const flush = () => serializeStackOp(SESSION, async () => {});

  it("removes the network of a session that no ServiceManager owns", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [ORCHESTRATOR]);

    releaseSessionNetworkQueued(h.docker, SESSION, () => false);
    await flush();

    expect(h.has(NETWORK)).toBe(false);
  });

  // A registered manager can start a service outside the stack queue at any moment.
  it("leaves the network of a session whose ServiceManager is registered, with no container on it", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [ORCHESTRATOR]);

    releaseSessionNetworkQueued(h.docker, SESSION, () => true);
    await flush();

    expect(h.attached(NETWORK)).toEqual([ORCHESTRATOR]);
    expect(h.calls).toEqual([]);
  });

  it("runs behind a stack operation of the session that is already queued", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [ORCHESTRATOR]);
    let finishStart = (): void => {};
    // An `up` that found the network, and has not created its first container yet.
    const start = serializeStackOp(SESSION, async () => {
      await new Promise<void>((resolve) => { finishStart = resolve; });
      h.createContainers(NETWORK, ["web-1"]);
      h.composeStart(["web-1"]);
    });

    releaseSessionNetworkQueued(h.docker, SESSION, () => false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.has(NETWORK)).toBe(true);

    finishStart();
    await start;
    await flush();

    expect(h.attached(NETWORK)).toEqual([ORCHESTRATOR, "web-1"].sort());
  });

  it("reads the ownership when its turn in the queue comes, not when it is asked", async () => {
    const h = fakeNetworkDocker();
    h.seed(NETWORK, [ORCHESTRATOR]);
    let owned = false;
    const registering = serializeStackOp(SESSION, async () => { owned = true; });

    releaseSessionNetworkQueued(h.docker, SESSION, () => owned);
    await registering;
    await flush();

    expect(h.has(NETWORK)).toBe(true);
  });
});
