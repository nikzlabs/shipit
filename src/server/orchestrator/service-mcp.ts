import { resolveShipitConfig } from "../shared/shipit-config.js";
import { mcpServerNameError, serviceMcpUrl } from "../shared/service-mcp.js";
import type { ServiceMcpServer } from "../shared/types/mcp-types.js";
import type { PluginComposeService } from "./plugin-compose.js";

export interface SessionServiceMcp {
  servers: ServiceMcpServer[];
  /**
   * The names a plugin's server can still take: a plugin's version can go live
   * after the agent started, and the agent's tool allowlist is fixed at its start.
   */
  candidates: string[];
}

/**
 * docs/327-service-mcp-servers — the MCP servers a session's agent gets: the
 * project's own, then the plugins'. A project server wins a name over a plugin's.
 * Null when shipit.yaml cannot be read, so an edit in progress changes nothing.
 */
export function resolveServiceMcp(
  workspaceDir: string,
  plugins: { pluginMcpServers(): ServiceMcpServer[] } | null,
): SessionServiceMcp | null {
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
  const candidates = [...new Set(config.plugins.uses.map((u) => u.plugin))]
    .filter((name) => mcpServerNameError(name) === null);
  return { servers, candidates };
}

/** The URL is the service's compose name, which the session network resolves, and the consumer's port. */
export function pluginServiceMcpServers(services: readonly PluginComposeService[]): ServiceMcpServer[] {
  return services.flatMap((svc) =>
    svc.mcp && svc.port !== undefined
      ? [{ name: svc.mcp.name, url: serviceMcpUrl(svc.name, svc.port, svc.mcp.path) }]
      : []);
}

/**
 * The set each session's agent process holds. A resident process keeps its
 * servers across turns, so a set it could not take while it runs retires it at
 * the next turn (`resident-spawn-guard.ts`). Written in `buildAgentRunParams`,
 * which every spawn goes through, and by `ContainerSessionRunner.syncServiceMcp`
 * from what the worker reports. A session with no record is left alone.
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
