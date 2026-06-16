/**
 * Container config building — agent resource-limit resolution.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 * This module owns the shipit.yaml → Docker-units translation and the
 * deployment-level env caps that clamp it. The lower-level `buildContainerConfig`
 * / env / mount builders live in `container-lifecycle.ts`; the manager wires
 * the two together.
 *
 * All functions are pure over their inputs (a workspace dir, a parsed config, or
 * process env) — they hold no class state — so callers (`SessionContainerManager`,
 * the diagnostics service, the claim-session flow) import them directly.
 */

import os from "node:os";
import { resolveShipitConfig, AGENT_DEFAULTS, type ShipitConfig } from "../shared/shipit-config.js";

// ---------------------------------------------------------------------------
// Agent resource limits — single source of truth for shipit.yaml → Docker
// ---------------------------------------------------------------------------

/** Docker-units limits derived from a workspace's shipit.yaml. */
export interface AgentDockerLimits {
  /** Container memory ceiling in bytes (cgroup memory.max). */
  memoryLimit: number;
  /** CPU quota: microseconds per 100ms period. */
  cpuQuota: number;
  /** Max processes inside the container's pids cgroup. */
  pidsLimit: number;
  /** Whether the agent gets a Docker socket proxy + session network. */
  dockerAccess: boolean;
}

/**
 * Read a workspace's shipit.yaml and map `agent.memory/cpu/pids` and
 * `compose.docker-socket` to canonical Docker-units limits.
 *
 * This is the single place that translates the user's declared resources
 * into Docker units. Every container creation path (fresh, standby fallback,
 * warm-pool standby, rediscover) must derive its limits from here — anything
 * else silently falls back to the manager's compiled-in defaults (1.5 GiB /
 * 0.5 CPU / 4096 pids), under-provisioning containers that declared more.
 *
 * Old-format shipit.yaml (`resources:` / `capabilities:` blocks) is no longer
 * recognised: `resolveShipitConfig` emits warnings for those keys but does
 * not extract values from them, so misconfigured files fall through to
 * defaults. The warnings are surfaced in the diagnostics panel.
 */
export function resolveAgentDockerLimits(workspaceDir: string): AgentDockerLimits {
  const { effective, warnings } = applyEnvCaps(readAgentConfig(workspaceDir));

  // The clamp used to be silent. Surface it in the orchestrator log so a
  // misconfigured MAX_SESSION_MEMORY_MB can't shrink a declared limit
  // without anyone knowing — that's how a 3072-declared session boots at
  // 1024 and then OOMs on `npm install`. We deliberately log here (and not
  // only in the diagnostics endpoint) so journalctl carries the breadcrumb
  // even when nobody opens the panel.
  for (const w of warnings) {
    console.warn(`[shipit-config] ${workspaceDir}: ${w}`);
  }

  return {
    memoryLimit: effective.memory * 1024 * 1024,
    cpuQuota: Math.round(effective.cpu * 100_000),
    pidsLimit: effective.pids,
    dockerAccess: effective.dockerAccess,
  };
}

/**
 * Parse a workspace's shipit.yaml, falling back to AGENT_DEFAULTS when the
 * file is genuinely broken (malformed YAML, unreadable, schema violation).
 *
 * The fallback is deliberate — a broken config shouldn't block the session
 * entirely — but it is NOT silent: a broken shipit.yaml that quietly
 * produces a 1 GiB container is a real footgun (the session then OOMs and
 * nobody can tell why). The catch logs the workspace dir, the fact that
 * defaults are being applied, and the underlying error so journalctl
 * carries the breadcrumb. A genuinely-absent shipit.yaml is the common,
 * legitimate case and does not throw — `resolveShipitConfig` returns
 * defaults for it without hitting this catch.
 */
export function readAgentConfig(workspaceDir: string): ShipitConfig {
  try {
    return resolveShipitConfig(workspaceDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Interpolate AGENT_DEFAULTS rather than hard-coding the numbers so the
    // log line can't drift if the defaults ever change.
    const d = AGENT_DEFAULTS;
    console.error(
      `[shipit-config] Failed to parse shipit.yaml in ${workspaceDir} — ` +
        `falling back to default agent resources ` +
        `(${d.memory} MiB / ${d.cpu} CPU / ${d.pids} pids): ${detail}`,
    );
    return { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], warnings: [] };
  }
}

/** What the container actually boots with — declared values after env caps applied. */
export interface EffectiveAgentResources {
  memory: number;
  cpu: number;
  pids: number;
  dockerAccess: boolean;
}

