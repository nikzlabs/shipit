/**
 * docs/262 — the primitives every container that runs plugin-authored code
 * shares: the network it joins, and how ShipIt waits for it.
 *
 * Both were `plugin-install.ts`'s and are here because the CLI invocation
 * container (`plugin-cli-run.ts`) has the identical problems. Neither is the
 * kind of thing to transcribe twice: the network one is a security control, and
 * the wait one has a subtlety (the bounded reap) that a second copy would get
 * wrong.
 *
 * ## The network
 *
 * **"Not the session's network" is not enough.** Plugin code needs outbound
 * access (`npm ci` fetches; a companion CLI may call the API it exists to
 * call), outbound includes the host gateway, and ShipIt's own API is published
 * there. `api-container-guard.ts` identifies a container by its source IP and
 * reads *anything it does not recognise* as a browser or host caller — so a
 * plugin container on the default bridge would have MORE API reach than the
 * agent container it was isolated from: list sessions, then ask
 * `/api/sessions/<id>/git/credential`, which returns a real GitHub token.
 *
 * So each kind gets a network of its own whose whole subnet is declared
 * untrusted **before the first container joins it** — registering a container's
 * address after it starts leaves the first request unguarded, and that request
 * is precisely the one worth making. It **fails closed**: a subnet ShipIt
 * cannot deny means nothing runs.
 *
 * **"Cannot deny" includes a subnet of the wrong address family.** The guard's
 * CIDR match is IPv4-only, so on a dual-stack network the container's IPv6
 * address falls in no registered CIDR — which the guard reads as a
 * browser/host caller, i.e. the exact escalation this module exists to
 * prevent. Requiring only *some* IPv4 subnet would pass such a network, so
 * every reported subnet has to be registerable, and the network ShipIt creates
 * is pinned IPv4-only so a daemon default cannot make it dual-stack; the check
 * covers the network ShipIt did not create (a leftover from an earlier boot).
 *
 * **This is a latent hole, not a live one, and the distinction is recorded so
 * nobody "fixes" the wrong end of it** (review finding): the orchestrator binds
 * `0.0.0.0` (`app-lifecycle.ts`), so there is no IPv6 listener to reach today.
 * What the check buys is that the day the listener, a proxy, or the deployment
 * topology gains IPv6, the boundary does not open silently — which is the same
 * bet the subnet-before-container ordering above makes. Teaching
 * `api-container-guard.ts` to match IPv6 CIDRs closes it from the other side,
 * and is the better fix the day a plugin container legitimately needs IPv6:
 * this one refuses such a network outright, so an IPv6-only dependency is
 * unreachable from plugin code until then.
 */

import type Docker from "dockerode";
import { registerUntrustedContainerNetwork } from "./api-container-guard.js";

/**
 * Create the network if it does not exist, and declare its subnet untrusted to
 * the orchestrator's API guard.
 *
 * Idempotent and cheap to repeat: an existing network is inspected rather than
 * recreated, and registration is a set insert. Throws when the network cannot
 * be made deniable — the caller must treat that as "do not start the
 * container".
 */
export async function ensureUntrustedPluginNetwork(
  docker: Docker,
  name: string,
): Promise<void> {
  let info: { IPAM?: { Config?: { Subnet?: string }[] } };
  try {
    info = await docker.getNetwork(name).inspect();
  } catch {
    try {
      // IPv4-only, explicitly: a daemon configured to hand new bridges an IPv6
      // subnet would otherwise give every plugin container an address the guard
      // cannot match, and this call is the only chance to say otherwise.
      await docker.createNetwork({ Name: name, Driver: "bridge", EnableIPv6: false });
    } catch (err) {
      // A concurrent create is fine — the inspect below settles it either way.
      if (errStatus(err) !== 409) throw err;
    }
    info = await docker.getNetwork(name).inspect();
  }

  const subnets = (info.IPAM?.Config ?? [])
    .map((c) => c.Subnet)
    .filter((s): s is string => Boolean(s));
  // Registration runs for every subnet first: throwing below leaves the ones
  // that DID register in place, which is never less safe than skipping them.
  const undeniable = subnets.filter((s) => !registerUntrustedContainerNetwork(s));
  if (subnets.length === 0 || undeniable.length === subnets.length) {
    throw new Error(
      `network ${name} has no IPv4 subnet to deny `
      + `(saw ${subnets.length > 0 ? subnets.join(", ") : "none"})`,
    );
  }
  if (undeniable.length > 0) {
    throw new Error(
      `network ${name} carries a subnet ShipIt cannot deny at its own API `
      + `(${undeniable.join(", ")}) — remove the network so it is recreated IPv4-only`,
    );
  }
}

