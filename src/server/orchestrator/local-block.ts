/**
 * Whether this host can keep session containers away from the host, private
 * networks and the tailnet, and what ShipIt does when it cannot
 * (docs/319-api-reach-through-host).
 */
import fs from "node:fs/promises";
import type Docker from "dockerode";
import { isValidIp } from "./egress-firewall.js";

const HOST_ADDRESS_TTL_MS = 60_000;
const HELPER_TIMEOUT_MS = 30_000;

interface LocalBlockState {
  active: boolean;
  reason: string;
  dockerDesktop?: boolean;
}

let state: LocalBlockState = { active: false, reason: "not probed" };
let hostAddressCache: { at: number; addresses: string[] } | null = null;

/** True once the startup probe has passed; every session container then gets the block. */
export function localBlockActive(): boolean {
  return state.active;
}

export function localBlockReason(): string {
  return state.reason;
}

export function _setLocalBlockForTest(active: boolean, reason = "test"): void {
  state = { active, reason };
  hostAddressCache = null;
}

async function runHelper(
  docker: Docker,
  opts: { image: string; entrypoint: string[]; networkMode: string; capAdd?: string[] },
): Promise<{ code: number; output: string }> {
  const container = await docker.createContainer({
    Image: opts.image,
    Entrypoint: opts.entrypoint,
    Labels: { "shipit-local-block-helper": "true" },
    HostConfig: {
      NetworkMode: opts.networkMode,
      ...(opts.capAdd ? { CapAdd: opts.capAdd } : {}),
      AutoRemove: false,
    },
  });
  try {
    await container.start();
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      container.wait() as Promise<{ StatusCode?: number }>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("helper container did not finish")), HELPER_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const logs = await container.logs({ stdout: true, stderr: true });
    return { code: result.StatusCode ?? -1, output: demux(logs) };
  } finally {
    try { await container.remove({ force: true }); } catch { /* already gone */ }
  }
}

// Non-TTY logs arrive as 8-byte-framed stdout/stderr chunks.
function demux(raw: Buffer | string): string {
  if (typeof raw === "string") return raw;
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4);
    parts.push(raw.subarray(offset + 8, offset + 8 + size).toString("utf-8"));
    offset += 8 + size;
  }
  return offset === 0 ? raw.toString("utf-8") : parts.join("");
}

/** Runs `probe-firewall.sh` in a namespace of its own; false on any failure. */
export async function probeLocalBlock(docker: Docker, sidecarImage: string): Promise<boolean> {
  try {
    const { code } = await runHelper(docker, {
      image: sidecarImage,
      entrypoint: ["/usr/local/bin/probe-firewall.sh"],
      networkMode: "none",
      capAdd: ["NET_ADMIN"],
    });
    return code === 0;
  } catch {
    return false;
  }
}

export async function initLocalBlock(docker: Docker, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const image = env.SESSION_EGRESS_SIDECAR_IMAGE;
  if (!image) {
    state = { active: false, reason: "no egress sidecar image is configured (SESSION_EGRESS_SIDECAR_IMAGE)" };
  } else if (await probeLocalBlock(docker, image)) {
    state = { active: true, reason: "the egress sidecar can install firewall rules on this host" };
  } else {
    state = { active: false, reason: "this host refused the egress sidecar's firewall rules (NET_ADMIN)" };
  }
  if (!state.active) state.dockerDesktop = await isDockerDesktop(docker);
  console.log(`[local-block] ${state.active ? "active" : "NOT active"}: ${state.reason}`);
  return state.active;
}

/**
 * Docker Desktop lets every container reach the host's loopback, so without the
 * block ShipIt starts no session container there (req 1, req 3). Null when
 * session containers may start.
 */
export function sessionContainerRefusal(): string | null {
  if (state.active || !state.dockerDesktop) return null;
  return "ShipIt cannot start session containers on this Docker Desktop install: "
    + `${state.reason}, and on Docker Desktop every container can reach this computer's `
    + "loopback, where ShipIt listens. See docs/319-api-reach-through-host.";
}

