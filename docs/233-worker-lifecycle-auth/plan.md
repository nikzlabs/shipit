---
issue: https://linear.app/shipit-ai/issue/SHI-239
title: Worker lifecycle-route authentication
description: Per-container shared secret so nothing inside a session container can start or kill the resident agent via the worker's /agent/* routes.
---

# Worker lifecycle-route authentication

## Why

Prod incident 2026-07-25 (session 6e1e22fa): an agent session working on the
ShipIt repo ran `npx vitest run src/server/orchestrator/integration_tests/`,
whose fixtures pointed a real in-process test orchestrator at
`127.0.0.1:9100` — the session's own live worker. The test's
`ProxyAgentProcess` got 409 "Agent already running" from `/agent/start`, and
the orchestrator-side persistent-409 recovery (docs/142 Problem B2) escalated
to `/agent/kill`: the real agent running vitest was SIGTERM'd mid-turn, and a
rogue one-shot CLI ran invisibly in the user's workspace.

The fixture side was fixed first (dead loopback ports — see
`integration_tests/container-test-helpers.ts` `allocateDeadLoopbackPort` and
the tripwire in `integration_tests/dead-worker-port.test.ts`). This feature is
the structural half: the worker's lifecycle-mutating `/agent/*` endpoints were
callable by ANYTHING inside the container — including the agent's own shell
children — so any accidental caller could reproduce the class. Now they
require an orchestrator-issued secret.

## How it works

- **Create:** `createContainer` (container-lifecycle.ts) generates a
  per-container secret (`generateLifecycleSecret`), passes it in the container
  env as `WORKER_LIFECYCLE_SECRET`, and records it on the `SessionContainer`
  (`lifecycleSecret`).
- **Worker boot:** the standalone entry in `session-worker.ts` calls
  `takeLifecycleSecretFromEnv(process.env)`, which reads the secret and
  DELETES the env var before any child spawns — agent CLIs and the terminal
  PTY never inherit it. With a secret configured, an `onRequest` hook rejects
  lifecycle-protected requests without a matching
  `x-shipit-lifecycle-secret` header (401, constant-time compare).
- **Protected set** (`isLifecycleProtectedPath`, exact paths): `/agent/start`,
  `/agent/interrupt`, `/agent/kill`, `/agent/spawn`, `/agent/cancel`,
  `/agent/stdin`, `/agent/message`, `/agent/permission-mode`,
  `/agent/compact`, `/agent/permission/resolve`. Deliberately open: `GET
  /agent/status` (health probes), `/agent-ops/*` (shim brokers — the
  legitimate `shipit agent run` path re-enters `/agent/spawn` via the
  orchestrator, which holds the secret), `/services/*`, `/secrets`, `/events`,
  present, terminal, files, install.
- **Orchestrator calls:** `WorkerHttpOpts.headers` carries extra headers;
  `ContainerSessionRunner.lifecycleOpts()` merges the header into every
  protected call. The secret travels with the worker URL
  (`setWorkerUrl(url, secret)`), threaded at the three wiring sites in
  `app-lifecycle.ts` (fresh create, standby poll, reconnect-to-existing).
- **Restart recovery:** rediscovery/adoption (`container-discovery.ts`) parses
  the secret back out of `docker inspect` `Config.Env`
  (`parseLifecycleSecretFromContainerEnv`) — no orchestrator-side persistence.
- **Back-compat:** a worker with no secret configured (tests, subprocess mode)
  and a runner with no known secret (a pre-guard container rediscovered by a
  new orchestrator) both behave exactly as before; the guard only arms when
  the orchestrator issued a secret at create.

## Threat model

Defends against ACCIDENTAL collisions and casual env inheritance — the
incident class. It is not a boundary against a determined same-UID process
(which could read `/proc/<worker-pid>/environ` or signal the worker
directly); container-level isolation remains the boundary for that.

## Key files

- `src/server/shared/worker-auth.ts` — constants, protected-path set,
  generate/compare/scrub/parse helpers (+ `worker-auth.test.ts`)
- `src/server/session/session-worker.ts` — guard hook, boot-time env scrub
- `src/server/orchestrator/container-lifecycle.ts` — secret generation + env
- `src/server/orchestrator/container-discovery.ts` — inspect-env recovery
- `src/server/orchestrator/container-session-runner.ts` — `lifecycleOpts()`
  header on protected calls
- `src/server/orchestrator/worker-http.ts` — `headers` support
- `src/server/orchestrator/app-lifecycle.ts` — secret threading to runners
- `src/server/orchestrator/integration_tests/worker-lifecycle-auth.test.ts` —
  guard behavior incl. the incident-shape regression test