/**
 * Re-register the subnets of plugin networks that ALREADY exist, at boot,
 * before the API accepts a request.
 *
 * **The registry is process memory** (`api-container-guard.ts`'s
 * `untrustedCidrs`), while the networks and the containers on them are the
 * daemon's and outlive any one orchestrator. So a crash or a restart with a
 * plugin container still running left the replacement process with an EMPTY set:
 * the container survives, its subnet is unknown, and `api-container-guard.ts`
 * reads its packets as a browser/host caller — the most trusted class there is.
 * A companion CLI that simply polls the host gateway across a restart could then
 * enumerate sessions and ask `/api/sessions/<id>/git/credential` for a real
 * GitHub token, which is exactly what req 19 forbids.
 *
 * Nothing already closed that. The boot orphan sweep
 * (`reapOrphanPluginInstalls`) would remove the container, but it runs inside
 * the fire-and-forget disk janitor (`startup-monitors.ts`) and is deliberately
 * paced, so the API is listening long before it arrives — and it defers to the
 * next boot on any Docker error. And `ensureUntrustedPluginNetwork` re-registers
 * only when the next plugin operation happens to run.
 *
 * This is the deterministic half: cheap (one inspect per network), synchronous
 * with respect to accepting traffic, and idempotent. It deliberately does NOT
 * create anything — a deployment that has never run a plugin has no network to
 * register, and creating one at every boot would be a bridge per install for
 * nothing. A network that exists but cannot be denied is logged and left to
 * {@link ensureUntrustedPluginNetwork}'s fail-closed refusal at first use, which
 * is the same verdict reached one step later.
 */
export async function registerExistingPluginNetworks(
  docker: Docker,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    let info: { IPAM?: { Config?: { Subnet?: string }[] } };
    try {
      info = await docker.getNetwork(name).inspect();
    } catch {
      continue; // never created on this host, or the daemon is unavailable
    }
    const subnets = (info.IPAM?.Config ?? [])
      .map((c) => c.Subnet)
      .filter((s): s is string => Boolean(s));
    const undeniable = subnets.filter((s) => !registerUntrustedContainerNetwork(s));
    if (undeniable.length > 0) {
      console.warn(
        `[plugins] network ${name} carries ${undeniable.length} subnet(s) ShipIt cannot deny at its own API `
        + `(${undeniable.join(", ")}); plugin containers on it will be refused at first use`,
      );
    }
  }
}

function errStatus(err: unknown): number {
  return err && typeof err === "object" && "statusCode" in err
    ? (err as { statusCode: number }).statusCode
    : 0;
}

// ---------------------------------------------------------------------------
// Waiting for a plugin container
// ---------------------------------------------------------------------------

/** How often the wait loop notices a timeout or a disposed session. */
const CANCELLATION_POLL_MS = 2_000;
/** How long to wait for a killed container to actually be gone. */
const REAP_GRACE_MS = 10_000;

/** Sentinel for "the poll slice elapsed" — an exit result is always an object. */
const TICK = "tick" as const;

/**
 * Wait for the container, stopping it when it outstays the timeout or when its
 * session goes away.
 *
 * Exported and shared with the CLI invocation container
 * (`plugin-cli-run.ts`): the bounded-reap subtlety below is exactly the kind of
 * detail a second transcription gets wrong.
 *
 * **The post-kill wait is bounded too.** The obvious shape — kill, then await
 * the same `wait()` promise — assumes the kill worked. A kill that fails (a
 * daemon hiccup, a container in a state Docker will not signal) leaves that
 * promise unresolved forever, and a nominal ten-minute timeout becomes an
 * unbounded hang holding the repository's activation queue and the generation's
 * volume. So the reap has its own deadline, and the caller treats "stopped, we
 * think" as a failure either way.
 */
export async function waitForContainerExit(
  container: Docker.Container,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<number | "timeout" | "cancelled"> {
  const wait = container.wait() as Promise<{ StatusCode?: number }>;
  // Attached immediately: `wait` is raced below, so an early rejection with
  // nothing listening would surface as an unhandled rejection.
  const settled = wait.catch(() => ({ StatusCode: -1 }));

  const started = Date.now();
  let stopReason: "timeout" | "cancelled" | null = null;
  while (stopReason === null) {
    const slice = Math.min(CANCELLATION_POLL_MS, Math.max(0, timeoutMs - (Date.now() - started)));
    const outcome = await Promise.race([settled, tickAfter(slice)]);
    if (outcome !== TICK) return outcome.StatusCode ?? -1;
    if (isCancelled?.()) stopReason = "cancelled";
    else if (Date.now() - started >= timeoutMs) stopReason = "timeout";
  }

  // Kill, then reap — but never wait on the kill having worked.
  await container.kill().catch(() => undefined);
  await Promise.race([settled, sleep(REAP_GRACE_MS)]);
  return stopReason;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `sleep`, resolving to the poll sentinel so it can be raced against an exit. */
async function tickAfter(ms: number): Promise<typeof TICK> {
  await sleep(ms);
  return TICK;
}
