---
issue: https://linear.app/shipit-ai/issue/SHI-311
title: Session-worker trust boundary
description: Authenticate the session worker's HTTP surface so one session's container cannot drive another session's worker.
---

# Session-worker trust boundary (SHI-311)

Implements [requirements.md](./requirements.md).

Companion to `docs/201-container-api-trust-boundary/`, which guards the
**orchestrator's** API against container callers. This doc guards the other end
of the same channel: the **worker's** API against callers that are not its own
agent or the orchestrator.

## The finding

`docs/201` identified container origins by bridge source IP and default-denied
them to `/api/sessions/<own-id>/<allowlisted>`. That is sound for
agent→orchestrator traffic. It says nothing about agent→**worker** traffic, and
three facts combine to make that reachable (req 1):

- Every agent container joins the **same** orchestrator bridge network
  (`container-lifecycle.ts` → `NetworkMode: deps.networkName`, one name for the
  whole `SessionContainerManager`). The per-session `shipit-session-<id>` network
  is created only for docker-access sessions and is an *additional* attachment
  for their child containers — it does not isolate agent containers from each
  other.
- Each worker binds `0.0.0.0:9100` (`session-worker.ts`), because the
  orchestrator dials it by bridge IP.
- The egress sidecar's Tier A `OUTPUT` policy explicitly allows the local bridge
  subnet (`docker/egress-sidecar/init-firewall.sh` §3), and containment is
  per-session and deployment-gated anyway.

So session A can dial `http://agent-<first-12-of-B>:9100/agent-ops/…`. B's worker
serves it and relays to the orchestrator through B's own `OrchestratorClient`,
which injects **B's** session id — the orchestrator then sees B's worker IP
requesting something scoped to B and correctly allows it. The worker is the
confused deputy; every own-session-scoped agent capability is reachable for
another session that way.

## The fix

The two callers a worker legitimately has are distinguishable, so the boundary
is drawn once at `onRequest` rather than per route (req 2):

- **Its own agent** always dials `http://127.0.0.1:$WORKER_PORT` — the shims
  (`agent-shim/shim-common.ts:workerBaseUrl`), the consolidated `shipit` MCP
  bridge (`mcp-shipit-bridge.ts`), and the present tool's own screenshot URL. A
  container's loopback is reachable only from inside its own network namespace;
  a peer container's `127.0.0.1` is its own. That makes the TCP peer address an
  unforgeable "this is my agent" signal, needing no secret at all.
- **The orchestrator** arrives over the bridge and proves itself with a
  per-session bearer token, `x-shipit-worker-token`.

Hence two route classes:

| Class | Routes | Rule |
|---|---|---|
| Loopback-only | `/agent-ops/*`, `/present-files/*` | loopback, **token does not help** |
| Orchestrator-facing | everything else | loopback, or a matching token |
| Open | `/health` | always |

`/agent-ops/*` being loopback-only is what satisfies req 1, and it holds with no
token at all (req 5 / D2). `/present-files/*` joins it because `present-view.ts`
already *documented* those routes as reachable "only [from] `127.0.0.1`" — before
this guard that was aspirational, and any session could read another session's
presented artifacts. The orchestrator reads artifacts through
`/present/:presentId/raw`, which stays token-gated.

### Why the whole surface (D1)

Restricting only `/agent-ops/*` would leave the same cross-container reach on
routes that are strictly worse. Against another session's worker:
`POST /terminal/start` + `POST /terminal/input` is command execution in that
container; `POST /agent/message` injects a turn into its running agent;
`PUT /secrets` rewrites the env its next agent spawn inherits;
`POST /agent/kill` stops its turn. The mechanism that closes `/agent-ops` closes
these for free, so it does.

Loopback is allowed everywhere, including the orchestrator-facing routes. That is
not a gap: the agent already has a shell in its own container, so gating it
against its own worker would protect nothing that isn't already lost.

### Token lifecycle (req 4)

- **Generated** per container in `createContainer`, injected as
  `SHIPIT_WORKER_TOKEN`, and recorded on `SessionContainer.workerToken`.
- **Recovered** on adoption by reading it back out of the container's own
  `Config.Env` (`container-discovery.ts`, both the bulk rediscover and the
  single-session adopt). The container is the source of truth, so an orchestrator
  restart needs no persisted key — and a key file going missing can't 403 a live
  session.
- **Bound** to the worker base URL in `orchestrator/worker-auth.ts` and
  **cleared** on destroy (and on a failed create), so a recycled bridge IP never
  inherits the previous container's token.

The token is readable by the agent inside its own container. That grants nothing:
loopback already reaches that worker's whole surface, and the token is
per-session, so it opens no other worker.

### Why a registry keyed by base URL

The orchestrator's worker calls are spread over `worker-http.ts` (~35 call sites),
`sse-client.ts` and `overlay-snapshot.ts`, and almost all of them take a base URL
and nothing else. Threading a token parameter through them — and through
`setWorkerUrl`, `getWorkerUrl`, `fetchSnapshot`, the health prober and the
warm-pool pre-install — would put the burden on every future call site, where
forgetting it produces a 403 that reads like a dead container. Keying the lookup
on the base URL instead makes it automatic: the key is exact (one live container
per bridge IP) and is written at the three points where a
`SessionContainer.workerUrl` becomes known.

### Local mode (D4)

