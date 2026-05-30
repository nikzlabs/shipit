/**
 * Unified shipit.yaml parser — reads `version`, `agent`, and `compose` blocks.
 *
 * The schema has three top-level keys:
 *
 *   version: 1          # optional schema version
 *   agent:              # optional agent container config
 *     memory: 2048
 *     cpu: 1.0
 *     pids: 512
 *     install:
 *       - npm install
 *       - npx prisma generate
 *   compose: docker-compose.yml   # string or object form
 *
 * Old-format keys (preview, resources, capabilities, services) emit warnings
 * with migration hints.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Memory limit in MB. Default: 1024 */
  memory: number;
  /** CPU cores as float. Default: 0.5 */
  cpu: number;
  /** Max PIDs. Default: 256 */
  pids: number;
  /** Install commands, run sequentially before compose starts. Default: [] */
  install: string[];
}

export interface ComposeConfig {
  /** Path to compose file (relative to workspace root). */
  file: string;
  /** Grant Docker socket access to compose services. Default: false */
  dockerSocket: boolean;
}

/**
 * docs/128 — a single allow-listed read-only host path mounted into the agent
 * container. Only used by privileged "ops" sessions; the container-creation
 * gate additionally requires the session's server-side `kind === "ops"`, so a
 * forged `x-shipit-host-mounts` in an ordinary session's shipit.yaml has its
 * mounts dropped.
 */
export interface HostMount {
  /** Host path (must be one of the allow-listed sources). */
  source: string;
  /** Container path (fixed mapping; equal to the source for the journal/socket paths). */
  target: string;
  /** Always read-only — host mounts are never writable from the agent. */
  readOnly: true;
}

export interface ShipitConfig {
  /** Schema version. Currently 1. */
  version?: number;
  /** Agent container configuration. */
  agent: AgentConfig;
  /** Compose file configuration. Undefined if no compose path specified or detected. */
  compose?: ComposeConfig;
  /**
   * docs/128 — allow-listed read-only host mounts (`x-shipit-host-mounts`).
   * Empty for ordinary sessions. Even when populated, mounts are only applied
   * to the agent container when the session's server-side `kind === "ops"`.
   */
  hostMounts: HostMount[];
  /** Warnings emitted during parsing (unknown keys, migration hints). */
  warnings: string[];
}

export class ShipitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipitConfigError";
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const AGENT_DEFAULTS: Readonly<AgentConfig> = {
  memory: 1536,
  cpu: 0.5,
  pids: 256,
  install: [],
};

// ---------------------------------------------------------------------------
// Known keys for validation
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_KEYS = new Set(["version", "agent", "compose", "x-shipit-host-mounts"]);
const KNOWN_AGENT_KEYS = new Set(["memory", "cpu", "pids", "install"]);

/**
 * docs/128 — the only host paths an ops session may bind-mount (read-only) into
 * the agent container. Maps host source → container target. Anything outside
 * this map is rejected by the parser. `/var/run/docker.sock` is listed for
 * completeness, but in practice the agent reaches Docker via the read-only
 * proxy over `DOCKER_HOST`, not by mounting the socket — the real socket is
 * mounted only into the docker-socket-proxy sibling (a compose service).
 */
export const ALLOWED_HOST_MOUNT_SOURCES: Readonly<Record<string, string>> = {
  "/var/run/docker.sock": "/var/run/docker.sock",
  "/var/log/journal": "/var/log/journal",
  "/run/log/journal": "/run/log/journal",
};

/** Old-format keys that trigger migration warnings. */
const OLD_FORMAT_KEYS: Record<string, string> = {
  preview: "The `preview` block has been removed. Define services in docker-compose.yml instead. See /shipit-docs/compose.md.",
  resources: "The `resources` block has been replaced by `agent` (flat fields: memory, cpu, pids). Preview resources are now set per-service in docker-compose.yml.",
  capabilities: "The `capabilities` block has been replaced. Use `compose.docker-socket: true` instead of `capabilities.docker: true`.",
  services: "The `services` block has been removed. Define services in docker-compose.yml instead.",
  install: "The top-level `install` field has moved to `agent.install`.",
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a shipit.yaml document object into a ShipitConfig.
 * Exported for testing — callers should use `resolveShipitConfig()`.
 */
export function parseShipitConfig(doc: unknown): ShipitConfig {
  const warnings: string[] = [];

  if (doc === null || doc === undefined) {
    return { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], warnings };
  }

  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ShipitConfigError("shipit.yaml must be a YAML mapping (object)");
  }

  const raw = doc as Record<string, unknown>;

  // Check for old-format keys
  for (const [key, hint] of Object.entries(OLD_FORMAT_KEYS)) {
    if (key in raw) {
      warnings.push(hint);
    }
  }

  // Check for unknown top-level keys (excluding old-format keys which already warned)
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && !(key in OLD_FORMAT_KEYS)) {
      warnings.push(`Unknown top-level key \`${key}\` in shipit.yaml.`);
    }
  }

  // ---- version ----
  let version: number | undefined;
  if ("version" in raw) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
      throw new ShipitConfigError("`version` must be a positive integer");
    }
    version = raw.version;
  }

  // ---- agent ----
  const agent = parseAgentConfig(raw.agent, warnings);

  // ---- compose ----
  const compose = parseComposeConfig(raw.compose);

  // ---- x-shipit-host-mounts (docs/128) ----
  const hostMounts = parseHostMounts(raw["x-shipit-host-mounts"]);

  return { version, agent, compose, hostMounts, warnings };
}

