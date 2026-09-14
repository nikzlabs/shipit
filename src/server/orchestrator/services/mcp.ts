import type { CredentialStore } from "../credential-store.js";
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
} from "../../shared/types/mcp-types.js";
import { secretKeysReferencedIn } from "../../shared/mcp-placeholders.js";
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
    const out: McpStdioServerConfig = { name, type: "stdio", command, enabled };
    if (args) out.args = args;
    if (env) out.env = env;
    if (npmPackage) out.npmPackage = npmPackage;
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

/**
 * The keys under `prefix` that this config's `$secret:` references point at.
 * Every string in the config is scanned, not just the `env` / `headers` bag: a
 * reference also resolves inside `args` (`session/mcp-resolve.ts`), and a
 * reference missed here is a credential deleted as unreferenced.
 */
function referencedSecretKeys(config: McpServerConfig, prefix: string): string[] {
  return configStrings(config)
    .flatMap((value) => secretKeysReferencedIn(value))
    .filter((key) => key.startsWith(prefix));
}

function configStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(configStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(configStrings);
  return [];
}

function mapConfigStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return (value as unknown[]).map((v) => mapConfigStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapConfigStrings(v, fn)]),
    );
  }
  return value;
}

/**
 * A renamed server's own references follow it. The caller is not required to
 * rewrite them — the edit form cannot rewrite the ones in `args` at all — and a
 * reference left under the old name would be read as unreferenced and cleared.
 * References into *another* server's namespace are left alone.
 */
function renameOwnReferences(config: McpServerConfig, oldName: string): McpServerConfig {
  const from = `$secret:mcp__${oldName}__`;
  const to = `$secret:mcp__${config.name}__`;
  return mapConfigStrings(config, (s) => s.replaceAll(from, () => to)) as McpServerConfig;
}

/**
 * Reconciles a server's stored secrets to the keys its new config refers to,
 * plus whatever the save explicitly submits. A value comes from the submitted
 * secrets, else from the same key under the old name, else from what is already
 * stored; anything else in either namespace is dropped and reported as cleared.
 *
 * The carry-over is what makes a rename non-destructive. The edit form blanks
 * stored values and labels them "(unchanged)", so a renamed server submits no
 * replacement for them — deleting the old namespace outright lost credentials
 * the user could no longer see, and the form could not re-enter (planning#565).
 */
function reconcileSecrets(
  credentialStore: CredentialStore,
  oldName: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
): { keep: Map<string, string>; cleared: string[] } {
  const oldPrefix = `mcp__${oldName}__`;
  const newPrefix = `mcp__${config.name}__`;
  const env = credentialStore.getAllAgentEnv();

  const keep = new Map<string, string>();
  for (const key of new Set([
    ...referencedSecretKeys(config, newPrefix),
    ...Object.keys(secrets),
  ])) {
    // An explicitly submitted empty value clears the secret rather than carrying one.
    const value =
      key in secrets ? secrets[key] : env[oldPrefix + key.slice(newPrefix.length)] ?? env[key];
    if (value) keep.set(key, value);
  }

  // Nothing in one server's namespace is private to it: a config may refer to a
  // key stored under another server's name, and this edit is not that server's.
  // Only implicit cleanup defers to that — a save that names the key and submits
  // an empty value has asked for it, and is answered.
  const usedElsewhere = new Set(
    Object.values(credentialStore.getAllMcpServers())
      .filter((s) => s.name !== oldName && s.name !== config.name)
      .flatMap((s) => configStrings(s).flatMap(secretKeysReferencedIn)),
  );

  const cleared = Object.keys(env).filter(
    (key) =>
      (key.startsWith(oldPrefix) || key.startsWith(newPrefix))
      && !keep.has(key)
      && (!usedElsewhere.has(key) || key in secrets),
  );
  return { keep, cleared };
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
  const validated = validateMcpServerConfig(rawConfig);
  const isRename = validated.name !== id;
  if (isRename && credentialStore.getMcpServer(validated.name)) {
    throw new ServiceError(409, `An MCP server named "${validated.name}" already exists`);
  }
  const config = isRename ? renameOwnReferences(validated, id) : validated;
  const secrets = validateMcpSecrets(config.name, rawSecrets);

  if (config.enabled && countEnabled(credentialStore, id) + 1 > MAX_ENABLED_MCP_SERVERS) {
    throw new ServiceError(
      400,
      `Cannot enable more than ${MAX_ENABLED_MCP_SERVERS} MCP servers at once`,
    );
  }

  const { keep, cleared } = reconcileSecrets(credentialStore, id, config, secrets);
  if (isRename) credentialStore.deleteMcpServer(id);
  for (const key of cleared) {
    credentialStore.deleteMcpSecret(key);
  }

  credentialStore.setMcpServer(config.name, config);
  for (const [k, v] of keep) {
    credentialStore.setMcpSecret(k, v);
  }
  return { config, clearedSecretKeys: cleared };
}

/**
 * One field of a stored server, and nothing else of it. Deliberately not
 * {@link updateMcpServer} with the stored config: that reconciles the stored
 * secrets against the config it is handed, so a secret the config does not
 * `$secret:`-reference — which {@link addMcpServer} accepts — is cleared by a
 * caller that meant to change one boolean (docs/299-agent-settings-access,
 * plan.md → Collections are patched, never replaced).
 */
export function setMcpServerEnabled(
  credentialStore: CredentialStore,
  id: string,
  enabled: boolean,
): McpServerConfig {
  const existing = credentialStore.getMcpServer(id);
  if (!existing) {
    throw new ServiceError(404, `MCP server "${id}" not found`);
  }
  if (enabled && countEnabled(credentialStore, id) + 1 > MAX_ENABLED_MCP_SERVERS) {
    throw new ServiceError(
      400,
      `Cannot enable more than ${MAX_ENABLED_MCP_SERVERS} MCP servers at once`,
    );
  }
  const config: McpServerConfig = { ...existing, enabled };
  credentialStore.setMcpServer(id, config);
  return config;
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
