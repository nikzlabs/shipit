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

/**
 * Per-spawn HOME override for an agent CLI (docs/150-multiple-provider-subscriptions req 19).
 *
 * The process-global {@link agentHome} is correct inside a session container,
 * where the image symlinks `~/.claude` / `~/.codex` at the per-session
 * credentials mount, so the CLI transparently reads the account this session
 * was routed to. In `RUNTIME_MODE=local` (dogfood) there is no container and no
 * mount, so every session in the process would otherwise read the SAME
 * credential set regardless of which provider account the router selected.
 *
 * An adapter constructed with a resolver calls it **at spawn time** — never at
 * construction — and uses its result as the CLI's HOME. Returning `undefined`
 * means "no account-scoped home applies" (a reserved API-key / env-OAuth route,
 * or a session with no pinned account), which keeps {@link agentHome}. It hands
 * the adapter a *path*, never credential material: the orchestrator still owns
 * what is written there.
 *
 * Spawn time, not construction time, because the agent object is created before
 * `prepareSessionAgentEnvironment` pins the route, and because a mid-session
 * failover repoints the session at a different account under the same runner.
 */
export type AgentHomeResolver = () => string | undefined;

/**
 * The HOME an agent CLI spawns with: the account-scoped root when a resolver
 * produced one, else the process-global {@link agentHome}. An empty string is
 * treated as "none" — spawning with `HOME=""` is worse than the global home.
 */
export function resolveAgentHome(scopedHome?: string): string {
  return scopedHome || agentHome();
}
