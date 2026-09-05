/**
 * docs/262 req 24, the ENFORCEMENT half, for the two containers that run
 * plugin-authored code outside Compose: the companion-CLI invocation container
 * (`plugin-cli-run.ts`) and the install container (`plugin-install.ts`).
 *
 * Req 24: a plugin's services and CLIs "reach exactly what equivalent same-repo
 * code could reach under the session's user-managed egress configuration, and a
 * plugin declaration never widens a session's network reach by itself."
 *
 * Plugin **services** already satisfied that — they take docs/263's
 * `containComposeServices` path, the same one the project's own services take.
 * These two did not: `ensureUntrustedPluginNetwork` (`plugin-container.ts`)
 * creates a plain NAT bridge and installs no firewall, no resolver and no SNI
 * proxy, so a companion CLI had unrestricted outbound egress while the Plugins
 * card reported its declared hosts against the session's allowlist. This module
 * closes that, and `plugin-hosts.ts`'s docstring — which recorded the gap — is
 * updated in the same change.
 *
 * ## Two boundaries that look alike and are not
 *
 * `ensureUntrustedPluginNetwork` registers the plugin network's subnet as
 * untrusted at ShipIt's own API (`api-container-guard.ts`). That is req **19**'s
 * boundary — a plugin must not reach a fetch credential — and nothing here
 * weakens it: the namespace this module builds lives ON that same network, so a
 * plugin container's packets still leave from a subnet the guard denies, and
 * still leave before the container exists (the registration happens at network
 * creation, not at container start).
 *
 * What was open is req **24**'s boundary: what a plugin can call OUT to.
 *
 * ## Why its own containment rather than the session's
 *
 * Req 24's words point at the session's own egress path, but the two readings of
 * "the session's" that would actually SHARE something are both disqualified, and
 * by req 19 rather than by taste:
 *
 *  - Sharing the agent container's network namespace (`container:<session>`)
 *    makes the worker's loopback this container's own. `/agent-ops/*` is served
 *    to loopback only (`shared/worker-auth.ts`'s `LOOPBACK_ONLY_PREFIXES`,
 *    verified at `worker-auth.ts:69`) and needs no token, so a plugin would get a
 *    real GitHub token out of `shipit-git-credential` with no mount and no
 *    variable changed. `plugin-cli-run.test.ts` asserts against exactly this.
 *  - Joining the session's bridge (`shipit-session-<id>`) gives the container an
 *    address in no registered untrusted subnet, which `api-container-guard.ts`
 *    reads as a browser/host caller — MORE reach than the agent container it was
 *    isolated from. Registering that subnet untrusted instead would deny the
 *    agent its own container-accessible routes.
 *
 * So the container gets its own equivalent containment, configured from the
 * `ContainerSessionManager.resolveEgress` seam `plugin-hosts.ts` already reports
 * the Plugins card from. Same allowlist, same tiers, same enable flags; the
 * enforcement and the card cannot disagree, because they read one answer.
 *
 * **That answer is the config as it is NOW, which is not always the one the
 * agent's own resolver is running** (review finding — the earlier wording here
 * claimed it was, and this feature has shipped that class of claim three times).
 * The agent's resolver and proxy are launched with a snapshot taken at container
 * creation (`container-lifecycle.ts:1079`). `reloadEgress` relaunches them for a
 * **session-scoped** add, so that case stays in step; an **instance-scoped** add
 * and every **removal** reach the agent only at its next start
 * (`api-routes-egress.ts`). For that window a fresh plugin container is ahead of
 * the agent: it permits a host the agent cannot yet resolve, and denies one the
 * agent can still reach.
 *
 * Deliberately not "fixed" by snapshotting a config at session start. Being
 * ahead means honouring the user's most recent decision — a grant they just made,
 * a removal they just made — while a snapshot would make a container created
 * minutes ago run a policy the user has since revoked. And it would put the
 * enforcement out of step with the card, which reads the same live answer. The
 * divergence is with a stale agent, and it closes when the agent restarts.
 *
 * ## The namespace holder
 *
 * Containment must be in place before the plugin's first instruction, and a
 * container that starts on a NAT bridge and is contained afterwards has a window
 * in which it is not. Compose services close that by starting on an `internal`
 * network and installing while PAUSED (`compose-service-egress.ts`), because
 * Compose starts those containers and ShipIt does not.
 *
 * ShipIt creates these two, so it can do better: a **holder** — a trusted
 * ShipIt-run container with no repository code, no mounts and nothing listening
 * — is started on the plugin network, the Tier A/B/C stack is installed into ITS
 * namespace, and only then is the workload created with
 * `NetworkMode: container:<holder>`. The workload therefore has no uncontained
 * instant at all, and there is no pause to be interrupted in.
 *
 * The holder runs the **session-worker image** rather than the sidecar image:
 * it needs only a long-lived process, the worker image is already present
 * wherever these containers run (it is the image the workload uses), and the
 * sidecar image's own entrypoint is the Tier A installer.
 *
 * **What the holder must carry at CREATION, because nothing can add it later.**
 * Tier C's `nat/OUTPUT` REDIRECT of `:443` to the loopback SNI proxy is dropped
 * as a martian unless `net.ipv4.conf.all.route_localnet=1`, and that sysctl is
 * namespaced — it belongs to whoever owns the netns. The installer sidecar
 * cannot set it (Docker keeps its `/proc/sys` read-only, verified at
 * `container-lifecycle.ts:998-1006`, which sets it on the agent container for
 * the same reason), so the holder does. DNS needs nothing here: `--dns` is
 * demoted to an upstream of `127.0.0.11` on a user-defined network, so
 * `init-firewall.sh` REDIRECTs DNS into the in-netns resolver at the iptables
 * layer instead — the agent container leaves `Dns` at Docker's default and so
 * does this.
 *
 * ## Two deliberate differences from the agent's own containment
 *
 *  - **No orchestrator name is resolvable.** The agent's resolver allowlists the
 *    orchestrator host so the worker can call back (`orchestratorInternalNames`).
 *    A plugin container has no callback to make and no route it should have, so
 *    `internalDomains` is empty. Narrower, on purpose.
 *  - **No Tier C decision URL.** The agent's SNI proxy asks
 *    `/api/egress/decision` about a host outside its static allowlist; this
 *    proxy shares the plugin network, where that whole surface is 403 by design
 *    (req 19). planning#371 changed how the SERVICE surface reaches that endpoint —
 *    a Compose service's IP is now denied outright and its proxy is admitted by
 *    a per-sidecar token instead — and changes nothing here: `launchEgressProxy`
 *    mints a token only alongside a decision URL, so this proxy is handed
 *    neither, and the §0 untrusted-subnet denial that covers these two
 *    containers is unchanged and still checked first. Instead the session's
 *    in-memory allow-once hosts are snapshotted
 *    into the static allowlist at launch (`listEgressAllowedHosts`), which is
 *    what keeps this container's reach equal to the agent's — and exactly equal
 *    to what `egressHostReach` reports. A host allowed DURING a call is not
 *    picked up; these containers are short-lived and the next call gets it.
 *
 * ## Three things this does NOT close, stated so the next reader need not re-derive them
 *
 *  - **The plugin networks are shared across sessions**, and Tier A re-opens the
 *    local bridge subnet, so one session's plugin container can address
 *    another's by IP. That was true of the plain NAT bridge before this too —
 *    containment narrows what leaves the bridge, not who is on it. Closing it
 *    means a network per session, which costs a third per-session subnet on a
 *    daemon that already carries `shipit-session-<id>` and `shipit-egress-<id>`.
 *  - **The tier uids must not collide with the workload's** — the firewall's
 *    owner-match exempts uid 911 (resolver) from the DNS lock and uid 912 (proxy)
 *    from the `:443` redirect, so a workload running as either is exempt from the
 *    tier that names it. Plugin containers run as `SHIPIT_SESSION_WORKER_UID`,
 *    and that collision is now refused — but NOT here. It is refused where the
 *    variable is parsed (`session-worker-uid.ts:sessionWorkerUid`, which throws
 *    `ReservedWorkerUidError`, plus the unconditional `assertWorkerUidNotReserved`
 *    at boot in `index.ts`), because the agent container shares the netns
 *    arrangement, the uids and the exposure (`container-lifecycle.ts`): a check on
 *    this path alone would have covered one of the two surfaces that break
 *    together and would have read as protection while the other stayed open.
 *    `assertWorkerUidConsistency` still covers only *rollback drift* and knows
 *    nothing about the range — it resolves the current uid through the same parse,
 *    so it inherits the refusal rather than repeating it.
 *
 *  - **The resolver and proxy are STARTED before the workload, not proven
 *    ready.** `launchEgressResolver` / `launchEgressProxy` return once Docker
 *    reports the container started; their own docstrings say readiness is gated
 *    by the agent's subsequent worker health check, which a plugin container has
 *    no equivalent of (review finding). So a first DNS or TLS request could in
 *    principle reach a redirect whose listener has not bound. This is inherited
 *    rather than introduced: `compose-service-egress.ts` unpauses a service
 *    within milliseconds of the same two launches, whereas the workload here is
 *    still a `createContainer` + `attach` + `start` round trip away — strictly
 *    more slack than a surface already shipping. Worth a real readiness probe
 *    the day it flakes; it would be one more container per invocation and would
 *    fix one of three surfaces.
 *
 * ## Fail closed
 *
 * A contained session whose deployment cannot install containment does not get
 * an uncontained plugin container: {@link preparePluginNetns} throws, and both
 * callers report the refusal. That is the same choice
 * `containComposeServices` makes for a service, and the same one
 * `ensureUntrustedPluginNetwork` already makes for the API boundary.
 */

