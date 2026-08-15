/**
 * docs/262 req 24 — the namespace a plugin container runs in.
 *
 * The claims here are about a boundary in two directions at once, which is the
 * whole difficulty of this slice:
 *
 *  - req 24 — what the container may reach OUT to must equal what the session's
 *    own code may reach, so the allowlist handed to the resolver and the SNI
 *    proxy is compared by VALUE against the session's resolved config (plus the
 *    allow-once snapshot), never merely "some allowlist was passed".
 *  - req 19 — closing that must not open the other one. The namespace is a
 *    ShipIt-owned holder on the untrusted plugin network; a namespace belonging
 *    to a SESSION container would hand plugin code the worker's loopback
 *    credential broker. Asserted explicitly, because "it is a `container:` mode
 *    now" is exactly the change that could go wrong quietly.
 *
 * The three tier launchers are mocked (they shell out to a privileged sidecar on
 * a live host, and `buildTierAEgressInputs` fetches GitHub's meta endpoint) —
 * the same seam `compose-service-egress.test.ts` uses. What is under test is the
 * composition and the ordering around them, which is where this module's
 * decisions live.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type Docker from "dockerode";

// Typed with their real second argument: several claims below read it back —
// the allowlist by value, the absent decision endpoint, the absent tier uids —
// and an argument-less stub makes those unreachable rather than merely untyped.
const { installFirewall, launchResolver, launchProxy } = vi.hoisted(() => ({
  installFirewall: vi.fn(
    async (_docker: unknown, _opts: Record<string, unknown>): Promise<void> => undefined,
  ),
  launchResolver: vi.fn(
    async (_docker: unknown, _opts: { configB64: string }): Promise<string> => "resolver-id",
  ),
  launchProxy: vi.fn(
    async (
      _docker: unknown,
      _opts: { allowed: string; sessionId: string; decisionUrl?: string },
    ): Promise<string> => "proxy-id",
  ),
}));

vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  buildTierAEgressInputs: vi.fn(async () => ({ hosts: ["api.github.com"], cidrs: [] })),
  installEgressFirewall: installFirewall,
}));
vi.mock("./egress-dns-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-dns-install.js")>()),
  launchEgressResolver: launchResolver,
}));
vi.mock("./egress-proxy-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-proxy-install.js")>()),
  launchEgressProxy: launchProxy,
}));

import {
  preparePluginNetns,
  unreachableDeclaredHosts,
  PLUGIN_NETNS_LABEL,
  PLUGIN_NETNS_PARENT_LABEL,
  UNCONTAINED_PLUGIN_EGRESS,
  type PluginEgressPolicy,
} from "./plugin-egress.js";
import { pluginHostAllowance } from "./plugin-hosts.js";
import { hostMatchesEntry } from "./egress-allowlist.js";
import { allowEgressHost, listEgressAllowedHosts, _resetEgressPolicies } from "./egress-policy.js";

const SESSION = "s-1";
const NETWORK = "shipit-plugin-cli";

interface Created {
  id: string;
  opts: Record<string, unknown>;
}

function fakeDocker(events: string[] = []) {
  const created: Created[] = [];
  const removed: string[] = [];
  let listed: Docker.ContainerInfo[] = [];
  let seq = 0;
  /** Models Docker refusing to remove a container whose netns is borrowed. */
  let failHolder: { id: string; shouldFail: () => boolean } | null = null;
  const docker = {
    createContainer: async (opts: Record<string, unknown>) => {
      const id = `c-${++seq}`;
      created.push({ id, opts });
      return {
        id,
        start: async () => { events.push(`start:${id}`); },
        remove: async () => {
          if (failHolder?.id === id && failHolder.shouldFail()) {
            throw new Error(`container ${id} is using its network — cannot remove`);
          }
          removed.push(id);
        },
      };
    },
    listContainers: async () => listed,
    getContainer: (id: string) => ({
      remove: async () => { removed.push(id); },
    }),
  };
  return {
    docker: docker as unknown as Docker,
    created,
    removed,
    /** What a later `listContainers` should report — the launched sidecars. */
    setListed: (entries: Docker.ContainerInfo[]) => { listed = entries; },
    failHolderRemove: (id: string, shouldFail: () => boolean) => { failHolder = { id, shouldFail }; },
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
    ...over,
  };
}

