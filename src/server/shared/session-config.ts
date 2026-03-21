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

export interface ContainerResourceConfig {
  /** Memory limit in MB. */
  memory: number;
  /** CPU cores as float. */
  cpu: number;
  /** Max PIDs. */
  pids: number;
}

export interface SessionResourceConfig {
  /** Agent container resources. */
  agent: ContainerResourceConfig;
  /** Preview container resources. */
  preview: ContainerResourceConfig;
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
  agent: { memory: 1024, cpu: 0.5, pids: 256 },
  preview: { memory: 512, cpu: 0.5, pids: 1024 },
};

const DEFAULT_CAPABILITIES: SessionCapabilities = {
  docker: false,
};

// ---------------------------------------------------------------------------
// Deployment-level caps (read from env vars)
// ---------------------------------------------------------------------------

export function getResourceCaps(): SessionResourceConfig {
  return {
    agent: {
      memory: parseEnvInt("MAX_SESSION_MEMORY_MB", 4096),
      cpu: parseEnvFloat("MAX_SESSION_CPU", 4),
      pids: parseEnvInt("MAX_SESSION_PIDS", 2048),
    },
    preview: {
      memory: parseEnvInt("MAX_SESSION_PREVIEW_MEMORY_MB", 4096),
      cpu: parseEnvFloat("MAX_SESSION_PREVIEW_CPU", 4),
      pids: parseEnvInt("MAX_SESSION_PREVIEW_PIDS", 2048),
    },
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
      agent: clampResources(resources.agent, caps.agent),
      preview: clampResources(resources.preview, caps.preview),
    },
    capabilities,
  };
}

function clampResources(
  resources: ContainerResourceConfig,
  caps: ContainerResourceConfig,
): ContainerResourceConfig {
  return {
    memory: Math.min(resources.memory, caps.memory),
    cpu: Math.min(resources.cpu, caps.cpu),
    pids: Math.min(resources.pids, caps.pids),
  };
}

function parseContainerResources(
  obj: unknown,
  defaults: ContainerResourceConfig,
): ContainerResourceConfig {
  if (typeof obj !== "object" || obj === null) return { ...defaults };
  const rec = obj as Record<string, unknown>;

  const memory = typeof rec.memory === "number" && Number.isFinite(rec.memory) && rec.memory > 0
    ? Math.floor(rec.memory)
    : defaults.memory;

  const cpu = typeof rec.cpu === "number" && Number.isFinite(rec.cpu) && rec.cpu > 0
    ? rec.cpu
    : defaults.cpu;

  const pids = typeof rec.pids === "number" && Number.isFinite(rec.pids) && rec.pids > 0
    ? Math.floor(rec.pids)
    : defaults.pids;

  return { memory, cpu, pids };
}

function parseResources(doc: Record<string, unknown> | undefined): SessionResourceConfig {
  if (!doc || !("resources" in doc) || typeof doc.resources !== "object" || doc.resources === null) {
    return { ...DEFAULT_RESOURCES };
  }

  const res = doc.resources as Record<string, unknown>;

  const agent = parseContainerResources(res.agent, DEFAULT_RESOURCES.agent);
  const preview = parseContainerResources(res.preview, DEFAULT_RESOURCES.preview);

  return { agent, preview };
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
