/**
 * The names a session worker tries after `SHIPIT_HOST`, which goes stale when
 * ShipIt's container is recreated. The contained resolver must forward every
 * one of them, so both read this list (planning#626).
 */
export function orchestratorFallbackHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  // `||`: the worker is never given an empty value (buildOrchestratorCallbackEnv), so it means the default.
  return (env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS || "shipit")
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}