/** Global addresses from `ip -o addr show`; loopback and link-local are covered elsewhere. */
export function parseHostAddresses(output: string): string[] {
  const out = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /\binet6?\s+([0-9a-fA-F:.]+)\/\d+/.exec(line);
    const addr = match?.[1];
    if (!addr || !isValidIp(addr)) continue;
    if (addr.startsWith("127.") || addr === "::1" || /^fe[89ab]/i.test(addr)) continue;
    out.add(addr);
  }
  return [...out].sort();
}

/**
 * The host's own addresses, read in the host network namespace. Throws when
 * they cannot be read: a firewall without them would leave the host's public
 * address open, so the caller fails closed.
 */
export async function hostAddresses(
  docker: Docker,
  sidecarImage: string,
  now: () => number = Date.now,
): Promise<string[]> {
  if (hostAddressCache && now() - hostAddressCache.at < HOST_ADDRESS_TTL_MS) return hostAddressCache.addresses;
  const { code, output } = await runHelper(docker, {
    image: sidecarImage,
    entrypoint: ["ip", "-o", "addr", "show"],
    networkMode: "host",
  });
  if (code !== 0) throw new Error(`could not read the host's addresses (exit ${code})`);
  const addresses = parseHostAddresses(output);
  hostAddressCache = { at: now(), addresses };
  return addresses;
}

function isLoopbackHostIp(hostIp: string): boolean {
  const ip = hostIp.trim();
  return ip.startsWith("127.") || ip === "::1" || ip === "localhost";
}

/** Every published binding on an address other than loopback, as `address:port`. */
export function nonLoopbackBindings(inspect: unknown): string[] {
  const info = inspect as {
    NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
    HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
  };
  const out = new Set<string>();
  for (const map of [info.NetworkSettings?.Ports, info.HostConfig?.PortBindings]) {
    for (const bindings of Object.values(map ?? {})) {
      for (const binding of bindings ?? []) {
        const hostIp = binding.HostIp ?? "";
        if (isLoopbackHostIp(hostIp)) continue;
        out.add(`${hostIp || "0.0.0.0"}:${binding.HostPort ?? "?"}`);
      }
    }
  }
  return [...out].sort();
}

/**
 * Req 6: without the block, ShipIt is reachable only on loopback. It cannot
 * close one published binding and keep the others, so it refuses to start.
 */
export async function assertLoopbackOnlyWithoutBlock(
  docker: Docker,
  readOwnId: () => Promise<string> = async () => (await fs.readFile("/etc/hostname", "utf-8")).trim(),
): Promise<void> {
  if (state.active) return;
  let inspect: unknown;
  try {
    inspect = await docker.getContainer(await readOwnId()).inspect();
  } catch {
    // Not running in a container of its own, so nothing is published for it.
    return;
  }
  const bindings = nonLoopbackBindings(inspect);
  if (bindings.length === 0) return;
  throw new Error(
    `ShipIt refuses to start: it is published on ${bindings.join(", ")}, but ${state.reason}, `
    + "so a session could reach ShipIt through that address as if it were you. "
    + "Publish ShipIt on loopback only (unset SHIPIT_BIND_ADDR and SHIPIT_TAILNET_BIND in the install's "
    + ".shipit.env, then run update.sh), or run it on a host that can run the egress sidecar. "
    + "See docs/319-api-reach-through-host.",
  );
}

/** Docker Desktop lets containers reach the host's loopback, so loopback alone protects nothing there. */
export async function isDockerDesktop(docker: Docker): Promise<boolean> {
  try {
    const info = await docker.info() as { OperatingSystem?: string };
    return /docker desktop/i.test(info.OperatingSystem ?? "");
  } catch {
    return false;
  }
}
