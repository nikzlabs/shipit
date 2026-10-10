/**
 * A Docker daemon's networks, for tests. The status codes are the daemon's; `composeDown` is
 * Compose's own rule for a network at `down` (pkg/compose/down.go, `removeNetwork`). A container
 * names its networks from creation, and has an endpoint on them only while it runs.
 */
import type { SessionNetworkDocker } from "./session-network-release.js";

function daemonError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

interface FakeContainer {
  networks: Set<string>;
  running: boolean;
}

export function fakeNetworkDocker() {
  const networks = new Set<string>();
  const containers = new Map<string, FakeContainer>();
  const calls: string[] = [];

  const requireNetwork = (name: string): void => {
    if (!networks.has(name)) throw daemonError(404, `network ${name} not found`);
  };
  const named = (name: string): string[] =>
    [...containers].filter(([, c]) => c.networks.has(name)).map(([id]) => id).sort();
  const attached = (name: string): string[] => named(name).filter((id) => containers.get(id)?.running);
  const container = (id: string): FakeContainer => {
    const found = containers.get(id) ?? { networks: new Set<string>(), running: true };
    containers.set(id, found);
    return found;
  };

  const docker: SessionNetworkDocker = {
    getNetwork: (name) => ({
      connect: async ({ Container }) => {
        calls.push(`connect:${name}:${Container}`);
        requireNetwork(name);
        if (container(Container).networks.has(name)) {
          throw daemonError(403, `endpoint with name ${Container} already exists in network ${name}`);
        }
        container(Container).networks.add(name);
      },
      disconnect: async ({ Container }) => {
        calls.push(`disconnect:${name}:${Container}`);
        requireNetwork(name);
        if (!containers.get(Container)?.networks.delete(name)) {
          throw daemonError(500, `container ${Container} is not connected to network ${name}`);
        }
      },
      remove: async () => {
        calls.push(`remove:${name}`);
        requireNetwork(name);
        if (attached(name).length > 0) throw daemonError(403, `network ${name} has active endpoints`);
        networks.delete(name);
      },
    }),
    // Without `all`, the daemon lists only running containers.
    listContainers: async ({ all, filters }) =>
      [...new Set(filters.network.flatMap(all ? named : attached))].map((id) => ({ Id: id, Names: [`/${id}`] })),
  };

  return {
    docker,
    calls,
    has: (name: string): boolean => networks.has(name),
    /** Containers with an endpoint on the network. */
    attached,
    /** A network, and running containers on it. */
    seed(name: string, running: string[] = []): void {
      networks.add(name);
      for (const id of running) container(id).networks.add(name);
    },
    /** `up`, after it found or created the network: the containers, which do not run yet. */
    createContainers(name: string, ids: string[]): void {
      requireNetwork(name);
      for (const id of ids) containers.set(id, { networks: new Set([name]), running: false });
    },
    /** `up`, second half. A container whose network is gone cannot start. */
    composeStart(ids: string[]): void {
      for (const id of ids) {
        const c = container(id);
        for (const name of c.networks) requireNetwork(name);
        c.running = true;
      }
    },
    /** `down`: a network that still has an endpoint is left, with a warning and exit 0. */
    composeDown(name: string, ids: string[]): void {
      for (const id of ids) containers.delete(id);
      if (networks.has(name) && attached(name).length === 0) networks.delete(name);
    },
    stopContainer(id: string): void {
      const c = containers.get(id);
      if (c) c.running = false;
    },
    removeContainer(id: string): void {
      containers.delete(id);
    },
  };
}