/**
 * docs/128 — parse `x-shipit-host-mounts`: a list of host source paths to bind
 * read-only into the agent container. Each entry must be one of the allow-listed
 * sources (`ALLOWED_HOST_MOUNT_SOURCES`); anything else throws. Duplicates are
 * de-duplicated. Returns [] when the key is absent.
 *
 * Note: this only describes intent. Whether the mounts are actually applied is
 * decided at container-creation time and gated on the session's server-side
 * `kind === "ops"` — a forged entry on an ordinary session is dropped there.
 */
function parseHostMounts(raw: unknown): HostMount[] {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    throw new ShipitConfigError("`x-shipit-host-mounts` must be a list of host paths");
  }

  const seen = new Set<string>();
  const mounts: HostMount[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (typeof entry !== "string") {
      throw new ShipitConfigError(`\`x-shipit-host-mounts[${i}]\` must be a string host path`);
    }
    const source = entry.trim();
    const target = ALLOWED_HOST_MOUNT_SOURCES[source];
    if (!target) {
      const allowed = Object.keys(ALLOWED_HOST_MOUNT_SOURCES).join(", ");
      throw new ShipitConfigError(
        `\`x-shipit-host-mounts[${i}]\`: host mount \`${source}\` is not allowed. Allowed: ${allowed}`,
      );
    }
    if (seen.has(source)) continue;
    seen.add(source);
    mounts.push({ source, target, readOnly: true });
  }
  return mounts;
}

function parseAgentConfig(raw: unknown, warnings: string[]): AgentConfig {
  if (raw === undefined || raw === null) {
    return { ...AGENT_DEFAULTS, install: [] };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShipitConfigError("`agent` must be a mapping (object)");
  }

  const obj = raw as Record<string, unknown>;

  // Check for unknown agent keys
  for (const key of Object.keys(obj)) {
    if (!KNOWN_AGENT_KEYS.has(key)) {
      warnings.push(`Unknown key \`agent.${key}\` in shipit.yaml.`);
    }
  }

  const memory = parsePositiveNumber(obj.memory, AGENT_DEFAULTS.memory, true);
  const cpu = parsePositiveNumber(obj.cpu, AGENT_DEFAULTS.cpu, false);
  const pids = parsePositiveNumber(obj.pids, AGENT_DEFAULTS.pids, true);
  const install = parseInstallList(obj.install);

  return { memory, cpu, pids, install };
}

function parsePositiveNumber(val: unknown, fallback: number, floor: boolean): number {
  if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
    return fallback;
  }
  return floor ? Math.floor(val) : val;
}

function parseInstallList(val: unknown): string[] {
  if (val === undefined || val === null) return [];

  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(val)) {
    const result: string[] = [];
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== "string") {
        throw new ShipitConfigError(`\`agent.install[${i}]\` must be a string`);
      }
      const trimmed = (val[i] as string).trim();
      if (trimmed) result.push(trimmed);
    }
    return result;
  }

  throw new ShipitConfigError("`agent.install` must be a string or array of strings");
}

function parseComposeConfig(raw: unknown): ComposeConfig | undefined {
  if (raw === undefined || raw === null) return undefined;

  // String form: compose: docker-compose.yml
  if (typeof raw === "string") {
    const file = raw.trim();
    if (!file) throw new ShipitConfigError("`compose` path must not be empty");
    return { file, dockerSocket: false };
  }

  // Object form: compose: { file: ..., docker-socket: ... }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;

    if (!("file" in obj) || typeof obj.file !== "string" || !obj.file.trim()) {
      throw new ShipitConfigError("`compose.file` is required and must be a non-empty string");
    }

    const dockerSocket = obj["docker-socket"] === true;

    return { file: obj.file.trim(), dockerSocket };
  }

  throw new ShipitConfigError("`compose` must be a string or object with a `file` field");
}

// ---------------------------------------------------------------------------
// File resolver
// ---------------------------------------------------------------------------

/**
 * Resolve shipit config from a shipit.yaml file in the given directory.
 * Returns defaults (with warnings) if the file doesn't exist or is empty.
 *
 * Compose must be explicitly specified via the `compose` key in shipit.yaml.
 * If not specified, compose is undefined and no services will be started.
 */
export function resolveShipitConfig(dir: string): ShipitConfig {
  const yamlPath = path.join(dir, "shipit.yaml");

  let config: ShipitConfig;

  // Try to read the file — only fall back to defaults on missing/unreadable file
  let content: string | undefined;
  try {
    content = fs.readFileSync(yamlPath, "utf-8");
  } catch {
    // File doesn't exist or can't be read — use defaults
    config = { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], warnings: [] };
  }

  if (content !== undefined) {
    try {
      const parsed: unknown = parseYaml(content);
      config = parseShipitConfig(parsed);
    } catch (err) {
      if (err instanceof ShipitConfigError) throw err;
      // YAML syntax error — surface it instead of silently defaulting
      const message = err instanceof Error ? err.message : String(err);
      throw new ShipitConfigError(`Failed to parse shipit.yaml: ${message}`);
    }
  } else {
    // Already set above in the catch block, but TypeScript needs this
    config ??= { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], warnings: [] };
  }

  return config;
}