/**
 * Apply deployment-level env caps to a parsed shipit.yaml's agent block.
 * Returns the post-clamp values that the container will actually boot on,
 * plus a list of human-readable warnings for each metric that was capped.
 *
 * Exported so the diagnostics endpoint can surface the same clamp warnings
 * in the UI alongside the orchestrator log line — visibility on both sides.
 */
export function applyEnvCaps(cfg: ShipitConfig): {
  effective: EffectiveAgentResources;
  warnings: string[];
} {
  const caps = getResourceCaps();
  const warnings: string[] = [];

  const memory = Math.min(cfg.agent.memory, caps.memoryMb.value);
  if (cfg.agent.memory > caps.memoryMb.value) {
    warnings.push(
      `agent.memory ${cfg.agent.memory} MiB clamped to ${caps.memoryMb.value} MiB by ${caps.memoryMb.source}`,
    );
  }

  const cpu = Math.min(cfg.agent.cpu, caps.cpu.value);
  if (cfg.agent.cpu > caps.cpu.value) {
    warnings.push(
      `agent.cpu ${cfg.agent.cpu} clamped to ${caps.cpu.value} by ${caps.cpu.source}`,
    );
  }

  const pids = Math.min(cfg.agent.pids, caps.pids.value);
  if (cfg.agent.pids > caps.pids.value) {
    warnings.push(
      `agent.pids ${cfg.agent.pids} clamped to ${caps.pids.value} by ${caps.pids.source}`,
    );
  }

  return {
    effective: {
      memory,
      cpu,
      pids,
      dockerAccess: cfg.compose?.dockerSocket ?? false,
    },
    warnings,
  };
}

/** Fraction of total host RAM a single session may claim by default. */
const HOST_MEMORY_FRACTION = 0.75;
/** Default per-session process ceiling (fork-bomb guard) when unset. */
const DEFAULT_MAX_PIDS = 8192;

/** A resolved ceiling plus a human label naming what produced it. */
interface ResourceCap {
  value: number;
  /** Names the cause in clamp warnings, e.g. "MAX_SESSION_MEMORY_MB" or "available host memory". */
  source: string;
}

interface AgentResourceCaps {
  memoryMb: ResourceCap;
  cpu: ResourceCap;
  pids: ResourceCap;
}

/**
 * Deployment-level ceiling on per-session resources, resolved at call time.
 *
 * Each ceiling is an explicit operator override (the matching `MAX_SESSION_*`
 * env var) when set, otherwise a default derived from the host. The defaults
 * are deliberately generous: ShipIt is single-tenant today (local, or a VPS
 * the user controls), so the goal is to honor whatever a repo declares up to
 * what the host can actually back — not to impose an arbitrary flat ceiling
 * (a fixed 4096 MiB used to silently clamp a legitimate 6144 declaration).
 *
 * The defaults are NOT "unlimited", though: they stay tied to host capacity so
 * one runaway session can't OOM or fork-bomb the box and take down the
 * orchestrator and its sibling sessions — a blast-radius guard that matters
 * even when you own every session on the host. Multi-tenant fair-sharing,
 * if/when it ships, layers stricter values on top via the env vars.
 */
function getResourceCaps(): AgentResourceCaps {
  const memEnv = readEnvPositiveInt("MAX_SESSION_MEMORY_MB");
  const cpuEnv = readEnvPositiveFloat("MAX_SESSION_CPU");
  const pidEnv = readEnvPositiveInt("MAX_SESSION_PIDS");

  return {
    memoryMb:
      memEnv !== undefined
        ? { value: memEnv, source: "MAX_SESSION_MEMORY_MB" }
        : { value: hostMemoryCapMb(), source: "available host memory" },
    cpu:
      cpuEnv !== undefined
        ? { value: cpuEnv, source: "MAX_SESSION_CPU" }
        : { value: hostCpuCap(), source: "host CPU count" },
    pids:
      pidEnv !== undefined
        ? { value: pidEnv, source: "MAX_SESSION_PIDS" }
        : { value: DEFAULT_MAX_PIDS, source: "the default per-session PID ceiling" },
  };
}

/**
 * Default memory ceiling: a fraction of total host RAM, never below the library
 * default so even a tiny host still honors a default-sized session.
 */
function hostMemoryCapMb(): number {
  const totalMib = Math.floor(os.totalmem() / (1024 * 1024));
  return Math.max(AGENT_DEFAULTS.memory, Math.floor(totalMib * HOST_MEMORY_FRACTION));
}

/** Default CPU ceiling: the host core count (at least 1). */
function hostCpuCap(): number {
  return Math.max(1, os.cpus().length);
}

/** Read a positive integer env var, or `undefined` when unset or invalid. */
function readEnvPositiveInt(key: string): number | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read a positive float env var, or `undefined` when unset or invalid. */
function readEnvPositiveFloat(key: string): number | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
