/**
 * Worker lifecycle-route authentication (SHI incident 2026-07-25, session
 * 6e1e22fa — the dogfooding self-kill).
 *
 * The session worker's `/agent/*` lifecycle endpoints (start, kill,
 * interrupt, …) are reachable by ANYTHING inside the session container on
 * 127.0.0.1:9100 — including the agent's own shell children. A test suite,
 * script, or stray process POSTing `/agent/start` can trip the
 * orchestrator-side persistent-409 recovery into killing the session's real
 * agent mid-turn (that is exactly what happened in production when the
 * integration tests ran in-container with fixtures pointing at 9100; the
 * fixture side was fixed separately — see
 * integration_tests/container-test-helpers.ts `allocateDeadLoopbackPort`).
 *
 * This module is the shared vocabulary for the structural fix: the
 * orchestrator generates a per-container secret at creation, passes it in
 * the container env, and sends it as a header on every lifecycle-mutating
 * worker call; the worker captures the secret at boot (removing it from
 * `process.env` BEFORE any child can inherit it) and rejects
 * lifecycle-mutating requests without the header.
 *
 * Threat model: this defends against ACCIDENTAL collisions and casual env
 * inheritance — the incident class. It is not a boundary against a
 * determined same-UID process (which could read /proc/<worker-pid>/environ
 * or signal the worker directly); container-level isolation is the boundary
 * for that.
 *
 * Used by both layers (orchestrator + session), hence `shared/`.
 */

import crypto from "node:crypto";

/** Env var the orchestrator sets on the container; consumed + deleted at worker boot. */
export const WORKER_LIFECYCLE_SECRET_ENV = "WORKER_LIFECYCLE_SECRET";

/** Header the orchestrator sends on lifecycle-mutating worker requests. */
export const WORKER_LIFECYCLE_SECRET_HEADER = "x-shipit-lifecycle-secret";

/**
 * The worker routes that mutate the agent slot / turn lifecycle and therefore
 * require the secret. Deliberately NOT a prefix match: the read-only
 * `GET /agent/status` stays open (health probes), and the agent-facing shim
 * surfaces (`/agent-ops/*`, `/services/*`, present, SSE) are untouched — the
 * legitimate `shipit agent run` path re-enters `/agent/spawn` via the
 * orchestrator, which holds the secret.
 */
const LIFECYCLE_PROTECTED_PATHS = new Set([
  "/agent/start",
  "/agent/interrupt",
  "/agent/kill",
  "/agent/spawn",
  "/agent/cancel",
  "/agent/stdin",
  "/agent/message",
  "/agent/permission-mode",
  "/agent/compact",
  "/agent/permission/resolve",
]);

/** Whether a request URL targets a lifecycle-protected worker route. */
export function isLifecycleProtectedPath(url: string): boolean {
  const q = url.indexOf("?");
  return LIFECYCLE_PROTECTED_PATHS.has(q === -1 ? url : url.slice(0, q));
}

/** Generate a fresh per-container lifecycle secret. */
export function generateLifecycleSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** Constant-time comparison of a request-supplied value against the secret. */
export function lifecycleSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Read the lifecycle secret out of a process env and DELETE it, so children
 * spawned later (agent CLIs, the terminal PTY) never inherit it. Called once
 * at worker boot, before any spawn. Returns undefined when unset (test /
 * subprocess mode — auth disabled, prior behavior).
 */
export function takeLifecycleSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const secret = env[WORKER_LIFECYCLE_SECRET_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional env scrub before child spawns
  delete env[WORKER_LIFECYCLE_SECRET_ENV];
  return secret || undefined;
}

/**
 * Recover the lifecycle secret from a container's `Config.Env` list (docker
 * inspect) — the rediscovery/adoption path after an orchestrator restart,
 * where the in-memory record is gone but the container (and its boot env)
 * persists.
 */
export function parseLifecycleSecretFromContainerEnv(
  env: readonly string[] | undefined,
): string | undefined {
  const prefix = `${WORKER_LIFECYCLE_SECRET_ENV}=`;
  const entry = env?.find((e) => e.startsWith(prefix));
  const value = entry?.slice(prefix.length);
  return value || undefined;
}