function prepare(docker: Docker, policy: PluginEgressPolicy) {
  return preparePluginNetns({
    docker, sessionId: SESSION, network: NETWORK, holderImage: "worker:test", policy,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preparePluginNetns — an uncontained session", () => {
  // The other half of req 24's sentence, and the one an over-eager containment
  // would break: a plugin container must reach exactly what equivalent same-repo
  // code reaches, and on an Open session (or a deployment with enforcement off)
  // that is everything. Denying something here would be a NEW restriction a
  // plugin declaration brought with it, which req 24 forbids in the same breath.
  it("hands back the plugin network itself and creates nothing", async () => {
    const fake = fakeDocker();

    const netns = await prepare(fake.docker, UNCONTAINED_PLUGIN_EGRESS);

    expect(netns.networkMode).toBe(NETWORK);
    expect(fake.created).toHaveLength(0);
    expect(installFirewall).not.toHaveBeenCalled();
    await netns.release();
    expect(fake.removed).toEqual([]);
  });
});

describe("preparePluginNetns — a contained session", () => {
  it("installs every tier into a holder and runs the workload in ITS namespace", async () => {
    const events: string[] = [];
    const fake = fakeDocker(events);
    installFirewall.mockImplementationOnce(async () => { events.push("firewall"); });
    launchResolver.mockImplementationOnce(async () => { events.push("resolver"); return "r"; });
    launchProxy.mockImplementationOnce(async () => { events.push("proxy"); return "p"; });

    const netns = await prepare(fake.docker, contained());

    const holder = fake.created[0];
    expect(netns.networkMode).toBe(`container:${holder.id}`);
    // The ordering IS the control: the holder is running and fully contained
    // before the caller is given a namespace to start plugin code in. A workload
    // created first and contained after has an instant in which it is not, which
    // is the window `compose-service-egress.ts` has to pause to close.
    expect(events).toEqual([`start:${holder.id}`, "firewall", "resolver", "proxy"]);
  });

  it("puts the holder on the untrusted plugin network, with nothing of the session in it", async () => {
    // req 19, which closing req 24 must not cost. The holder is what the
    // workload's namespace IS, so anything the holder can reach, plugin code can
    // reach — including, if this were a session container's namespace, the
    // worker's unauthenticated loopback credential broker.
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    const holder = fake.created[0].opts;
    const host = holder.HostConfig as Record<string, unknown>;
    expect(host.NetworkMode).toBe(NETWORK);
    expect(String(host.NetworkMode).startsWith("container:")).toBe(false);
    expect(host.NetworkMode).not.toBe("host");
    // No filesystem and no environment: a holder runs `sleep`, and every way to
    // give it more is a way to give plugin code more.
    expect(host.Mounts ?? []).toEqual([]);
    expect(host.Binds ?? []).toEqual([]);
    expect(host.VolumesFrom ?? []).toEqual([]);
    expect(holder.Env ?? []).toEqual([]);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(holder.NetworkingConfig).toBeUndefined();
    expect((holder.Labels as Record<string, string>)[PLUGIN_NETNS_LABEL]).toBe(SESSION);
  });

  /**
   * The label set, pinned exhaustively, because the wrong ONE is a live-call
   * killer rather than a tidiness issue.
   *
   * `shipit-parent-session` is what `compose-cli.ts`'s `killStaleContainers`
   * sweeps before every Compose start: it `docker rm -f`s each container
   * carrying it, sparing only a resolver/proxy whose netns parent is running. A
   * holder carries neither keep-label, so with that label any
   * `shipit service start` in the session would delete the namespace a running
   * companion CLI is executing in — and its resolver and proxy with it. The
   * workload containers carry only their own plugin label for the same reason.
   */
  it("carries only the plugin label, so no session-scoped sweep can delete it mid-call", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    for (const { opts } of fake.created) {
      const labels = opts.Labels as Record<string, string>;
      expect(labels).not.toHaveProperty("shipit-parent-session");
      expect(labels).not.toHaveProperty("shipit-service-name");
      expect(labels[PLUGIN_NETNS_LABEL]).toBe(SESSION);
    }
    // …and the sidecars launched into the namespace inherit that decision.
    for (const call of [launchResolver.mock.calls[0], launchProxy.mock.calls[0]]) {
      const labels = (call[1] as unknown as { labels: Record<string, string> }).labels;
      expect(labels).not.toHaveProperty("shipit-parent-session");
      expect(labels[PLUGIN_NETNS_PARENT_LABEL]).toBe(fake.created[0].id);
    }
  });

  // Tier C's `nat/OUTPUT` REDIRECT to the loopback SNI proxy is dropped as a
  // martian without this, and the sysctl is namespaced — so it belongs to the
  // container that OWNS the namespace, and the installer sidecar cannot set it
  // (its `/proc/sys` is read-only). Same reasoning, same line, as
  // `container-lifecycle.ts` sets on the agent container.
  it("enables route_localnet on the holder when Tier C is on, and not otherwise", async () => {
    const withProxy = fakeDocker();
    await prepare(withProxy.docker, contained());
    expect((withProxy.created[0].opts.HostConfig as Record<string, unknown>).Sysctls)
      .toEqual({ "net.ipv4.conf.all.route_localnet": "1" });

    const withoutProxy = fakeDocker();
    await prepare(withoutProxy.docker, contained({ proxyEnabled: false }));
    expect((withoutProxy.created[0].opts.HostConfig as Record<string, unknown>).Sysctls)
      .toBeUndefined();
  });

  // The requirement itself, by value. "An allowlist was passed" would pass while
  // the container reached a different set from the agent — which is precisely
  // the failure this slice exists to fix, in the other direction.
  it("resolves and dials exactly the session's own allowlist, plus its allow-once hosts", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    expect(launchResolver).toHaveBeenCalledWith(fake.docker, expect.objectContaining({
      agentContainerId: fake.created[0].id,
      configB64: expect.any(String),
    }));
    const dnsmasq = Buffer.from(
      launchResolver.mock.calls[0][1].configB64, "base64",
    ).toString("utf-8");
    for (const host of ["base.example", "extra.example", "once.example"]) {
      expect(dnsmasq).toContain(host);
    }
    expect(launchProxy).toHaveBeenCalledWith(fake.docker, expect.objectContaining({
      allowed: "base.example extra.example once.example",
      sessionId: SESSION,
    }));
  });

  // A plugin container has no callback to make, so it gets no name for the
  // orchestrator — deliberately narrower than the agent's resolver, which
  // allowlists `orchestratorInternalNames` so the worker can reach ShipIt.
  it("gives the namespace no way to resolve the orchestrator", async () => {
    const fake = fakeDocker();
    vi.stubEnv("SHIPIT_ORCHESTRATOR_HOST", "orchestrator.internal");

    await prepare(fake.docker, contained());

    const dnsmasq = Buffer.from(
      launchResolver.mock.calls[0][1].configB64, "base64",
    ).toString("utf-8");
    expect(dnsmasq).not.toContain("orchestrator.internal");
    vi.unstubAllEnvs();
  });

  // The proxy's allow-once round trip is a request to `/api/*`, which this
  // container's own network is denied by req 19 — so the answer is snapshotted
  // into the static allowlist above instead of being asked for at runtime. An
  // endpoint here would be a request that can only ever 403.
  it("gives the SNI proxy no decision endpoint to ask", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained());

    expect(launchProxy.mock.calls[0][1].decisionUrl).toBeUndefined();
  });

  it("skips a tier the session itself does not run", async () => {
    const fake = fakeDocker();

    await prepare(fake.docker, contained({ dnsEnabled: false, proxyEnabled: false }));

    const installed = installFirewall.mock.calls[0][1];
    // Absent, not `undefined`: the installer script branches on the env var
    // being SET, and Tier A with no resolver uid is a different, valid policy.
    expect(installed).not.toHaveProperty("resolverUid");
    expect(installed).not.toHaveProperty("proxyUid");
    expect(launchResolver).not.toHaveBeenCalled();
    expect(launchProxy).not.toHaveBeenCalled();
  });

  it("removes the sidecars and then the holder on release", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const holderId = fake.created[0].id;
    fake.setListed([
      { Id: "resolver-1", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: holderId } },
      // A sidecar of a DIFFERENT holder — a concurrent invocation in the same
      // session. Releasing one call must not tear down another's namespace.
      { Id: "proxy-other", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: "c-99" } },
    ] as unknown as Docker.ContainerInfo[]);

    await netns.release();

    expect(fake.removed).toEqual(["resolver-1", holderId]);
  });
});

