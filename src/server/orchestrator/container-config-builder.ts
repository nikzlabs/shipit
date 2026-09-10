import fs from "node:fs";
import os from "node:os";
import { resolveShipitConfig, type ShipitConfig } from "../shared/shipit-config.js";

// Limits are ceilings, not reservations; allow two heavy sessions to share usable RAM.
const PER_SESSION_USABLE_FRACTION = 0.5;
const FLOOR_MB = 4096;
const CEILING_MB = 49152;
const BOOT_MIN_MB = 1536;
const RESERVE_MIN_MB = 2048;
const RESERVE_FRACTION = 0.1;
const PIDS_LIMIT = 8192;
const CPU_PERIOD_US = 100_000;

const BYTES_PER_MB = 1024 * 1024;

export interface AgentDockerLimits {
  /** Bytes. */
  memoryLimit: number;
  /** Microseconds per 100 ms period. */
  cpuQuota: number;
  pidsLimit: number;
  dockerAccess: boolean;
}

export function resolveAgentDockerLimits(workspaceDir: string): AgentDockerLimits {
  const cfg = readAgentConfig(workspaceDir);
  const sizing = deriveSessionMemorySizing();

  return {
    memoryLimit: sizing.effectiveMb * BYTES_PER_MB,
    cpuQuota: hostCpuQuota(),
    pidsLimit: PIDS_LIMIT,
    dockerAccess: cfg.compose?.dockerSocket ?? false,
  };
}

export function readAgentConfig(workspaceDir: string): ShipitConfig {
  try {
    return resolveShipitConfig(workspaceDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[shipit-config] Failed to parse shipit.yaml in ${workspaceDir} — ` +
        `falling back to default agent config: ${detail}`,
    );
    return {
      agent: { install: [], depDirs: ["node_modules"], installInputs: null },
      hostMounts: [],
      issues: { trackers: [] },
      plugins: { declared: false, repos: [], uses: [] },
      pluginExports: [],
      warnings: [],
    };
  }
}

/** Memory values are MiB. */
export interface SessionMemorySizing {
  effectiveMb: number;
  autoMb: number;
  hostMb: number;
  reserveMb: number;
  usableMb: number;
  baselineSource: "auto" | "DEFAULT_SESSION_MEMORY_MB";
  capSource: "host" | "MAX_SESSION_MEMORY_MB";
  capApplied: boolean;
}

export function deriveSessionMemorySizing(): SessionMemorySizing {
  const hostMb = hostTotalMemoryMb();
  const reserveMb = Math.max(RESERVE_MIN_MB, Math.floor(hostMb * RESERVE_FRACTION));
  const usableMb = Math.max(0, hostMb - reserveMb);

  const sized = clamp(Math.floor(usableMb * PER_SESSION_USABLE_FRACTION), FLOOR_MB, CEILING_MB);
  // The boot minimum can exceed usable RAM on very small hosts.
  const autoMb = Math.max(Math.min(sized, usableMb), BOOT_MIN_MB);

  const defaultEnv = readEnvPositiveInt("DEFAULT_SESSION_MEMORY_MB");
  const maxEnv = readEnvPositiveInt("MAX_SESSION_MEMORY_MB");

  const baselineMb = defaultEnv ?? autoMb;
  const capMb = maxEnv ?? Math.max(usableMb, BOOT_MIN_MB);
  const effectiveMb = Math.min(baselineMb, capMb);

  return {
    effectiveMb,
    autoMb,
    hostMb,
    reserveMb,
    usableMb,
    baselineSource: defaultEnv !== undefined ? "DEFAULT_SESSION_MEMORY_MB" : "auto",
    capSource: maxEnv !== undefined ? "MAX_SESSION_MEMORY_MB" : "host",
    capApplied: effectiveMb < baselineMb,
  };
}

function hostCpuQuota(): number {
  return Math.max(1, os.cpus().length) * CPU_PERIOD_US;
}

function hostTotalMemoryMb(): number {
  const osMb = Math.floor(os.totalmem() / BYTES_PER_MB);
  const cgroupMb = cgroupMemoryLimitMb();
  if (cgroupMb !== undefined && cgroupMb > 0 && cgroupMb < osMb) return cgroupMb;
  return osMb;
}

function cgroupMemoryLimitMb(): number | undefined {
  return readCgroupMemoryMb("/sys/fs/cgroup/memory.max")
    ?? readCgroupMemoryMb("/sys/fs/cgroup/memory/memory.limit_in_bytes");
}

function readCgroupMemoryMb(p: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8").trim();
  } catch {
    return undefined;
  }
  // The host-total comparison rejects v1's numeric unlimited sentinel.
  if (!raw || raw === "max") return undefined;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.floor(bytes / BYTES_PER_MB);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function readEnvPositiveInt(key: string): number | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
