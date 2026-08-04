# Checklist — session-worker trust boundary (SHI-311)

## Policy
- [x] `shared/worker-auth.ts`: header/env constants, `isLoopbackAddress`, `isLoopbackOnlyPath`, `tokensMatch` (constant-time), `generateWorkerToken`, and the pure `decideWorkerRequest`.
- [x] `/agent-ops/*` and `/present-files/*` are loopback-only — a valid token does not open them (req 1, D2).
- [x] `/health` stays open so `waitForWorkerHealth` and container probes work before any token exists.
- [x] No token configured → orchestrator-facing routes stay open, with a startup warning (req 5, D3).

## Worker
- [x] `session/worker-auth-guard.ts`: `registerWorkerAuthGuard(app, { token, log })` wiring `onRequest`, 403 + one log line per denial.
- [x] Registered first in `SessionWorker.buildApp()`; `workerToken` dep defaults to `SHIPIT_WORKER_TOKEN`.

## Orchestrator
- [x] `orchestrator/worker-auth.ts`: base-URL→token registry, `workerAuthHeaders()`, `workerTokenFromContainerEnv()`.
- [x] `worker-http.ts` (`workerPost`/`workerPut`/`workerGet`), `sse-client.ts` (`/events`), `overlay-snapshot.ts` (`/workspace/*`) attach the header.
- [x] `container-lifecycle.ts`: generate + inject `SHIPIT_WORKER_TOKEN`, register on `sc.workerUrl`, clear on destroy and on failed create.
- [x] `container-discovery.ts`: read the token back from `Config.Env` in both adoption paths.
- [x] `SessionContainer.workerToken`.

## Tests
- [x] `shared/worker-auth.test.ts` — policy table incl. the SHI-311 regression (peer container + valid token → denied on `/agent-ops`).
- [x] `session/worker-auth-guard.test.ts` — `app.inject({ remoteAddress })` for peer / loopback / orchestrator, plus the real `SessionWorker` app.
- [x] `orchestrator/worker-auth.test.ts` — registry lifetime, trailing-slash key, env read-back.
- [x] `npm test` full suite green.
- [x] `npm run lint:dev` + `npm run typecheck` clean.

## Docs + close-out
- [x] `SECURITY-MODEL.md` — correct the "sessions cannot reach each other's containers" claim and describe the worker boundary.
- [x] Cross-reference from `docs/201-container-api-trust-boundary/`.
- [x] Comment on SHI-311.
- [x] PR with `Closes SHI-311`.