/**
 * The claim the parent slice asked for in so many words: enforcement and the
 * Plugins card must not be able to disagree.
 *
 * Both answers are derived here from ONE session state — a resolved config plus
 * an allow-once decision — and compared host by host: what
 * `pluginHostAllowance` renders as allowed on the card is what the container's
 * SNI proxy will actually splice. Before this slice the card was the only one of
 * the two that existed for a CLI container, and it reported against an allowlist
 * nothing enforced.
 */
describe("what the container reaches and what the card reports", () => {
  it("agree, host by host, including the allow-once decision", async () => {
    _resetEgressPolicies();
    const config = {
      contained: true,
      base: ["base.example"],
      extraHosts: [".suffix.example"],
    };
    // A user decision taken in this session, which only the in-memory policy
    // knows about — the case a config-only snapshot would have dropped.
    allowEgressHost(SESSION, "once.example");

    const fake = fakeDocker();
    await prepare(fake.docker, contained({
      config,
      allowOnceHosts: listEgressAllowedHosts(SESSION),
    }));
    const proxyAllowed = launchProxy.mock.calls[0][1].allowed.split(" ");

    const reportsAllowed = pluginHostAllowance({ contained: true, config, sessionId: SESSION });
    for (const host of [
      "base.example",         // the effective base
      "api.suffix.example",   // a suffix entry, matched rather than equalled
      "once.example",         // the allow-once decision
      "denied.example",       // and one nobody granted
    ]) {
      expect({ host, allowed: reportsAllowed(host) }).toEqual({
        host,
        allowed: proxyAllowed.some((entry) => hostMatchesEntry(host, entry)),
      });
    }
    _resetEgressPolicies();
  });
});