`RUNTIME_MODE=local` (the dogfood `dev` service) has no session worker and no
`/agent-ops` host at all — see `local-agent-mcp.ts:LOCAL_SHIPIT_BRIDGE` — so the
confused-deputy path does not exist there. The related note on SHI-311, that
`api-container-guard.ts`'s runtime denial is inert without a container manager,
is accurate and deliberately unchanged: a local agent runs in the orchestrator's
own process and filesystem and can read/write the SQLite database directly, so an
HTTP-layer session check would not be a boundary.

## Key files

- **`src/server/shared/worker-auth.ts`** (new) — the policy, shared by both
  layers so the header name, the loopback test and the loopback-only prefix list
  cannot drift. `decideWorkerRequest()` is pure and holds the whole decision.
- **`src/server/session/worker-auth-guard.ts`** (new) —
  `registerWorkerAuthGuard(app, { token, env, log })`: the Fastify `onRequest`
  wiring plus the "no token configured" startup warning. Registered **first** in
  `SessionWorker.buildApp()`. `env` defaults to `process.env` and exists so the
  no-token branch is testable — see [Token resolution](#token-resolution).
- **`src/server/session/session-worker.ts`** — registers the guard; new
  `workerToken` dep (defaults to the container env).
- **`src/server/orchestrator/worker-auth.ts`** (new) — token generation, the
  base-URL→token registry, `workerAuthHeaders()`, and
  `workerTokenFromContainerEnv()` for adoption.
- **`src/server/orchestrator/worker-http.ts`**, **`sse-client.ts`**,
  **`overlay-snapshot.ts`** — attach `workerAuthHeaders(baseUrl)` to the three
  transports the orchestrator uses.
- **`src/server/orchestrator/container-lifecycle.ts`** — generate + inject the
  token, register it when the worker URL is known, clear it on destroy/failure.
- **`src/server/orchestrator/container-discovery.ts`** — read the token back from
  an adopted container's env.
- **`src/server/orchestrator/session-container.ts`** — `workerToken?: string`.

No agent-facing surface changed: the shims, the MCP bridge and the container env
the agent reads are all unaffected, so nothing in `src/server/shipit-docs/`
needed an update.

## Why there is no per-route opt-in here

Deliberately unlike `docs/201`. There, the container-facing set is a small
allowlist scattered across many route modules, so the decision is co-located with
each route and pinned by a golden-table test. Here both classes are decided from
a path prefix, which means a newly-added `/agent-ops/*` route is protected by
construction — the "someone forgot the annotation" failure mode cannot occur.

## Verification

- `npx vitest run src/server/shared/worker-auth.test.ts src/server/session/worker-auth-guard.test.ts src/server/orchestrator/worker-auth.test.ts`
  — the policy table, the Fastify guard driven with `app.inject({ remoteAddress })`
  (a peer container IP is the attack, loopback is the agent, an orchestrator IP +
  token is the orchestrator), the registry, and the env read-back.
- `worker-auth-guard.test.ts` asserts against the **real** `SessionWorker` app,
  not a hand-built one, so reordering `buildApp` turns the build red.
- `npm test` — the worker integration tests exercise a real worker over
  `127.0.0.1` and are the regression guard for req 3.
- Manual smoke (containerized): from session A,
  `curl -X POST http://agent-<b-short-id>:9100/agent-ops/session/notify-on-merge-self`
  → 403; from A's own agent, `shipit`/`gh` shims and the `present`/`voice_note`
  tools still work.

## Token resolution

The guard resolves its token as `deps.token ?? env[WORKER_TOKEN_ENV]`, and the
env half is the **production** path, not a convenience default: `SessionWorker`
always passes the `token` key, and its own `workerToken` dep is unset in the
standalone entry point, so a live worker is gated only because the fallback
fires. That rules out "distinguishing an explicit `undefined` from an absent
key" as a way to make the no-token case unambiguous — an `in`-based check would
leave every real worker ungated.

Two consequences worth knowing before editing this file:

- **An empty env value means "no token", not an unmatchable one.** The
  orchestrator's `workerTokenFromContainerEnv` maps `SHIPIT_WORKER_TOKEN=` to
  `undefined` and so sends no header. A worker that held `""` as its expected
  token would 403 every orchestrator call — the bricked session that D3/step 5
  exists to prevent, reached through an empty value instead of an absent one.
  No orchestrator-created container hits it (`generateWorkerToken()` never
  returns empty, and a peer cannot alter another worker's environment), but a
  hand-configured container or a standalone worker launched with
  `SHIPIT_WORKER_TOKEN=` does. Note this moves a malformed-config worker from
  fail-*closed* to the D3 fail-open policy — deliberate: it is the same
  compatibility choice D3 already makes for an absent value, and the loopback-only
  rule that closes the reported hole needs no token either way.
- **`WORKER_TOKEN_ENV` is set in every session container, so a test asserting the
  no-token branch is not hermetic by default.** It passed in CI and failed
  in-container: `token: undefined` fell straight through to the ambient token and
  the branch was never exercised. `server-test-setup.ts` now strips the var
  suite-wide (the same treatment as the `GIT_CONFIG_*` injection), and
  `worker-auth-guard.test.ts` additionally pins `env` so the file does not depend
  on that setup. Tests cover both halves of the resolution.

## Known limitations

- The token gates the orchestrator-facing routes only when the worker was created
  by an orchestrator that injects it (D3). Containers created before this change
  keep their old behavior on those routes until they are recreated; req 1 does
  not depend on this.
- `SECURITY-MODEL.md` previously claimed sessions "cannot reach each other's
  containers" on the strength of per-session networks. That was wrong for agent
  containers, which share one bridge; the claim is corrected there to describe
  the boundary this doc actually builds.