import type Docker from "dockerode";
import {
  normalizeHost,
  type ResolvedEgressConfig,
} from "./egress-allowlist.js";
import { egressHostReach } from "./egress-host-reach.js";
import {
  buildTierAEgressInputs,
  installEgressFirewall,
} from "./egress-firewall-install.js";
import {
  buildResolverConfigB64,
  launchEgressResolver,
  EGRESS_RESOLVER_LABEL,
} from "./egress-dns-install.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import {
  buildProxyAllowed,
  launchEgressProxy,
  EGRESS_PROXY_LABEL,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_UID,
} from "./egress-proxy-install.js";

/**
 * Stamped on the holder and on every sidecar sharing its namespace, so the
 * boot-time orphan sweep (`reapOrphanPluginInstalls`) can find them by the same
 * liveness-free rule it uses for the workload containers: nothing here outlives
 * the call that created it, so anything still labelled at boot is an orphan.
 */
export const PLUGIN_NETNS_LABEL = "shipit-plugin-netns";

/** Ties a sidecar to the holder whose namespace it entered, for teardown. */
export const PLUGIN_NETNS_PARENT_LABEL = "shipit-plugin-netns-parent";

/** The holder does nothing but exist; it needs almost no memory to do it. */
const HOLDER_MEMORY_BYTES = 64 * 1024 * 1024;
const HOLDER_PIDS_LIMIT = 16;

