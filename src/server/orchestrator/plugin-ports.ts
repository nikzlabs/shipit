/**
 * docs/262 req 18 — a plugin service's **published port**, pinned per
 * (session, service) for the session's whole life.
 *
 * ## Why a pin exists at all
 *
 * A preview origin is `{sessionId}--{port}.<host>` (`preview-proxy.ts`), so the
 * port IS part of the origin, and req 18 makes the origin stable so that
 * origin-keyed browser storage counts as session-scoped state. A plugin's
 * compose fragment is versioned with the plugin, and a tracked-branch commit
 * (req 12) may edit its port — which without a pin would silently move every
 * consuming session's origin and orphan whatever the plugin had stored there.
 *
 * ## Published is not the same as container
 *
 * Nothing here binds a host port. ShipIt strips `ports:` from every service it
 * runs (`generateComposeOverride`'s `!reset []`) and reaches containers by IP on
 * the session network, so a "published port" is purely ShipIt's routing key: the
 * number in the preview subdomain, which the proxy resolves to
 * `containerIp:<the service's real container port>`. That indirection is what
 * lets the pin hold while the fragment's port moves — the origin stays put and
 * the traffic follows the container.
 *
 * ## Where it lives, and why not the state dir
 *
 * `<sessionDir>/plugin-ports.json`, a sibling of `workspace/` and `plugin-data/`
 * — the same placement decision `plugin-state.ts` documents at length. The
 * session STATE dir is in `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts`) and is
 * deleted by archive and disk-tier eviction *because* everything in it can be
 * rebuilt. A pin cannot be rebuilt: rebuilding it is precisely the origin change
 * req 18 forbids. A full reset or a session delete still takes it, which is the
 * lifetime req 18 asks for.
 */

import fs from "node:fs";
import path from "node:path";

/** Durable per-session pin file. */
export const PLUGIN_PORTS_FILE = "plugin-ports.json";

/**
 * Where freshly allocated published ports come from when a service's own
 * declared port is already taken.
 *
 * High, and deliberately outside the range dev servers pick for themselves, so
 * an allocated number does not read as "the service is served on 3000" to
 * someone looking at the URL. Nothing binds it (see the module note), so the
 * only requirement is that it is a legal port and unique within the session.
 */
export const PLUGIN_PORT_BAND_START = 42_000;
const PLUGIN_PORT_BAND_END = 65_000;

export interface PublishedPortRequest {
  /** The SURFACED service name — the one the session addresses it by. */
  service: string;
  /**
   * The port the service's own definition serves on. Required: a service that
   * declares none is not previewable, and giving it a published port would
   * advertise an origin with nothing behind it.
   */
  containerPort: number;
}

export function pluginPortsPath(sessionDir: string): string {
  return path.join(sessionDir, PLUGIN_PORTS_FILE);
}

/**
 * Resolve one published port per request, reusing this session's existing pins.
 *
 * `reserved` is every port that is already spoken for by something this store
 * does not own — in practice the project's own services, whose port IS their
 * origin and their real container port. A pin that lands on one of those is
 * **re-allocated**: the project's preview must keep working, and of the two only
 * the plugin's origin is ShipIt's own bookkeeping to move. That is the single
 * case where a pin does not hold, and it takes a project compose edit to reach.
 *
 * Never throws. An unreadable or unwritable store degrades to in-memory
 * allocation for this round — the ports are still coherent *now*, they just may
 * not survive a restart, which is strictly better than no services at all
 * (req 13).
 */
export function resolvePublishedPorts(
  sessionDir: string,
  requests: readonly PublishedPortRequest[],
  reserved: ReadonlySet<number> = new Set(),
): Map<string, number> {
  const store = readStore(sessionDir);
  const assigned = new Map<string, number>();
  const taken = new Set<number>(reserved);

  // Pass 1: honor every pin that is still usable. Done before any allocation so
  // a new service can never take a port an existing one is pinned to.
  for (const { service } of requests) {
    const pinned = store[service];
    if (typeof pinned !== "number" || !isUsablePort(pinned) || taken.has(pinned)) continue;
    assigned.set(service, pinned);
    taken.add(pinned);
  }

  // Pass 2: allocate for the rest — the service's own declared port when it is
  // free (the ordinary case, so the origin reads like the service's own port),
  // otherwise the first free number in the band.
  for (const { service, containerPort } of requests) {
    if (assigned.has(service)) continue;
    const port = isUsablePort(containerPort) && !taken.has(containerPort)
      ? containerPort
      : allocate(taken);
    if (port === null) continue; // band exhausted — the caller drops the service
    assigned.set(service, port);
    taken.add(port);
  }

  writeStoreIfChanged(sessionDir, store, assigned);
  return assigned;
}

function allocate(taken: ReadonlySet<number>): number | null {
  for (let port = PLUGIN_PORT_BAND_START; port <= PLUGIN_PORT_BAND_END; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}

function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65_536;
}

function readStore(sessionDir: string): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pluginPortsPath(sessionDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Null-prototype: the keys are service names out of a third-party fragment,
    // so `constructor` and friends are reachable spellings.
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number") out[name] = value;
    }
    return out;
  } catch {
    return Object.create(null) as Record<string, number>;
  }
}

/**
 * Persist the round's assignments, merged over what was already recorded.
 *
 * **Merged, not replaced**: a service the declaration no longer names keeps its
 * pin, so a `use:` entry removed and added back inside one session finds the
 * origin it had. That is the same asymmetry `plugin-state.ts` applies to a
 * dropped import's state directory, for the same reason — the session, not the
 * declaration, is what req 18 scopes this to.
 *
 * The write is skipped when nothing changed, so the ordinary round (every
 * session activation, every `shipit.yaml` edit) touches no disk at all.
 */
function writeStoreIfChanged(
  sessionDir: string,
  store: Record<string, number>,
  assigned: ReadonlyMap<string, number>,
): void {
  let changed = false;
  for (const [service, port] of assigned) {
    if (store[service] === port) continue;
    store[service] = port;
    changed = true;
  }
  if (!changed) return;
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(pluginPortsPath(sessionDir), `${JSON.stringify(store, null, 2)}\n`);
  } catch (err) {
    // In-memory assignments still hold for this round; only their durability is
    // lost. Saying so beats a session with no plugin previews (req 13).
    console.warn(
      `[plugins] could not record published ports in ${sessionDir}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
