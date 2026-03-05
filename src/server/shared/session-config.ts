/**
 * Session configuration resolver — reads `resources` and `capabilities`
 * blocks from `shipit.yaml` before container creation.
 *
 * This lives in `shared/` because the orchestrator calls it before creating
 * the container (the session worker hasn't started yet). The session worker's
 * `preview-config.ts` continues to parse preview-specific config independently.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionResourceConfig {
  /** Memory limit in MB. Default: 512 */
  memory: number;
  /** CPU cores. Default: 0.5 */
  cpu: number;
  /** Max PIDs. Default: 256 */
  pids: number;
}

export interface SessionCapabilities {
  /** Whether the session needs Docker access. Default: false */
  docker: boolean;
}

export interface SessionConfig {
  resources: SessionResourceConfig;
  capabilities: SessionCapabilities;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RESOURCES: SessionResourceConfig = {
  memory: 512,
  cpu: 0.5,
  pids: 256,
};

const DEFAULT_CAPABILITIES: SessionCapabilities = {
  docker: false,
};

// ---------------------------------------------------------------------------
// Deployment-level caps (read from env vars)
// ---------------------------------------------------------------------------

export function getResourceCaps(): SessionResourceConfig {
  return {
    memory: parseEnvInt("MAX_SESSION_MEMORY_MB", 4096),
    cpu: parseEnvFloat("MAX_SESSION_CPU", 4),
    pids: parseEnvInt("MAX_SESSION_PIDS", 2048),
  };
}

function parseEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseEnvFloat(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseFloat(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Resolve session config (resources + capabilities) from `shipit.yaml` in the
 * given directory. Returns defaults for missing fields or missing file.
 *
 * Resource values are capped at deployment-level maximums from env vars:
 * - `MAX_SESSION_MEMORY_MB` (default 4096)
 * - `MAX_SESSION_CPU` (default 4)
 * - `MAX_SESSION_PIDS` (default 2048)
 */
export function resolveSessionConfig(sessionDir: string): SessionConfig {
  const yamlPath = path.join(sessionDir, "shipit.yaml");

  let doc: Record<string, unknown> | undefined;
  try {
    const content = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (typeof parsed === "object" && parsed !== null) {
      doc = parsed;
    }
  } catch {
    // File doesn't exist or can't be read — use defaults
  }

  const resources = parseResources(doc);
  const capabilities = parseCapabilities(doc);
  const caps = getResourceCaps();

  return {
    resources: {
      memory: Math.min(resources.memory, caps.memory),
      cpu: Math.min(resources.cpu, caps.cpu),
      pids: Math.min(resources.pids, caps.pids),
    },
    capabilities,
  };
}

function parseResources(doc: Record<string, unknown> | undefined): SessionResourceConfig {
  if (!doc || !("resources" in doc) || typeof doc.resources !== "object" || doc.resources === null) {
    return { ...DEFAULT_RESOURCES };
  }

  const res = doc.resources as Record<string, unknown>;

  const memory = typeof res.memory === "number" && Number.isFinite(res.memory) && res.memory > 0
    ? Math.floor(res.memory)
    : DEFAULT_RESOURCES.memory;

  const cpu = typeof res.cpu === "number" && Number.isFinite(res.cpu) && res.cpu > 0
    ? res.cpu
    : DEFAULT_RESOURCES.cpu;

  const pids = typeof res.pids === "number" && Number.isFinite(res.pids) && res.pids > 0
    ? Math.floor(res.pids)
    : DEFAULT_RESOURCES.pids;

  return { memory, cpu, pids };
}

function parseCapabilities(doc: Record<string, unknown> | undefined): SessionCapabilities {
  if (!doc || !("capabilities" in doc) || typeof doc.capabilities !== "object" || doc.capabilities === null) {
    return { ...DEFAULT_CAPABILITIES };
  }

  const caps = doc.capabilities as Record<string, unknown>;

  return {
    docker: caps.docker === true,
  };
}
