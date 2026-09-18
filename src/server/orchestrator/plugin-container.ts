import type Docker from "dockerode";
import { registerUntrustedContainerNetwork } from "./api-container-guard.js";

// Register every subnet before containers join: unknown source IPs are trusted by the API guard.
export async function ensureUntrustedPluginNetwork(
  docker: Docker,
  name: string,
): Promise<void> {
  let info: { IPAM?: { Config?: { Subnet?: string }[] } };
  try {
    info = await docker.getNetwork(name).inspect();
  } catch {
    try {
      // The guard cannot match IPv6 CIDRs.
      await docker.createNetwork({ Name: name, Driver: "bridge", EnableIPv6: false });
    } catch (err) {
      if (errStatus(err) !== 409) throw err;
    }
    info = await docker.getNetwork(name).inspect();
  }

  const subnets = (info.IPAM?.Config ?? [])
    .map((c) => c.Subnet)
    .filter((s): s is string => Boolean(s));
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

// Restore the in-memory registry before accepting traffic; Docker networks survive restarts.
export async function registerExistingPluginNetworks(
  docker: Docker,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    let info: { IPAM?: { Config?: { Subnet?: string }[] } };
    try {
      info = await docker.getNetwork(name).inspect();
    } catch {
      continue;
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

const CANCELLATION_POLL_MS = 2_000;
const REAP_GRACE_MS = 10_000;
const TICK = "tick" as const;

export async function waitForContainerExit(
  container: Docker.Container,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<number | "timeout" | "cancelled"> {
  const wait = container.wait() as Promise<{ StatusCode?: number }>;
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

  // Bound the reap in case kill fails and wait never settles.
  await container.kill().catch(() => undefined);
  await Promise.race([settled, sleep(REAP_GRACE_MS)]);
  return stopReason;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tickAfter(ms: number): Promise<typeof TICK> {
  await sleep(ms);
  return TICK;
}