/**
 * How long the whole holder + Tier A/B/C setup may take. Generous — Tier A
 * resolves its allow-hosts with a bounded DNS pass inside the sidecar — but
 * bounded, because nothing below it is (see {@link preparePluginNetns}).
 */
const DEFAULT_SETUP_TIMEOUT_MS = 90_000;

/**
 * The session's egress posture, as the two plugin container surfaces need it.
 *
 * Read through a thunk at prepare time rather than captured per session, for the
 * reason `createStagedGenerationGate` takes one: the posture is the container
 * manager's answer and can change between a session opening and a companion CLI
 * being invoked half an hour later.
 */
export interface PluginEgressPolicy {
  /**
   * Boot-effective containment (`ContainerSessionManager.isEgressContained`) —
   * whether this deployment enforces at all AND what the live session container
   * actually started with. False means the session denies nothing, so a plugin
   * container that denied something would be reaching LESS than equivalent
   * same-repo code, which req 24 forbids in the same sentence.
   */
  contained: boolean;
  /**
   * `ContainerSessionManager.resolveEgress` — the same `base` + `extraHosts` the
   * session's own resolver and proxy are launched with, and the same pair
   * `egressHostReach` reports the Plugins card from.
   */
  config?: ResolvedEgressConfig | undefined;
  /**
   * The session's in-memory allow-once hosts, snapshotted
   * (`listEgressAllowedHosts`). See the module docstring: this container's proxy
   * cannot ask the decision endpoint, so the answer travels with it.
   */
  allowOnceHosts?: readonly string[];
  /** `SESSION_EGRESS_SIDECAR_IMAGE`. Absent on a contained session → refuse. */
  sidecarImage?: string | undefined;
  /** Tier B on? (`egressDnsEnabled`) — mirrors the session, never overrides it. */
  dnsEnabled: boolean;
  /** Tier C on? (`egressProxyEnabled`) — likewise. */
  proxyEnabled: boolean;
}

