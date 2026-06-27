/**
 * Container config building — automatic per-session resource sizing.
 *
 * Session container memory is derived from host capacity (docs/229): in the
 * common case neither the operator nor the repo configures anything. A Docker
 * memory limit is a ceiling, not a reservation, so every session can hold a
 * generous host-derived ceiling and the host relies on statistical
 * multiplexing — idle sessions cost nothing. The only override is two optional
 * deployment-level env vars (`DEFAULT_SESSION_MEMORY_MB`, `MAX_SESSION_MEMORY_MB`).
 *
 * Memory and CPU are not symmetric: memory is incompressible (overshoot OOM-kills),
 * so it gets a firm derived limit; CPU is compressible (contention just slows
 * everyone), so the quota is set to the host core count — effectively unlimited
 * for a single session, with the kernel scheduler time-sharing under contention.
 * PIDs carry a fixed fork-bomb guard.
 *
 * The repo `agent.memory` / `agent.cpu` / `agent.pids` fields were removed; a
 * shipit.yaml that still sets them is warned-and-ignored by the parser.
 *
 * All functions are pure over their inputs (a workspace dir or host state) —
 * they hold no class state — so callers import them directly.
 */

import fs from "node:fs";
import os from "node:os";
import { resolveShipitConfig, type ShipitConfig } from "../shared/shipit-config.js";

// ---------------------------------------------------------------------------
// Sizing constants (all memory values in MiB)
// ---------------------------------------------------------------------------

/** Heavy sessions that should be able to peak at once on a large host. */
const TARGET_CONCURRENCY = 8;
/** A real test suite needs room — the smallest per-session ceiling on a roomy host. */
const FLOOR_MB = 4096;
/** No single session should need more; bounds blast radius. */
const CEILING_MB = 16384;
/** Least a session needs to function — the last-resort minimum on a tiny host. */
const BOOT_MIN_MB = 1536;
/** Floor for the orchestrator + OS reserve. */
const RESERVE_MIN_MB = 2048;
/** Reserve fraction of host RAM for the orchestrator + OS working set. */
const RESERVE_FRACTION = 0.1;
/** Fixed per-session process ceiling (fork-bomb guard). */
const PIDS_LIMIT = 8192;
/** Standard CFS period (microseconds). */
const CPU_PERIOD_US = 100_000;

const BYTES_PER_MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Agent resource limits — single source of truth for the container's limits
// ---------------------------------------------------------------------------

/** Docker-units limits derived from host capacity. */
export interface AgentDockerLimits {
  /** Container memory ceiling in bytes (cgroup memory.max). */
  memoryLimit: number;
  /** CPU quota: microseconds per 100ms period (host core count → effectively unlimited per session). */
  cpuQuota: number;
  /** Max processes inside the container's pids cgroup. */
  pidsLimit: number;
  /** Whether the agent gets a Docker socket proxy + session network. */
  dockerAccess: boolean;
}

/**
 * Derive the canonical Docker-units limits for a session container. Memory is
 * auto-sized from host capacity (+ optional env override); CPU and PIDs are
 * host-derived / fixed. Only `dockerAccess` still comes from the workspace's
 * shipit.yaml (`compose.docker-socket`).
 *
 * Every container creation path (fresh, standby fallback, warm-pool standby,
 * rediscover) derives its limits from here.
 */
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

/**
 * Parse a workspace's shipit.yaml, falling back to a default config when the
 * file is genuinely broken (malformed YAML, unreadable, schema violation).
 *
 * The fallback is deliberate — a broken config shouldn't block the session —
 * but it is NOT silent: the catch logs the workspace dir and the underlying
 * error so journalctl carries the breadcrumb. A genuinely-absent shipit.yaml
 * is the common, legitimate case and does not throw.
 */
