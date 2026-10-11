import { resolveShipitConfig } from "../shared/shipit-config.js";
import { serviceMcpUrl } from "../shared/service-mcp.js";
import type { ServiceMcpServer } from "../shared/types/mcp-types.js";
import type { PluginComposeService } from "./plugin-compose.js";

/**
 * docs/327-service-mcp-servers — the MCP servers a session's agent gets: the
 * project's own, then the plugins'. A project server wins a name over a plugin's.
 * Null when shipit.yaml cannot be read, so an edit in progress changes nothing.
 */
export function resolveServiceMcpServers(
  workspaceDir: string,
  plugins: { pluginMcpServers(): ServiceMcpServer[] } | null,
): ServiceMcpServer[] | null {
  let config;
  try {
    config = resolveShipitConfig(workspaceDir);
  } catch {
    return null;
  }
  const servers: ServiceMcpServer[] = config.mcp.map((m) => ({
    name: m.name,
    url: serviceMcpUrl(m.service, m.port, m.path),
  }));
  const taken = new Set(servers.map((s) => s.name.toLowerCase()));
  for (const server of plugins?.pluginMcpServers() ?? []) {
    if (taken.has(server.name.toLowerCase())) continue;
    taken.add(server.name.toLowerCase());
    servers.push(server);
  }
  return servers;
}

/** The URL is the service's compose name, which the session network resolves, and the consumer's port. */
export function pluginServiceMcpServers(services: readonly PluginComposeService[]): ServiceMcpServer[] {
  return services.flatMap((svc) =>
    svc.mcp && svc.port !== undefined
      ? [{ name: svc.mcp.name, url: serviceMcpUrl(svc.name, svc.port, svc.mcp.path) }]
      : []);
}

/**
 * The set each session's agent was spawned with. A resident process keeps the
 * servers it started with, so a later set retires it (`resident-spawn-guard.ts`).
 * Recorded in `buildAgentRunParams`, which every spawn goes through; a session
 * with no record (an adopted process) is left alone until its next spawn.
 */
const spawnedWith = new Map<string, string>();

export function serviceMcpSetKey(servers: readonly ServiceMcpServer[]): string {
  return JSON.stringify(
    [...servers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => [s.name, s.url]),
  );
}

export function recordServiceMcpSpawn(sessionId: string, servers: readonly ServiceMcpServer[]): void {
  spawnedWith.set(sessionId, serviceMcpSetKey(servers));
}

export function serviceMcpSpawnKey(sessionId: string): string | undefined {
  return spawnedWith.get(sessionId);
}

export function forgetServiceMcpSpawn(sessionId: string): void {
  spawnedWith.delete(sessionId);
}