/**
 * The posture a runtime with no container manager reports: nothing is contained,
 * because nothing is enforced.
 *
 * Named rather than written inline at each call site so "no policy supplied"
 * cannot quietly become a different answer on one of the two surfaces. It is
 * reached only where there is no Docker at all (local mode, tests) — every
 * production path builds its policy from `ContainerSessionManager`, whose own
 * `isEgressContained` fails closed.
 */
export const UNCONTAINED_PLUGIN_EGRESS: PluginEgressPolicy = {
  contained: false,
  dnsEnabled: false,
  proxyEnabled: false,
};

/**
 * A prepared network namespace for one plugin container.
 *
 * `networkMode` goes straight into `HostConfig.NetworkMode`; `release` tears
 * down whatever was created for it and must run on EVERY path, including the
 * ones where the workload never started.
 */
export interface PluginNetns {
  networkMode: string;
  release(): Promise<void>;
}

export interface PreparePluginNetnsOptions {
  docker: Docker;
  sessionId: string;
  /** The plugin network — already created and registered untrusted. */
  network: string;
  /** The holder's image: the session-worker image (see the module docstring). */
  holderImage: string;
  policy: PluginEgressPolicy;
  /** Deadline for the whole setup. Defaults to {@link DEFAULT_SETUP_TIMEOUT_MS}. */
  setupTimeoutMs?: number;
}

/**
 * Build the namespace a plugin container should run in.
 *
 * Uncontained session → the plugin network itself, which is what these
 * containers have always used and what an uncontained session's own code gets.
 * Contained session → a holder on that same network with the Tier A/B/C stack
 * already installed.
 *
 * Throws when a contained session's containment cannot be installed; the holder
 * and any sidecars are torn down first, so a throw leaves nothing behind.
 *
 * **And it is BOUNDED, which the installers it calls are not.**
 * `installEgressFirewall` awaits `container.wait()` with no deadline. On the
 * agent-creation path that is tolerable — a hung install stalls one session
 * start, visibly. Here it sits in front of a companion-CLI call, and
 * `plugin-container.ts` already worked out why an unbounded wait on this surface
 * is not acceptable: a nominal timeout downstream becomes an unbounded hang
 * holding an agent turn and the repository's activation queue. So the whole
 * setup races a deadline, and a timeout is a refusal like any other.
 */