export function readAgentConfig(workspaceDir: string): ShipitConfig {
  try {
    return resolveShipitConfig(workspaceDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[shipit-config] Failed to parse shipit.yaml in ${workspaceDir} — ` +
        `falling back to default agent config: ${detail}`,
    );
    return { agent: { install: [], depDirs: ["node_modules"], installInputs: null }, hostMounts: [], warnings: [] };
  }
}

// ---------------------------------------------------------------------------
// Automatic memory sizing
// ---------------------------------------------------------------------------

/** A resolved per-session memory sizing plus the host facts that produced it. */
export interface SessionMemorySizing {
  /** What the container actually boots with (MiB), after env overrides. */
  effectiveMb: number;
  /** The host-derived per-session ceiling before any env override (MiB). */
  autoMb: number;
  /** Total host/VM RAM the derivation keyed off (MiB). */
  hostMb: number;
  /** Orchestrator + OS reserve held back (MiB). */
  reserveMb: number;
  /** Host RAM available to sessions after the reserve (MiB). */
  usableMb: number;
  /** Where the baseline came from. */
  baselineSource: "auto" | "DEFAULT_SESSION_MEMORY_MB";
  /** Where the ceiling came from. */
  capSource: "host" | "MAX_SESSION_MEMORY_MB";
  /** Whether the cap reduced the effective value below the baseline. */
  capApplied: boolean;
}

/**
 * Derive the per-session memory ceiling from host capacity, applying the two
 * optional operator env overrides.
 *
 *   reserve     = max(2 GiB, hostRam × 0.10)              // orchestrator + OS
 *   usable      = hostRam − reserve
 *   sized       = clamp(usable / TARGET_CONCURRENCY, FLOOR, CEILING)
 *   auto        = max(min(sized, usable), BOOT_MIN)       // never exceed usable; never below boot min
 *   baseline    = DEFAULT_SESSION_MEMORY_MB ?? auto
 *   cap         = MAX_SESSION_MEMORY_MB ?? max(usable, BOOT_MIN)
 *   effective   = min(baseline, cap)
 *
 * `min(sized, usable)` matters because FLOOR (4 GiB) can exceed usable on a
 * small host; there the session is pinned to usable. BOOT_MIN is the one
 * exception to "never exceed usable": on a host so small that usable < BOOT_MIN
 * the session still gets BOOT_MIN (it cannot function below it).
 */
export function deriveSessionMemorySizing(): SessionMemorySizing {
  const hostMb = hostTotalMemoryMb();
  const reserveMb = Math.max(RESERVE_MIN_MB, Math.floor(hostMb * RESERVE_FRACTION));
  const usableMb = Math.max(0, hostMb - reserveMb);

  const sized = clamp(Math.floor(usableMb / TARGET_CONCURRENCY), FLOOR_MB, CEILING_MB);
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

/** CPU quota = host core count × period (effectively unlimited for one session). */
function hostCpuQuota(): number {
  return Math.max(1, os.cpus().length) * CPU_PERIOD_US;
}

/**
 * Total RAM the orchestrator may size against, in MiB. `os.totalmem()` reports
 * the host/VM total; for ShipIt's own deployment (orchestrator uncapped inside
 * a VM) that is the real budget. For portability, prefer a cgroup memory limit
 * when one is set *below* host total — for a deployment that runs the
 * orchestrator inside a constrained container. The `< osMb` comparison also
 * neutralizes cgroup "unlimited" sentinels (which read as absurdly large).
 */
function hostTotalMemoryMb(): number {
  const osMb = Math.floor(os.totalmem() / BYTES_PER_MB);
  const cgroupMb = cgroupMemoryLimitMb();
  if (cgroupMb !== undefined && cgroupMb > 0 && cgroupMb < osMb) return cgroupMb;
  return osMb;
}

/** Read a cgroup memory limit in MiB — v2 first, then v1; undefined if neither is a usable number. */
function cgroupMemoryLimitMb(): number | undefined {
  return readCgroupMemoryMb("/sys/fs/cgroup/memory.max") // cgroup v2
    ?? readCgroupMemoryMb("/sys/fs/cgroup/memory/memory.limit_in_bytes"); // cgroup v1
}

function readCgroupMemoryMb(p: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8").trim();
  } catch {
    return undefined;
  }
  // v2 unlimited sentinel is the literal "max"; v1's near-Int64 sentinel is a
  // number that the caller's `< osMb` check discards.
  if (!raw || raw === "max") return undefined;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.floor(bytes / BYTES_PER_MB);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Read a positive integer env var, or `undefined` when unset or invalid. */
function readEnvPositiveInt(key: string): number | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
