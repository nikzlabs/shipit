import type { CredentialStore } from "../credential-store.js";
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
} from "../../shared/types/mcp-types.js";
import { ServiceError } from "./types.js";

export const MAX_ENABLED_MCP_SERVERS = 10;

const RESERVED_NAMES = new Set(["playwright"]);

// Names become part of mcp__<name>__<KEY> environment keys, so exclude hyphens.
const NAME_RE = /^[a-z][a-z0-9]*$/;

const SHELL_METACHAR_RE = /[;&|`$(){}<>\n\r]/;

export function listMcpServers(credentialStore: CredentialStore): McpServerConfig[] {
  return Object.values(credentialStore.getAllMcpServers()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function validateMcpServerConfig(raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== "object") {
    throw new ServiceError(400, "MCP server config must be an object");
  }
  const cfg = raw as Record<string, unknown>;
  const name = typeof cfg.name === "string" ? cfg.name.trim() : "";
  if (!NAME_RE.test(name)) {
    throw new ServiceError(
      400,
      "MCP server name must be lowercase alphanumeric, starting with a letter (no hyphens)",
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ServiceError(400, `"${name}" is a reserved MCP server name`);
  }
  const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);

  if (cfg.type === "stdio") {
    const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
    if (!command) {
      throw new ServiceError(400, "stdio MCP server requires a command");
    }
    if (SHELL_METACHAR_RE.test(command)) {
      throw new ServiceError(400, "MCP server command must not contain shell metacharacters");
    }
    const args = validateStringArray(cfg.args, "args");
    const env = validateStringRecord(cfg.env, "env");
    const npmPackage =
      typeof cfg.npmPackage === "string" ? cfg.npmPackage.trim() || undefined : undefined;
    const setup = typeof cfg.setup === "string" ? cfg.setup.trim() || undefined : undefined;
    const out: McpStdioServerConfig = { name, type: "stdio", command, enabled };
    if (args) out.args = args;
    if (env) out.env = env;
    if (npmPackage) out.npmPackage = npmPackage;
    if (setup) out.setup = setup;
    return out;
  }

  if (cfg.type === "http") {
    const url = typeof cfg.url === "string" ? cfg.url.trim() : "";
    if (!url) {
      throw new ServiceError(400, "http MCP server requires a url");
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
    } catch {
      throw new ServiceError(400, "http MCP server url must be a valid http(s) URL");
    }
    const headers = validateStringRecord(cfg.headers, "headers");
    const out: McpHttpServerConfig = { name, type: "http", url, enabled };
    if (headers) out.headers = headers;
    return out;
  }

  throw new ServiceError(400, 'MCP server type must be "stdio" or "http"');
}

function validateStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ServiceError(400, `MCP server ${field} must be an array of strings`);
  }
  return value as string[];
}

function validateStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError(400, `MCP server ${field} must be an object`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new ServiceError(400, `MCP server ${field}.${k} must be a string`);
    }
  }
  return value as Record<string, string>;
}

export function validateMcpSecrets(
  serverName: string,
  raw: unknown,
): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ServiceError(400, "secrets must be an object");
  }
  const prefix = `mcp__${serverName}__`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new ServiceError(400, `Secret ${k} must be a string`);
    }
    if (!k.startsWith(prefix) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new ServiceError(
        400,
        `Secret key ${k} must be in the "${prefix}" namespace and a valid env var identifier`,
      );
    }
    out[k] = v;
  }
  return out;
}

function countEnabled(credentialStore: CredentialStore, excludeName?: string): number {
  return Object.values(credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled && s.name !== excludeName,
  ).length;
}

export function addMcpServer(
  credentialStore: CredentialStore,
  rawConfig: unknown,
  rawSecrets: unknown,
): McpServerConfig {
  const config = validateMcpServerConfig(rawConfig);
  if (credentialStore.getMcpServer(config.name)) {
    throw new ServiceError(409, `An MCP server named "${config.name}" already exists`);
  }
  const secrets = validateMcpSecrets(config.name, rawSecrets);
  if (config.enabled && countEnabled(credentialStore) + 1 > MAX_ENABLED_MCP_SERVERS) {
    throw new ServiceError(
      400,
      `Cannot enable more than ${MAX_ENABLED_MCP_SERVERS} MCP servers at once`,
    );
  }
  credentialStore.setMcpServer(config.name, config);
  for (const [k, v] of Object.entries(secrets)) {
    credentialStore.setMcpSecret(k, v);
  }
  return config;
}

/** Push clearedSecretKeys to the worker as empty strings to remove stale environment values. */
export function updateMcpServer(
  credentialStore: CredentialStore,
  id: string,
  rawConfig: unknown,
  rawSecrets: unknown,
): { config: McpServerConfig; clearedSecretKeys: string[] } {
  const existing = credentialStore.getMcpServer(id);
  if (!existing) {
    throw new ServiceError(404, `MCP server "${id}" not found`);
  }
  const config = validateMcpServerConfig(rawConfig);
  const isRename = config.name !== id;
  if (isRename && credentialStore.getMcpServer(config.name)) {
    throw new ServiceError(409, `An MCP server named "${config.name}" already exists`);
  }
  const secrets = validateMcpSecrets(config.name, rawSecrets);

  if (config.enabled && countEnabled(credentialStore, id) + 1 > MAX_ENABLED_MCP_SERVERS) {
    throw new ServiceError(
      400,
      `Cannot enable more than ${MAX_ENABLED_MCP_SERVERS} MCP servers at once`,
    );
  }

  const clearedSecretKeys: string[] = [];
  if (isRename) {
    const prefix = `mcp__${id}__`;
    for (const key of Object.keys(credentialStore.getAllAgentEnv())) {
      if (key.startsWith(prefix)) clearedSecretKeys.push(key);
    }
    credentialStore.deleteMcpServer(id);
    credentialStore.deleteMcpSecretsForServer(id);
  }

  credentialStore.setMcpServer(config.name, config);
  for (const [k, v] of Object.entries(secrets)) {
    credentialStore.setMcpSecret(k, v);
  }
  return { config, clearedSecretKeys };
}

export function removeMcpServer(
  credentialStore: CredentialStore,
  id: string,
): { clearedSecretKeys: string[] } {
  if (!credentialStore.getMcpServer(id)) {
    throw new ServiceError(404, `MCP server "${id}" not found`);
  }
  const prefix = `mcp__${id}__`;
  const clearedSecretKeys = Object.keys(credentialStore.getAllAgentEnv()).filter((k) =>
    k.startsWith(prefix),
  );
  credentialStore.deleteMcpServer(id);
  credentialStore.deleteMcpSecretsForServer(id);
  return { clearedSecretKeys };
}
