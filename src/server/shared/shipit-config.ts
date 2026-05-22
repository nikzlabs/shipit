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

export interface ShipitConfig {
  /** Schema version. Currently 1. */
  version?: number;
  /** Agent container configuration. */
  agent: AgentConfig;
  /** Compose file configuration. Undefined if no compose path specified or detected. */
  compose?: ComposeConfig;
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

const KNOWN_TOP_LEVEL_KEYS = new Set(["version", "agent", "compose"]);
const KNOWN_AGENT_KEYS = new Set(["memory", "cpu", "pids", "install"]);

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
    return { agent: { ...AGENT_DEFAULTS, install: [] }, warnings };
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

  return { version, agent, compose, warnings };
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
    config = { agent: { ...AGENT_DEFAULTS, install: [] }, warnings: [] };
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
    config ??= { agent: { ...AGENT_DEFAULTS, install: [] }, warnings: [] };
  }

  return config;
}