export async function preparePluginNetns(
  opts: PreparePluginNetnsOptions,
): Promise<PluginNetns> {
  const { policy } = opts;
  if (!policy.contained) {
    return { networkMode: opts.network, release: async () => undefined };
  }
  // Bound to a const, not read off `policy` below: the setup runs inside a
  // closure, where TypeScript drops the narrowing this check just established.
  const sidecarImage = policy.sidecarImage;
  if (!sidecarImage) {
    throw new Error(
      "this session's egress is contained but SESSION_EGRESS_SIDECAR_IMAGE is not set, "
      + "so ShipIt cannot contain a plugin container's network",
    );
  }

  // **Only the plugin labels — deliberately NOT `shipit-parent-session`.** That
  // label is what `compose-cli.ts`'s `killStaleContainers` sweeps: every service
  // start in the session `docker rm -f`s each container carrying it except a
  // resolver/proxy with a live netns parent. A holder carries neither keep-label,
  // so labelling it that way would let any `shipit service start` delete the
  // namespace a running companion CLI is executing in — and take its resolver and
  // proxy with it. The workload containers carry only their own plugin label for
  // the same reason; their reaping is the `finally` below plus the boot sweep
  // (`reapOrphanPluginInstalls`), and these inherit exactly that coverage.
  const labels = { [PLUGIN_NETNS_LABEL]: opts.sessionId };

  const holder = await opts.docker.createContainer({
    Image: opts.holderImage,
    Labels: labels,
    // A process that does nothing and never exits. The image's own ENTRYPOINT
    // prepares a session's mounts and drops privileges; none of that applies,
    // and this container has no mounts to prepare.
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: ["exec sleep infinity"],
    HostConfig: {
      NetworkMode: opts.network,
      // Tier C only, and only settable here — see the module docstring. The
      // workload shares this namespace, so it shares the sysctl.
      ...(policy.proxyEnabled ? { Sysctls: { "net.ipv4.conf.all.route_localnet": "1" } } : {}),
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Memory: HOLDER_MEMORY_BYTES,
      PidsLimit: HOLDER_PIDS_LIMIT,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,size=1m" },
    },
  });

  /**
   * Sidecars first, then the holder — and RETRIED, because the deadline path
   * abandons work that is still running.
   *
   * One pass is enough on every ordinary path (nothing is in flight by the time
   * a caller releases). It is not enough after a timeout: a `createContainer`
   * for a sidecar can cross the deadline, so the sweep can list before that
   * sidecar exists and the holder removal then fails — Docker refuses to remove
   * a container whose namespace another container is borrowing. A second pass
   * sees the sidecar that appeared in between. Bounded at two, because the
   * abandoned continuation creates at most one more container after any given
   * sweep, and the boot sweep is the backstop for anything stranger.
   */
  const release = async (): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      await removeNetnsSidecars(opts.docker, opts.sessionId, holder.id);
      try {
        await holder.remove({ force: true });
        return;
      } catch (err) {
        /* a sidecar is still borrowing the namespace — sweep again */
        lastError = err;
      }
    }
    // Both passes failed, and a leaked HOLDER is worse than a leaked workload:
    // it keeps the Tier B resolver and the Tier C SNI proxy running for nothing.
    // The only thing that reaps it is `reapOrphanPluginInstalls`, which the
    // startup janitor calls at boot alone — sound reasoning that assumes the
    // orphan implies a died process, and this is the case where it does not.
    console.warn(
      `[plugins:${opts.sessionId}] could not remove the plugin netns holder ${holder.id} — `
      + "its egress sidecars keep running until the next orchestrator restart:",
      message(lastError),
    );
  };

  try {
    await withDeadline(opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS, async () => {
    await holder.start();

    const sidecarLabels = { ...labels, [PLUGIN_NETNS_PARENT_LABEL]: holder.id };
    const allowed = allowedHosts(policy);

    // Tier A first and awaited: it installs the default-deny policy and its own
    // `example.com`-must-fail self-test, so a non-zero exit here means the
    // namespace is NOT contained and nothing may run in it.
    await installEgressFirewall(opts.docker, {
      agentContainerId: holder.id,
      sidecarImage,
      inputs: await buildTierAEgressInputs(),
      ...(policy.dnsEnabled ? { resolverUid: EGRESS_RESOLVER_UID } : {}),
      ...(policy.proxyEnabled
        ? { proxyUid: EGRESS_PROXY_UID, proxyPort: EGRESS_PROXY_PORT }
        : {}),
      labels: sidecarLabels,
    });

    if (policy.dnsEnabled) {
      await launchEgressResolver(opts.docker, {
        agentContainerId: holder.id,
        sidecarImage,
        configB64: buildResolverConfigB64({
          // No internal domains and no unqualified forwarding: a plugin
          // container has no orchestrator to call back to, and giving it a name
          // for one is the opposite of what req 19 wants.
          extraDomains: allowed.extras,
          ...(allowed.base ? { base: allowed.base } : {}),
        }),
        labels: { ...sidecarLabels, [EGRESS_RESOLVER_LABEL]: opts.sessionId },
      });
    }

    if (policy.proxyEnabled) {
      await launchEgressProxy(opts.docker, {
        agentContainerId: holder.id,
        sidecarImage,
        allowed: buildProxyAllowed({
          extraHosts: [...allowed.extras],
          ...(allowed.base ? { base: allowed.base } : {}),
        }),
        sessionId: opts.sessionId,
        // No `decisionUrl` on purpose — see the module docstring. Its absence
        // makes an unknown SNI a fast deny rather than a request this container
        // is 403'd for anyway.
        ...(policy.config?.identityRules ? { identityRules: policy.config.identityRules } : {}),
        labels: { ...sidecarLabels, [EGRESS_PROXY_LABEL]: opts.sessionId },
      });
    }
    });
    return { networkMode: `container:${holder.id}`, release };
  } catch (err) {
    await release();
    throw err;
  }
}

/**
 * Run `work`, rejecting once the deadline passes.
 *
 * The abandoned work keeps running — nothing here can interrupt a `wait()` the
 * daemon has not answered — which is exactly why the caller's `release()` is
 * what makes this safe rather than merely prompt: it force-removes the holder,
 * and a `container:`-mode sidecar cannot outlive the namespace it borrowed.
 */
