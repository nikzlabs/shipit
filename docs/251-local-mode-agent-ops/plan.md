---
issue: planning#319
title: The gh shim works in the dogfood inner ShipIt
description: A session-bound /agent-ops host for RUNTIME_MODE=local, so dogfood turns can open PRs and read CI instead of hitting "gh: not found".
---

# `gh` in the dogfood inner ShipIt

Implements [requirements.md](./requirements.md).

## The problem

The dogfood inner ShipIt (`RUNTIME_MODE=local`, the `dev` Compose service) runs
its agent inside `docker/Dockerfile.dogfood`, which installed neither the `gh`
shim nor the `shipit` shim. A dogfood turn that tried to open a PR got
`gh: not found` and said so (req 1, req 4).

Installing the binary alone would not have fixed it. The shim is an HTTP client
that POSTs to a worker's `/agent-ops/*` broker, and local mode has no worker —
so it would have traded `gh: not found` for a connection error, which is why the
Dockerfile change and the host land together.

## Why this is smaller than planning#305 implies

planning#305 scopes "an `/agent-ops` host for local mode" as one job covering the
`shipit` MCP bridge (`present`, `voice_note`, `propose_actions`,
`report_shipit_bug`, `permission_prompt`) *and* the two shims. That bundling is
what made it look expensive, and it is why `gh` sat in the backlog.

The two halves are not alike:

| | Where it is served | Cost in local mode |
|---|---|---|
| `gh`'s ~16 endpoints | **Relayed** — `agent-ops-routes.ts` forwards each to `/api/sessions/:id/…` and pipes the reply back 1:1, holding no state | path rewriting |
| `present` | **The worker** (`session-worker.ts:500`) — `PresentRegistry`, a `present_content` SSE, and `/present-files/<id>` for the agent's screenshot loop | a real host |
| `permission_prompt`, `ask` | **The worker** — blocking broker round-trips | a real host |

Verified rather than assumed, before any code was written: every PR/Actions
route the shim uses is a `relay(...)` call in `agent-ops-routes.ts`, and the
orchestrator routes behind them work in local mode today — a direct
`GET /api/sessions/<id>/actions/workflows` against the running inner
orchestrator returned the real repository's workflow list. Nothing about `gh`
needs the worker; it only needed something to talk to.

## Design

`orchestrator/local-agent-ops.ts` starts **one loopback host per session**,
bound to that session's id at construction, and hands its address to the CLI as
`SHIPIT_AGENT_OPS_URL`.

```
agent ──> gh (shim, unmodified) ──> 127.0.0.1:<ephemeral>/agent-ops/… ──> orchestrator /api/sessions/<id>/…
```

Four properties are deliberate:

- **The session is a property of the listener, not the request** (req 5). This
  is what the worker's broker gets from its `SESSION_ID` env, and what
  planning#305's own sketch — mount `/agent-ops` on the orchestrator keyed by a path
  segment — would have given up.
- **The allowlist is the security boundary.** `mapAgentOpsPath` returns `null`
  for anything the `gh` shim cannot emit, and `null` is a deny rather than a
  pass-through, so the agent reaches no more than the worker's own surface.
- **No shim change.** `shim-common.ts` already prefers `SHIPIT_AGENT_OPS_URL`
  over its `127.0.0.1:$WORKER_PORT` default; nothing had ever set it.
- **Fails open.** A host that cannot start logs and leaves `gh` unavailable for
  the turn rather than killing the turn.

### Why the mapping is reimplemented rather than imported

ESLint forbids `orchestrator/` importing from `session/` (a deliberate,
bidirectional layer boundary), so `registerAgentOpsRoutes` is out of reach. The
alternatives were weighed:

- **Move the router to `shared/`** — `shared/` is deliberately Fastify-free
  today, and the router's per-route querystring shaping does not reduce to a
  data table, so this is a refactor of a security-sensitive 697-line file.
- **A justified `eslint-disable`** — smallest diff, but suppresses an
  architectural guard.
- **Reimplement the `gh` subset orchestrator-side** — what local mode already
  does twice: `local-agent-mcp.ts` redoes the worker's pre-spawn MCP writes and
  `local-agent-home.ts` redoes its credential provisioning. Chosen, because it
  follows the established precedent and the `gh` surface is sixteen path
  rewrites rather than behavior.

The duplication is guarded, not merely accepted: `local-agent-ops.test.ts` reads
`agent-shim/gh.ts` and asserts every `/agent-ops/…` path it can emit is one this
host accepts, so a new `gh` subcommand fails the build here instead of silently
403-ing in the dogfood.

### Lifecycle

`ensureLocalAgentOpsHost` is awaited from `session-agent-env.ts`'s
`isLocalRuntime()` branch — the same pre-spawn seam as the Codex cold-start
gate, and for the same reason: the adapters spawn synchronously, so the URL has
to be in the registry before the spawn reads it. It is single-flight on the
session id (a session's later turns are a map hit, and concurrent turns cannot
start two listeners), and failures are not memoized. `applyLocalMcp` merges the
address into the spawn's temporary env; the runner's `disposed` event closes
the host.

## Scope

`gh` only, per the resolved question in requirements.md. The `shipit` shim is
**not** installed: it shares the plumbing but only works in part here
(`shipit service` needs a ServiceManager and local mode runs no Compose stacks;
`shipit agent run` spawns a sub-agent). It stays with the worker-served tools in
planning#305, whose remaining scope this narrows.

## Honest limits

- **This is session-binding, not a sandbox.** In local mode the agent shares a
  container with the orchestrator and `registerContainerOriginGuard` is inert
  without a `containerManager` (`api-container-guard.ts`), so a determined agent
  can already curl `/api/sessions/<any-id>/…` directly. Req 5 is met for the
  sanctioned path; the underlying exposure predates this and is not widened.
- **`gh pr merge` is not newly permitted.** The `dangerousGitHubOps` grant is
  enforced orchestrator-side (`pr-target.ts:159`,
  `api-routes-github.ts:1078`) off `session.capabilities`, so local mode
  inherits the same gate — verified at those call sites, not assumed.
- **Requirement 4 is met for the failure that prompted this** (`gh: not found`)
  and for a denied path (403) and an unreachable orchestrator (502, naming the
  address). A host that fails to start still leaves the shim reporting a generic
  unreachable-worker error.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/local-agent-ops.ts` | The host, the allowlist/mapping, the per-session registry |
| `src/server/orchestrator/local-agent-ops.test.ts` | Mapping, forwarding, session binding, registry — plus the drift guard against `gh.ts` |
| `src/server/orchestrator/session-agent-env.ts` | Awaits `ensureLocalAgentOpsHost` in the local branch, pre-spawn |
| `src/server/orchestrator/local-agent-mcp.ts` | Merges `SHIPIT_AGENT_OPS_URL` into the spawn env |
| `src/server/orchestrator/app-lifecycle.ts` | Passes the session id; closes the host on runner disposal |
| `docker/Dockerfile.dogfood` | Installs the `gh` shim at `/workspace` paths |

## Verification

Driven against the running dogfood instance, not only in unit tests: the
**unmodified** `gh` shim, pointed at a real host via `SHIPIT_AGENT_OPS_URL`,
ran `gh pr status`, `gh workflow list` and `gh run list` against the live
local-mode inner orchestrator and returned real GitHub data (the repository's
actual workflow and CI run IDs). `gh pr create` was deliberately not fired —
it would open a real PR on a real repository — so the create path is verified
to the orchestrator boundary via `pr status` and by unit-testing the
`pr/create` → `pr/agent-create` rewrite.
