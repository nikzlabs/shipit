import { getMessage } from "./disk-utils.js";

interface AddressPool {
  Base?: string;
  Size?: number;
}

interface AddressPoolDocker {
  info(): Promise<unknown>;
}

// With no pool configured the daemon has 172.17.0.0/16 to 172.31.0.0/16 whole, and
// 192.168.0.0/16 cut into /20s.
export const BUILT_IN_POOL_NETWORKS = 31;

/**
 * How many IPv4 networks the daemon's default address pools hold, or null when a configured pool
 * cannot be read. `docker info` reports only configured pools.
 */
export function addressPoolNetworks(pools: readonly AddressPool[] | null | undefined): number | null {
  const ipv4 = (pools ?? []).filter((pool) => !pool.Base?.includes(":"));
  if (ipv4.length === 0) return BUILT_IN_POOL_NETWORKS;
  let total = 0;
  for (const pool of ipv4) {
    const prefix = Number(pool.Base?.split("/")[1]);
    const size = Number(pool.Size);
    if (!Number.isInteger(prefix) || !Number.isInteger(size) || size < prefix || size > 32) return null;
    total += 2 ** (size - prefix);
  }
  return total;
}

/**
 * ShipIt asks for no subnet size, so each session and egress network takes one network of the
 * pool: two per contained session with a preview, and the warm pool starts previews too. The VPS
 * setup script widens the pool; a local install has the daemon's default unless its user did.
 */
export async function warnIfAddressPoolIsSmall(docker: AddressPoolDocker): Promise<void> {
  let networks: number | null;
  try {
    const info = await docker.info() as { DefaultAddressPools?: AddressPool[] | null };
    networks = addressPoolNetworks(info.DefaultAddressPools);
  } catch (err) {
    console.warn("[server] could not read Docker's default address pools:", getMessage(err));
    return;
  }
  if (networks === null || networks > BUILT_IN_POOL_NETWORKS) return;
  console.warn(
    `[server] Docker's default address pools hold about ${networks} networks, and ShipIt uses up `
    + "to two for each session with a preview. When they are all in use, a preview fails to start "
    + 'with "all predefined address pools have been fully subnetted". To widen the pool, add '
    + '{"default-address-pools": [{"base": "172.16.0.0/12", "size": 24}]} to the Docker daemon '
    + "configuration and restart Docker (Docker Desktop: Settings → Docker Engine; "
    + "Docker Engine on Linux: /etc/docker/daemon.json).",
  );
}
