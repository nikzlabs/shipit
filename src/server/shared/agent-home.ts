/**
 * Single source of truth for the agent runtime HOME directory (docs/150).
 *
 * Session-worker containers run as the unprivileged `shipit` user (UID/GID
 * 1000) whose home is `/home/shipit`. Historically the worker and every child
 * it spawned ran as root with `HOME=/root`; this module replaces those
 * hardcoded `/root` assumptions with one resolver.
 *
 * **Resolve at call time, never at module load.** `codex-adapter.ts`, the agent
 * registry, and `claude/process.ts` are imported by the *local-mode*
 * orchestrator (`RUNTIME_MODE=local`, dogfood) which keeps `AGENT_HOME=/root`
 * because the orchestrator container is still root and has no `shipit` user.
 * Reading the env var on each call lets the same module resolve to `/home/shipit`
 * inside a real session container and `/root` inside the local-mode orchestrator
 * without re-importing anything. See docs/150 §3 and §9.
 */

/** Default runtime home for the unprivileged session worker user. */
export const DEFAULT_AGENT_HOME = "/home/shipit";

/**
 * The agent runtime HOME. Honors the `AGENT_HOME` env var (set to
 * `/home/shipit` in the session container, left at `/root` in the local-mode
 * orchestrator) and falls back to {@link DEFAULT_AGENT_HOME}.
 */
export function agentHome(): string {
  return process.env.AGENT_HOME || DEFAULT_AGENT_HOME;
}

/** Default Codex config dir (`${agentHome()}/.codex`). Overridable via CODEX_HOME. */
export function codexHome(): string {
  return process.env.CODEX_HOME || `${agentHome()}/.codex`;
}
