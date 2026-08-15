/**
 * planning#379 — the anti-framing (clickjacking) policy, as data.
 *
 * Split out from `orchestrator/frame-guard.ts`, which holds the reasoning and
 * the Fastify wiring, because **two different servers hand ShipIt's UI to the
 * browser** and both have to answer the same way:
 *
 *   - the orchestrator's own static handler, in a production image;
 *   - the **Vite dev server**, which serves the document in
 *     `docker/local/dev/compose.yml` (Vite on `CLIENT_DEV_PORT`, the
 *     orchestrator on `PORT`) and in the dogfood `dev` service.
 *
 * A policy that lived only in the Fastify hook would leave the dev stack's
 * document — a real, LAN-reachable ShipIt UI — frameable, because the
 * orchestrator never sees that response (review finding). So `vite.config.ts`
 * reads this module too; keep it free of Fastify and of anything heavy, since
 * it is imported by the build config.
 *
 * Read `orchestrator/frame-guard.ts` for why the policy is what it is, and in
 * particular why local mode opts out.
 */

import type { RuntimeMode } from "./types.js";

/**
 * Whether this deployment refuses to be framed.
 *
 * `"deny"` for every real deployment; `"permit"` only for the dogfood inner
 * orchestrator, which exists to be framed by the outer instance's preview pane.
 */
export type FramePolicy = "deny" | "permit";

/** The framing policy for a runtime mode. Local mode is the only `"permit"`. */
export function framePolicyFor(runtimeMode: RuntimeMode): FramePolicy {
  return runtimeMode === "local" ? "permit" : "deny";
}

/**
 * The framing policy from a raw `RUNTIME_MODE` value. For callers that read the
 * environment directly rather than holding a resolved {@link RuntimeMode} — the
 * Vite config is the whole population.
 */
export function framePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): FramePolicy {
  return framePolicyFor(env.RUNTIME_MODE?.toLowerCase() === "local" ? "local" : "containerized");
}

/**
 * The headers a policy sends. `"permit"` sends none — deliberately, rather than
 * a permissive `frame-ancestors *`, which would read as a grant to every site
 * instead of "this mode does not participate".
 */
export function frameGuardHeaders(policy: FramePolicy): Record<string, string> {
  if (policy === "permit") return {};
  return {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  };
}