/**
 * req 24's visibility half, for the one moment the Plugins card cannot cover: a
 * plugin whose FIRST activation fails has no live generation, so the card
 * resolves no declared hosts and offers no "Allow" buttons. Containing `install`
 * made that reachable, so the failure has to name the hosts itself.
 */
describe("unreachableDeclaredHosts", () => {
  it("names only the declared hosts this session does not already permit", () => {
    expect(unreachableDeclaredHosts(
      contained({
        config: { contained: true, base: ["base.example"], extraHosts: [".suffix.example"] },
        allowOnceHosts: ["once.example"],
      }),
      ["base.example", "api.suffix.example", "once.example", "vendor.example", "VENDOR.example"],
    )).toEqual(["vendor.example"]);
  });

  // Saying "egress" about an install that failed for some other reason is a
  // wrong guess pointed at the user, so silence is the answer here.
  it("says nothing when the session denies nothing, or the plugin declared nothing", () => {
    expect(unreachableDeclaredHosts(UNCONTAINED_PLUGIN_EGRESS, ["vendor.example"])).toEqual([]);
    expect(unreachableDeclaredHosts(contained(), [])).toEqual([]);
  });
});

describe("preparePluginNetns — failing closed", () => {
  // The same choice `containComposeServices` makes for a service and
  // `ensureUntrustedPluginNetwork` makes for the API boundary: a contained
  // session does not get an uncontained plugin container.
  it("refuses when the deployment has no egress sidecar image", async () => {
    const fake = fakeDocker();

    await expect(prepare(fake.docker, contained({ sidecarImage: undefined })))
      .rejects.toThrow(/SESSION_EGRESS_SIDECAR_IMAGE/);
    expect(fake.created).toHaveLength(0);
  });

  /**
   * `installEgressFirewall` awaits `container.wait()` with no deadline of its
   * own. On the agent-creation path that stalls one visible session start; here
   * it would sit in front of a companion-CLI call and hold an agent turn open
   * indefinitely — the failure `plugin-container.ts`'s bounded reap exists to
   * prevent, arriving one layer up.
   */
  it("gives up rather than hanging when a tier install never returns", async () => {
    const fake = fakeDocker();
    installFirewall.mockImplementationOnce(() => new Promise<void>(() => { /* never */ }));

    await expect(preparePluginNetns({
      docker: fake.docker,
      sessionId: SESSION,
      network: NETWORK,
      holderImage: "worker:test",
      policy: contained(),
      setupTimeoutMs: 20,
    })).rejects.toThrow(/did not finish within/);
    // And the abandoned work cannot outlive the namespace: force-removing the
    // holder is what makes the timeout safe rather than merely prompt.
    expect(fake.removed).toEqual([fake.created[0].id]);
  });

  /**
   * The timeout abandons work that is still running, so a sidecar can appear
   * AFTER the sweep listed and BEFORE the holder is removed — and Docker refuses
   * to remove a container whose namespace another container is borrowing. One
   * pass would leave a holder plus a restart-policy resolver and proxy stranded
   * until the next boot, once per timeout.
   */
  it("sweeps again when a sidecar appears between the listing and the holder removal", async () => {
    const fake = fakeDocker();
    const netns = await prepare(fake.docker, contained());
    const holderId = fake.created[0].id;
    // First removal fails the way Docker fails it; the late sidecar is visible
    // only from the second listing.
    let holderAttempts = 0;
    fake.failHolderRemove(holderId, () => {
      holderAttempts++;
      if (holderAttempts > 1) return false;
      fake.setListed([
        { Id: "late-sidecar", Labels: { [PLUGIN_NETNS_PARENT_LABEL]: holderId } },
      ] as unknown as Docker.ContainerInfo[]);
      return true;
    });

    await netns.release();

    expect(fake.removed).toContain("late-sidecar");
    expect(fake.removed).toContain(holderId);
  });

  it("tears the holder down and throws when a tier cannot be installed", async () => {
    const fake = fakeDocker();
    installFirewall.mockRejectedValueOnce(new Error("no NET_ADMIN on this host"));

    await expect(prepare(fake.docker, contained())).rejects.toThrow(/NET_ADMIN/);
    // Not left running: a holder whose firewall never installed is a namespace
    // with unrestricted egress waiting for something to join it.
    expect(fake.removed).toEqual([fake.created[0].id]);
  });
});