async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`egress containment did not finish within ${Math.round(ms / 1000)}s`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Which of `declared` this session's egress does NOT currently permit — req 24's
 * visibility half, for the one moment the Plugins card cannot cover.
 *
 * The card resolves declared hosts from the **live** generation
 * (`plugin-hosts.ts` → `liveManifestReader`), so a plugin whose very FIRST
 * activation fails has no live generation and therefore no need-rows and no
 * "Allow" buttons. Containing `install` makes that reachable: a plugin whose
 * install pulls from its own vendor host now fails where it used to succeed, and
 * without this the user gets a package-manager DNS error and nothing else — "a
 * surprise or a guessing game", which is the phrase req 24 uses for what must
 * not happen. Naming the hosts in the failure the card DOES show restores the
 * guided step. (The buttons for a never-activated plugin would mean carrying a
 * staged manifest into the degraded state; that is the visibility surface's own
 * work, not this one's.)
 *
 * Answers from `egressHostReach` — the ONE predicate the card, the grant route
 * and the Tier C decision route read — rather than composing the allowlist
 * itself. It composed it here until planning#383, and that made this the fourth
 * surface with its own opinion: on a deployment running `SESSION_EGRESS_DNS=0`
 * the composition is not what the netns admits at all (there is no resolver to
 * pin an allowed name's IPs), so the failure message would OMIT a declared host
 * that the install had genuinely just been blocked from reaching — the same
 * defect as the card's, pointing the other way. Empty for an uncontained
 * session, where nothing is denied.
 */
export function unreachableDeclaredHosts(
  policy: PluginEgressPolicy,
  declared: readonly string[],
): string[] {
  if (!policy.contained || declared.length === 0) return [];
  // The allow-once set travels as a snapshot here, for the reason this whole
  // module exists: this container's proxy cannot ask the decision endpoint.
  const reach = egressHostReach({
    contained: true,
    dnsControlDeployed: policy.dnsEnabled,
    config: policy.config,
    allowOnceHosts: policy.allowOnceHosts,
  });
  return [...new Set(
    declared.map(normalizeHost).filter((host) => host && reach(host) !== "allowed"),
  )];
}

/**
 * The static host set this namespace resolves and dials, split the way the two
 * launchers want it.
 *
 * `base` is passed through rather than defaulted, so a config that means "the
 * full built-in list" stays that and a Network-off sandbox's narrowed lifeline
 * base stays narrowed — the same composition `egressHostReach` and
 * `buildProxyAllowed` already agree on.
 */
function allowedHosts(policy: PluginEgressPolicy): {
  base: readonly string[] | undefined;
  extras: string[];
} {
  return {
    base: policy.config?.base,
    extras: [...(policy.config?.extraHosts ?? []), ...(policy.allowOnceHosts ?? [])],
  };
}

/**
 * Remove every sidecar that entered this holder's namespace.
 *
 * They would die with the holder anyway — a `container:`-mode container cannot
 * outlive its target's namespace — but the resolver and proxy carry
 * `RestartPolicy: on-failure`, so leaving the daemon to notice produces restart
 * churn and a window of `Exited` containers per invocation. Best-effort: a
 * sidecar that cannot be removed is one the holder's own removal takes with it.
 */
async function removeNetnsSidecars(
  docker: Docker,
  sessionId: string,
  holderId: string,
): Promise<void> {
  let entries: Docker.ContainerInfo[];
  try {
    entries = await docker.listContainers({
      all: true,
      filters: { label: [`${PLUGIN_NETNS_LABEL}=${sessionId}`] },
    });
  } catch (err) {
    // Returning is right — the holder's removal is what actually frees the
    // namespace — but a sweep that never listed is also why that removal can
    // then fail, so it must not be the invisible half of the story.
    console.warn(
      `[plugins:${sessionId}] could not list the netns sidecars of holder ${holderId}:`,
      message(err),
    );
    return;
  }
  for (const entry of entries) {
    if (entry.Labels?.[PLUGIN_NETNS_PARENT_LABEL] !== holderId) continue;
    try {
      await docker.getContainer(entry.Id).remove({ force: true });
    } catch (err) {
      /* already gone, or going with the holder — but say so */
      console.warn(
        `[plugins:${sessionId}] could not remove netns sidecar ${entry.Id}:`,
        message(err),
      );
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
