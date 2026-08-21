---
issue: planning#313
title: Session-worker trust boundary
description: Authenticate the session worker's HTTP surface so one session's container cannot drive another session's worker.
---

# Session-worker trust boundary (planning#313)

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
confused-deputy path does not exist there. The related note on planning#313, that
`api-container-guard.ts`'s runtime denial is inert without a container manager,
is accurate and deliberately unchanged: a local agent runs in the orchestrator's
own process and filesystem and can read/write the SQLite database directly, so an
HTTP-layer session check would not be a boundary.

## Key files

- **`src/server/shared/worker-auth.ts`** (new) — the policy, shared by both
  layers so the header name, the loopback test and the loopback-only prefix list
  cannot drift. `decideWorkerRequest()` is pure and holds the whole decision.
- **`src/server/session/worker-auth-guard.ts`** (new) —
  `registerWorkerAuthGuard(app, { token, log })`: the Fastify `onRequest` wiring
  plus the "no token configured" startup warning. Registered **first** in
  `SessionWorker.buildApp()`. Also `requireWorkerToken(env)` /
  `MissingWorkerTokenError` (planning#421), the container's one reader of
  `SHIPIT_WORKER_TOKEN`.
- **`src/server/session/session-worker.ts`** — registers the guard; `workerToken`
  dep, resolved by the container entry point via `requireWorkerToken`, which
  exits the process when the variable is missing or empty.
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
  not a hand-built one, so reordering `buildApp` turns the build red. It also
  runs the container entry point as a subprocess exactly as the container's `Cmd`
  does (`node --import tsx session-worker.ts`) and asserts it exits 1 without
  binding a port when `SHIPIT_WORKER_TOKEN` is absent (planning#421) — the top-level
  `if (import.meta.url.endsWith(argv[1]))` block is unreachable in-process. Only
  the refusal direction is tested there: the positive one would bind 9100, which
  collides with the worker of any container the suite runs in. It needs no test
  of its own — an entry point that stopped passing the token would leave every
  production worker refusing the orchestrator outright, which is loud, where
  before planning#421 the same slip silently *ungated* it.
- `npm test` — the worker integration tests exercise a real worker over
  `127.0.0.1` and are the regression guard for req 3.
- Manual smoke (containerized): from session A,
  `curl -X POST http://agent-<b-short-id>:9100/agent-ops/session/notify-on-merge-self`
  → 403; from A's own agent, `shipit`/`gh` shims and the `present`/`voice_note`
  tools still work.

## Token resolution, and failing closed (planning#421, req 6)

**One reader.** The container entry point (`session-worker.ts`, the
`import.meta.url === argv[1]` block) calls `requireWorkerToken(process.env)`
before it builds anything, and hands the result to `SessionWorker`. The guard
itself reads no environment: `registerWorkerAuthGuard` gates on `deps.token`
alone. That block is the only place that knows this process is a real container —
an in-process test worker never runs it — which is what lets the requirement be
absolute there without softening it everywhere else.

**Closed means the container does not serve.** A worker that cannot authenticate
its orchestrator cannot tell it from a peer container, so there is no useful
state for it to serve from: `requireWorkerToken` throws, the entry point logs one
line naming `SHIPIT_WORKER_TOKEN` and exits 1 before the server listens, so
`/health` never answers and creation fails at `waitForWorkerHealth`
(`container-lifecycle.ts:691`, a 30s poll that throws). The alternative — serve,
but refuse the orchestrator-facing routes — leaves a container that is up,
adopted, and answering `/health` while being unable to do anything the
orchestrator asks; the failure then surfaces as a session that mysteriously does
nothing rather than as a container that failed to start.

**The policy layer fails closed too**, as the second layer rather than the first:
`decideWorkerRequest` step 6 denies every non-loopback caller when no token is
configured. That is the rule
[`docs/271-agent-install-trust-boundary`](../271-agent-install-trust-boundary/plan.md)
depends on and does not own — its `agent.install` gate sits at `runInstall`, not
on the worker's `/install` route, and `compose-service-egress.ts` lets a
contained plugin service reach the agent container. `worker-auth.test.ts` and
`worker-auth-guard.test.ts` (the latter against the real `SessionWorker` route
table) now fail if that rule is relaxed, which a paragraph in a plan could not.

**Why this cannot brick a session (req 5).** The skew req 5 is about is a
container that outlives a deploy — and such a container keeps running the image
it was created from, so it never runs this code. The reverse pairing, this worker
image created by an orchestrator with no token to inject, needs an orchestrator
older than v0.3.0 (2026-08-04, when `container-lifecycle.ts` started injecting
the token unconditionally) *and* a container created inside that deploy's build
window — `deployment/vps/deploy.sh` builds the image before restarting the
orchestrator, so the window exists, but only on an upgrade crossing that release.
There, creating a session fails during the build window and succeeds on the next
attempt; nothing running is affected.

**An empty value is "no token", not an unmatchable one.** The orchestrator's
`workerTokenFromContainerEnv` maps `SHIPIT_WORKER_TOKEN=` to `undefined` and so
sends no header, so a worker holding `""` would 403 every orchestrator call while
looking healthy. `requireWorkerToken` treats it as absent and refuses to start —
the same outcome for a malformed config as for a missing one, and a much easier
one to read in the logs.

**Test hermeticity.** `WORKER_TOKEN_ENV` is set in every session container, so
before planning#421 a test meaning "a worker with no token" silently picked up the
ambient value through the guard's env fallback — passing in CI, failing in a
dogfood container. With the fallback gone, `token: undefined` means what it says.
`server-test-setup.ts` still strips the var suite-wide as cheap insurance for any
future code that reads it from `process.env`.

## Known limitations

- A container created by an orchestrator that predates the token keeps its old
  behavior on the orchestrator-facing routes, because it also keeps running its
  old worker image; req 1 does not depend on this, and planning#421's fail-closed
  rule applies from the image that carries it onward.
- `SECURITY-MODEL.md` previously claimed sessions "cannot reach each other's
  containers" on the strength of per-session networks. That was wrong for agent
  containers, which share one bridge; the claim is corrected there to describe
  the boundary this doc actually builds.
