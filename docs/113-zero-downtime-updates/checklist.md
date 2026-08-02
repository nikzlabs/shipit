# Checklist

- [x] `deploy.sh`: stop `docker rm -f`-ing session-worker and compose service containers on update (Phase 1)
- [x] `restart.sh`: same, and fix the stale "orchestrator drops that state" comment (predates docs/240)
- [x] Verify boot-time re-adoption covers the update path (rediscovery, orphan GC, docs/240 turn reattach)
- [x] Stamp `shipit-build-id` image label in `Dockerfile.session-worker.prod` (cache-safe, last instruction)
- [x] Log adopted worker build vs orchestrator build in `container-discovery.ts` (skew telemetry)
- [x] Wire-contract CI guard: `worker-wire-contract.test.ts` frozen-type assertions; name `/agent/start` body as shared `WorkerAgentStartBody`
- [x] Verified the guard trips typecheck on a non-additive change
- [x] Runtime `/version` handshake deliberately deferred until the first breaking worker change (see plan Status)
- [x] `npm run typecheck`, `npm run lint:dev`, affected tests green
