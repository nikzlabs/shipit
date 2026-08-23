# Checklist — session-worker trust boundary (planning#313)

## Policy
- [x] `shared/worker-auth.ts`: header/env constants, `isLoopbackAddress`, `isLoopbackOnlyPath`, `tokensMatch` (constant-time), `generateWorkerToken`, and the pure `decideWorkerRequest`.
- [x] `/agent-ops/*` and `/present-files/*` are loopback-only — a valid token does not open them (req 1, D2).
- [x] `/health` stays open so `waitForWorkerHealth` and container probes work before any token exists.
- [x] ~~No token configured → orchestrator-facing routes stay open, with a startup warning (req 5, D3).~~ Reversed by planning#421 below.

## Fail closed (planning#421, req 6)
- [x] `decideWorkerRequest` step 6 denies every non-loopback caller when no token is configured; loopback (the container's own agent) is unaffected.
- [x] `requireWorkerToken(env)` + `MissingWorkerTokenError` in `worker-auth-guard.ts`; empty value treated as absent.
- [x] The container entry point resolves the token and `process.exit(1)`s with one line naming the variable, instead of serving.
- [x] `registerWorkerAuthGuard` no longer reads `process.env` — one reader, at the entry point.
- [x] Tests that fail on the pre-fix code: policy table (`/install`, `/terminal/start`, `/agent/start` from a peer), the Fastify guard, and a peer's `POST /install` against the real `SessionWorker` route table.
- [x] `requireWorkerToken` unit tests (present / absent / empty), plus an end-to-end one that runs the entry point the way the container does (`node --import tsx session-worker.ts`) and asserts it exits 1 without binding a port.
- [x] `SECURITY-MODEL.md` and `server-test-setup.ts` rationale updated. (The `docs/271-agent-install-trust-boundary` item this also updated is gone — that feature was removed on 2026-08-21.)

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
- [x] `shared/worker-auth.test.ts` — policy table incl. the planning#313 regression (peer container + valid token → denied on `/agent-ops`).
- [x] `session/worker-auth-guard.test.ts` — `app.inject({ remoteAddress })` for peer / loopback / orchestrator, plus the real `SessionWorker` app.
- [x] `orchestrator/worker-auth.test.ts` — registry lifetime, trailing-slash key, env read-back.
- [x] `npm test` full suite green.
- [x] `npm run lint:dev` + `npm run typecheck` clean.

## Docs + close-out
- [x] `SECURITY-MODEL.md` — correct the "sessions cannot reach each other's containers" claim and describe the worker boundary.
- [x] Cross-reference from `docs/201-container-api-trust-boundary/`.
- [x] Comment on planning#313.
- [x] PR with `Closes planning#313`.
