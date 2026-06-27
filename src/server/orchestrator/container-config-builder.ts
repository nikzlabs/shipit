/**
 * Container config building — agent resource-limit resolution.
 *
 * Extracted from SessionContainerManager for single-responsibility modules.
 * This module owns the deployment config → Docker-units translation. The
 * lower-level `buildContainerConfig`
 * / env / mount builders live in `container-lifecycle.ts`; the manager wires
 * the two together.
 *
 * All functions are pure over their inputs (a workspace dir, a parsed config, or
 * process env) — they hold no class state — so callers (`SessionContainerManager`,
 * the diagnostics service, the claim-session flow) import them directly.
 */

import { resolveShipitConfig, AGENT_DEFAULTS, type ShipitConfig } from "../shared/shipit-config.js";

// ---------------------------------------------------------------------------
// Agent resource limits — single source of truth for deployment config → Docker
// ---------------------------------------------------------------------------

/** Docker-units limits derived from deployment config. */
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
 * Read deployment-owned session limits and a workspace's `compose.docker-socket`
 * setting, then map them to canonical Docker units.
 *
 * This is the single place that translates deployment-owned session resources
 * into Docker units. Every container creation path (fresh, standby fallback,
 * warm-pool standby, rediscover) must derive its limits from here.
 *
 * Repo `shipit.yaml` no longer controls the agent container's memory/CPU/PID
 * budget. `agent.memory`, `agent.cpu`, `agent.pids`, and old `resources:` keys
 * are parsed only to emit diagnostics warnings. Sizing belongs to the ShipIt
 * deployment because the right budget depends on the host's available RAM/CPU,
 * not just the repository.
 */
export function resolveAgentDockerLimits(workspaceDir: string): AgentDockerLimits {
  const cfg = readAgentConfig(workspaceDir);
  const { effective } = applyEnvCaps(cfg);

  for (const w of cfg.warnings) {
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
        `falling back to default agent setup config ` +
        `(${d.memory} MiB / ${d.cpu} CPU / ${d.pids} pids): ${detail}`,
    );
    return { agent: { ...AGENT_DEFAULTS, install: [] }, hostMounts: [], warnings: [] };
  }
}

/** What the container actually boots with — deployment-owned values. */
export interface EffectiveAgentResources {
  memory: number;
  cpu: number;
  pids: number;
  dockerAccess: boolean;
}

/**
 * Resolve the deployment-owned session container resource limits.
 *
 * The function keeps its historical name because diagnostics and tests import
 * it directly, but it no longer clamps repo-declared values. The repo config is
 * used only for `compose.docker-socket`; memory/CPU/PIDs come from deployment
 * env vars or ShipIt's defaults.
 *
 * Exported so the diagnostics endpoint can surface the exact values the next
 * container will boot with.
 */
export function applyEnvCaps(cfg: ShipitConfig): {
  effective: EffectiveAgentResources;
  warnings: string[];
} {
  const limits = getDeploymentResourceLimits();

  return {
    effective: {
      memory: limits.memoryMb,
      cpu: limits.cpu,
      pids: limits.pids,
      dockerAccess: cfg.compose?.dockerSocket ?? false,
    },
    warnings: [],
  };
}

interface DeploymentResourceLimits {
  memoryMb: number;
  cpu: number;
  pids: number;
}

/**
 * Deployment-level session resources, resolved at call time.
 *
 * The env var names retain the historical `MAX_` prefix for compatibility, but
 * they now define the actual per-session container budget. When unset, ShipIt
 * uses conservative defaults suitable for small deployments; larger hosts can
 * raise them without touching any repository.
 */
function getDeploymentResourceLimits(): DeploymentResourceLimits {
  const memEnv = readEnvPositiveInt("MAX_SESSION_MEMORY_MB");
  const cpuEnv = readEnvPositiveFloat("MAX_SESSION_CPU");
  const pidEnv = readEnvPositiveInt("MAX_SESSION_PIDS");

  return {
    memoryMb: memEnv ?? AGENT_DEFAULTS.memory,
    cpu: cpuEnv ?? AGENT_DEFAULTS.cpu,
    pids: pidEnv ?? AGENT_DEFAULTS.pids,
  };
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
