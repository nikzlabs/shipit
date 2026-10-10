import { afterEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

// The one network call in the path; the sidecar launchers stay real so the pool
// reads the labels production writes.
vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  buildTierAEgressInputs: vi.fn(async () => ({ hosts: ["api.github.com"], cidrs: ["192.0.2.0/24"] })),
}));

import {
  acquirePluginNetns,
  dropIdlePluginNetns,
  idlePluginNetnsCount,
  MAX_IDLE_PLUGIN_NETNS_PER_SESSION,
  _resetPluginNetnsPool,
} from "./plugin-netns-pool.js";
import { UNCONTAINED_PLUGIN_EGRESS, type PluginEgressPolicy } from "./plugin-egress.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";

const SESSION = "s-1";
const NETWORK = "shipit-plugin-cli";

function fakeDocker() {
  const live = new Map<string, { opts: Record<string, unknown>; running: boolean }>();
  const created: { id: string; opts: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const handle = (id: string) => ({
    id,
    start: async () => { live.get(id)!.running = true; },
    wait: async () => ({ StatusCode: 0 }),
    remove: async () => {
      if (live.delete(id)) removed.push(id);
    },
  });
  const docker = {
    createContainer: async (opts: Record<string, unknown>) => {
      const id = `c-${created.length + 1}`;
      created.push({ id, opts });
      live.set(id, { opts, running: false });
      return handle(id);
    },
    getContainer: handle,
    listContainers: async () => [...live]
      .filter(([, c]) => c.running)
      .map(([Id, c]) => ({ Id, Labels: c.opts.Labels ?? {} })),
  };
  const holders = (): string[] => created
    .filter((c) => (c.opts.HostConfig as { NetworkMode: string }).NetworkMode === NETWORK)
    .map((c) => c.id);
  return {
    docker: docker as unknown as Docker,
    holders,
    removed,
    stop: (id: string) => { live.get(id)!.running = false; },
    resolverOf: (holderId: string): string => created.find((c) => {
      const labels = (c.opts.Labels ?? {}) as Record<string, string>;
      return EGRESS_RESOLVER_LABEL in labels
        && (c.opts.HostConfig as { NetworkMode: string }).NetworkMode === `container:${holderId}`;
    })!.id,
  };
}

function contained(over: Partial<PluginEgressPolicy> = {}): PluginEgressPolicy {
  return {
    contained: true,
    config: { contained: true, base: ["base.example"], extraHosts: ["extra.example"] },
    allowOnceHosts: ["once.example"],
    sidecarImage: "egress-sidecar:test",
    dnsEnabled: true,
    proxyEnabled: true,
    blockLocal: true,
    hostAddresses: async () => ["203.0.113.7"],
    ...over,
  };
}

function acquire(docker: Docker, policy: PluginEgressPolicy, sessionId = SESSION, idleMs?: number) {
  return acquirePluginNetns({
    docker, sessionId, network: NETWORK, holderImage: "worker:test", policy,
    ...(idleMs !== undefined ? { idleMs } : {}),
  });
}

async function useOnce(docker: Docker, policy: PluginEgressPolicy, sessionId = SESSION): Promise<string> {
  const lease = await acquire(docker, policy, sessionId);
  await lease.release({ reusable: true });
  return lease.networkMode;
}

afterEach(() => {
  _resetPluginNetnsPool();
  vi.useRealTimers();
});

describe("acquirePluginNetns — reuse", () => {
  it("hands the next command the namespace the last one left", async () => {
    const fake = fakeDocker();
    const first = await useOnce(fake.docker, contained());

    const second = await acquire(fake.docker, contained());

    expect(second.networkMode).toBe(first);
    expect(second.reused).toBe(true);
    expect(fake.holders()).toHaveLength(1);
    expect(fake.removed).not.toContain(fake.holders()[0]);
  });

  it("never gives one namespace to two commands that run at the same time", async () => {
    const fake = fakeDocker();
    await useOnce(fake.docker, contained());

    const a = await acquire(fake.docker, contained());
    const b = await acquire(fake.docker, contained());

    expect(a.reused).toBe(true);
    expect(b.reused).toBe(false);
    expect(b.networkMode).not.toBe(a.networkMode);
  });

  it("does not hand one session's namespace to another session", async () => {
    const fake = fakeDocker();
    const first = await useOnce(fake.docker, contained(), "s-1");

    const other = await acquire(fake.docker, contained(), "s-2");

    expect(other.reused).toBe(false);
    expect(other.networkMode).not.toBe(first);
  });

  it("builds nothing and keeps nothing for a session that needs no namespace of its own", async () => {
    const fake = fakeDocker();

    const lease = await acquire(fake.docker, UNCONTAINED_PLUGIN_EGRESS);
    await lease.release({ reusable: true });

    expect(lease.networkMode).toBe(NETWORK);
    expect(fake.holders()).toEqual([]);
    expect(idlePluginNetnsCount(SESSION)).toBe(0);
  });
});

describe("acquirePluginNetns — when the policy changed between calls", () => {
  const changes: [string, Partial<PluginEgressPolicy>][] = [
    ["a host allowed once", { allowOnceHosts: ["once.example", "new.example"] }],
    ["a host added to the allowlist", { config: { contained: true, base: ["base.example"], extraHosts: ["extra.example", "more.example"] } }],
    ["a host removed from the base list", { config: { contained: true, base: [], extraHosts: ["extra.example"] } }],
    ["a new identity rule", { config: { contained: true, base: ["base.example"], extraHosts: ["extra.example"], identityRules: "rules" } }],
    ["a new host address", { hostAddresses: async () => ["203.0.113.7", "203.0.113.8"] }],
    ["the proxy turned off", { proxyEnabled: false }],
    ["the resolver turned off", { dnsEnabled: false, proxyEnabled: false }],
    ["containment turned off", { contained: false }],
    ["a new sidecar image", { sidecarImage: "egress-sidecar:next" }],
  ];

  it.each(changes)("builds a new namespace after %s, and removes the old one", async (_name, change) => {
    const fake = fakeDocker();
    const first = await useOnce(fake.docker, contained());
    const [oldHolder] = fake.holders();

    const next = await acquire(fake.docker, contained(change));

    expect(next.reused).toBe(false);
    expect(next.networkMode).not.toBe(first);
    await vi.waitFor(() => { expect(fake.removed).toContain(oldHolder); });
    expect(idlePluginNetnsCount(SESSION)).toBe(0);
  });
});

describe("acquirePluginNetns — a namespace that is not safe to reuse", () => {
  it("removes the namespace of a command that may still be in it", async () => {
    const fake = fakeDocker();
    const lease = await acquire(fake.docker, contained());

    await lease.release({ reusable: false });

    expect(fake.removed).toContain(fake.holders()[0]);
    expect((await acquire(fake.docker, contained())).reused).toBe(false);
  });

  it("builds again when a sidecar of the idle namespace stopped", async () => {
    const fake = fakeDocker();
    await useOnce(fake.docker, contained());
    const [oldHolder] = fake.holders();
    fake.stop(fake.resolverOf(oldHolder));

    const next = await acquire(fake.docker, contained());

    expect(next.reused).toBe(false);
    await vi.waitFor(() => { expect(fake.removed).toContain(oldHolder); });
  });

  it("builds again when the idle holder stopped", async () => {
    const fake = fakeDocker();
    await useOnce(fake.docker, contained());
    const [oldHolder] = fake.holders();
    fake.stop(oldHolder);

    const next = await acquire(fake.docker, contained());

    expect(next.reused).toBe(false);
    expect(next.networkMode).not.toBe(`container:${oldHolder}`);
  });
});

describe("acquirePluginNetns — what an idle namespace costs", () => {
  it("removes a namespace that no command used for the idle time", async () => {
    vi.useFakeTimers();
    const fake = fakeDocker();
    const lease = await acquire(fake.docker, contained(), SESSION, 1_000);
    await lease.release({ reusable: true });
    const [holder] = fake.holders();

    await vi.advanceTimersByTimeAsync(999);
    expect(fake.removed).not.toContain(holder);
    await vi.advanceTimersByTimeAsync(1);

    expect(fake.removed).toContain(holder);
    expect(idlePluginNetnsCount(SESSION)).toBe(0);
  });

  it("keeps a bounded number of idle namespaces for one session", async () => {
    const fake = fakeDocker();
    const leases = [];
    for (let i = 0; i < MAX_IDLE_PLUGIN_NETNS_PER_SESSION + 1; i++) {
      leases.push(await acquire(fake.docker, contained()));
    }

    for (const lease of leases) await lease.release({ reusable: true });

    expect(idlePluginNetnsCount(SESSION)).toBe(MAX_IDLE_PLUGIN_NETNS_PER_SESSION);
    expect(fake.removed).toContain(fake.holders().at(-1));
  });

  it("removes a session's idle namespaces when its container goes away, and no other session's", async () => {
    const fake = fakeDocker();
    await useOnce(fake.docker, contained(), "s-1");
    await useOnce(fake.docker, contained(), "s-2");
    const [first, second] = fake.holders();

    dropIdlePluginNetns("s-1");

    await vi.waitFor(() => { expect(fake.removed).toContain(first); });
    expect(fake.removed).not.toContain(second);
    expect(idlePluginNetnsCount("s-2")).toBe(1);
  });
});
