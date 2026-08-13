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
 * is precisely the one worth making. It **fails closed**: no registerable IPv4
 * subnet, nothing runs.
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
      await docker.createNetwork({ Name: name, Driver: "bridge" });
    } catch (err) {
      // A concurrent create is fine — the inspect below settles it either way.
      if (errStatus(err) !== 409) throw err;
    }
    info = await docker.getNetwork(name).inspect();
  }

  const subnets = (info.IPAM?.Config ?? [])
    .map((c) => c.Subnet)
    .filter((s): s is string => Boolean(s));
  const registered = subnets.filter((s) => registerUntrustedContainerNetwork(s));
  if (registered.length === 0) {
    throw new Error(
      `network ${name} has no IPv4 subnet to deny `
      + `(saw ${subnets.length > 0 ? subnets.join(", ") : "none"})`,
    );
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
