---
issue: https://linear.app/shipit-ai/issue/SHI-129
title: Container ↔ browser trust boundary on the orchestrator API
description: Default-deny the orchestrator API for session-container-originated requests, restricting them to a narrow per-session callback allowlist identified by bridge IP.
---

# Container ↔ browser trust boundary on the orchestrator API

## Context

Session containers (where the semi-trusted agent runs) can today reach the **entire**
orchestrator HTTP API with **no caller authentication and no origin check**. Every
container gets `SHIPIT_HOST` / `SHIPIT_PORT` injected (`buildOrchestratorCallbackEnv` in
`container-lifecycle.ts`) so the agent can query the few legitimate container-facing
endpoints (service status, logs). But the orchestrator is a single Fastify instance on
one port shared with the container over the Docker bridge network — there is no
worker-only port, no auth middleware, no origin validation, and the CORS hook accepts any
origin. So `curl http://$SHIPIT_HOST:$SHIPIT_PORT/api/...` from inside a container hits
the **full** route surface.

A prompt-injected agent can therefore escalate beyond its box by calling the control
plane: add/edit/delete MCP servers (`POST/PUT/DELETE /api/mcp-servers`, whose
`refreshAgentEnvForAllSessions` makes the blast radius **global across all sessions**),
write secrets for any repo (`PUT /api/secrets`, no ownership check), and reach the rest of
`/api/*` generally. This is the same containment family as `docs/172-agent-containment`,
and it is the prerequisite for making the egress allowlist (SHI-90) UI-configurable
safely — until there's a caller trust boundary, no orchestrator-side setting is safe to
expose as an agent-reachable mutation.

Tracked by **SHI-129**.

## The finding (two caller paths, only one guarded)

1. **Brokered path (legitimate).** agent → `gh` / `shipit` shims → the worker's
   `/agent-ops/*` localhost routes (`session/agent-ops-routes.ts`) → `OrchestratorClient`
   → orchestrator. `OrchestratorClient.url()` (`session/orchestrator-client.ts:105`)
   hardcodes **every** call to `/api/sessions/<ownSessionId>/...` and the worker injects
   the trusted `SESSION_ID`. The agent cannot choose the path or the session.
2. **Raw path (the vulnerability).** agent → `curl $SHIPIT_HOST:$SHIPIT_PORT/api/...` →
   the entire route surface, unauthenticated.

The brokered router even documents the assumption it relies on: *"The real security gate
lives on the orchestrator's API surface — this router just narrows what the agent can
request."* That gate does not exist yet. This doc adds it.

## Handler-by-handler audit

A container legitimately needs only a small subset of the API, and **every legitimate
call is under `/api/sessions/:id/*`** (the brokered client cannot construct any other
shape). The allowlist below is derived from the `agent-ops-routes.ts` relay targets plus
the two direct-curl endpoints advertised in `agent-instructions.ts:318`.

### Allow (container-facing callback surface — own session only)

| Suffix (under `/api/sessions/<ownId>/`) | Methods | Source |
|---|---|---|
| `services`, `services/:name/logs` | GET | documented direct curl (`agent-instructions.ts`) |
| `pr/agent-create`, `pr/status`, `pr/view`, `pr/list` | POST/GET | gh shim |
| `pr/:number` | PATCH | gh shim |
| `pr/:number/comment`, `pr/:number/ready`, `pr/:number/close`, `pr/:number/reopen` | POST | gh shim |
| `git/credential` | POST | git credential helper |
| `issue/view`, `issue/list` | GET | `shipit issue` |
| `issue/create`, `issue/comment`, `issue/edit`, `issue/status`, `issue/assign` | POST | `shipit issue` |
| `source/status\|tree\|search\|cat\|log\|blame\|show` | GET | `shipit source` (ops sessions) |
| `agent/spawn` | POST | `shipit agent run` |
| `spawn` | POST | `shipit session create` |
| `children`, `children/:childId` (incl. `?wait`) | GET | `shipit session list/view/wait` |
| `children/:childId/message`, `children/:childId/archive`, `children/:childId/notify-on-merge` | POST | `shipit session ...` |
| `review-submit`, `voice-note`, `bug-report` | POST | review / voice_note / report_shipit_bug bridges |

> The children/spawn routes are keyed on `:parentId` in the route definition, but the path
> segment is still the **caller's own session id** (the worker injects itself as parent),
> so the own-session check below covers them uniformly.

### Deny (browser-only — a container must never reach these)

- **All global routes**: `/api/mcp-servers*`, `/api/secrets`, `/api/bootstrap`,
  `/api/repos`, `/api/sessions/all`, `/api/github/repos`, `/api/trackers/*`,
  `/api/marketplaces/*` + `/api/plugins/*`, `/api/voice/*` (the non-session ones),
  `/api/limits/*`, `/api/updates/*`, `/api/host/*`, `/api/provider-accounts`.
- **Non-allowlisted `/api/sessions/:id/*` routes the UI uses**: `history`, `files`,
  `docs`, `usage`, `status`, `worktrees`, `workspace-state`, `git/log|diff|diff-vs-branch|
  push|pull|merge|rebase|rebase/abort|rollback`, `pr/merge|auto-merge|fix-ci|quick|review|
  description|comments|merge-method|auto-fix-pause|threads/*`, `container/health|restart`,
  `agent/kill|dispatch`, `agent/container/restart`, `diagnostics`, `preview-status|
  preview-errors`, `present/:id/content`, `file-reviews/*`, `agent-reviews/*`.
- **Any `/api/sessions/<otherSessionId>/*`** — cross-session access, even to an
  allowlisted suffix.

So the enforced rule collapses to: **a container-originated request is valid iff it is
`/api/sessions/<its-own-session>/<allowlisted-suffix>`; everything else is 403.**

## Design — bridge-IP origin guard (default-deny for containers)

Identify container-originated requests by **TCP source IP**, the same unforgeable signal
the Docker proxy already trusts (`docker-proxy.ts:493-503`): each session container has a
unique bridge IP, `NET_RAW` is dropped so it cannot spoof another, and the orchestrator
already maps IP → session via `containerManager.getSessionByContainerIp(ip)`
(`session-container.ts:818`). The agent cannot omit its source IP to escape the check.

A single Fastify `onRequest` hook on the orchestrator app:

1. Normalize `request.socket.remoteAddress` (strip `::ffff:` exactly as
   `docker-proxy.ts:499`). **Never** consult `X-Forwarded-For` — the agent could set it.
2. `const caller = containerManager?.getSessionByContainerIp(ip)`.
   - **No match** → browser / host / proxy origin → **return** (unchanged; the deployment
     access layer remains the gate for browser callers, per `SECURITY-MODEL.md`).
   - **Match** → container-originated for `caller.sessionId`. Then, in order:
     - **Hard-deny backstop (§3 below):** if the path matches the high-value-global
       prefix list, `reply.code(403)` immediately — regardless of any allow flag.
     - **Per-route opt-in (§2 below):** require `request.routeOptions.config?.containerAccessible === true`.
       Absence (the default for every route) → `403`.
     - **Own-session scope:** require the request to be
       `/api/sessions/<caller.sessionId>/...` — an allowed route reached for a *different*
       session id is still `403`.

Why bridge-IP and not a token: zero container-side changes (no env, no shim, no rotation),
and it reuses a signal already proven in the Docker proxy. In local/dogfood mode there is
no bridge network and no real container, so `getSessionByContainerIp` returns `undefined`
and the guard is inert — which is correct, since there is no untrusted container origin
there.

## Keeping the boundary from eroding (durability)

The guard is **fail-closed**: because container requests are default-denied, a newly-added
handler is automatically unreachable by containers — nobody has to remember to protect it.
The *only* regression vector is widening the container-reachable set. Three mechanisms make
widening a deliberate, reviewed, test-enforced act:

1. **Executable golden-route-table test (the must-have).** Same "executable contract"
   pattern as `CARD_MESSAGE_FIELDS` (`CLAUDE.md`). A test boots the app in test mode,
   introspects the **live** Fastify route table (collected via an `onRoute` hook or
   `app.printRoutes()`), computes the exact set of `(method, path)` a container request
   would pass the guard for, and asserts it **deep-equals a committed golden snapshot**.
   Any change to that set — a new opt-in, or a route that newly matches — turns the build
   red and forces a conscious update that surfaces in PR review. This is what makes the
   boundary self-enforcing rather than convention.

2. **Per-route opt-in (replaces the central regex table).** Each container-facing route
   declares access inline at its definition:

   ```ts
   app.get("/api/sessions/:id/services", { config: { containerAccessible: true } }, handler)
   ```

   The guard reads `request.routeOptions.config?.containerAccessible`; **absence = deny**.
   This co-locates the security decision with the handler (visible in the diff that adds
   the route) and structurally eliminates the over-broad-regex class — a flag can only ever
   match its own route, never a future sibling. The routes that receive the flag are
   exactly the **Allow** table in the audit above.

3. **Independent hard-deny backstop.** A separate, unconditional `403` for the known
   high-value globals — `/api/secrets`, `/api/mcp-servers*`, `/api/provider-accounts`,
   `/api/trackers/*`, `/api/updates/*` — evaluated for container origins *before* the
   allow check and regardless of its result. Cheap belt-and-suspenders: even a mistaken
   `containerAccessible: true` on one of these can never expose the crown jewels.

### Files

- **New `src/server/orchestrator/api-container-guard.ts`** — exports
  `registerContainerOriginGuard(app, { containerManager })` (wires the `onRequest` hook:
  source-IP normalization → `getSessionByContainerIp` → hard-deny backstop → per-route
  `containerAccessible` check → own-session scope) plus a pure
  `isHardDeniedGlobal(pathname): boolean` for the §3 backstop list, kept a pure function so
  it's unit-testable in isolation.
- **The container-facing route modules** (`api-routes-github.ts`, `api-routes-issues.ts`,
  `api-routes-source.ts`, `api-routes-preview.ts`, `api-routes-agent.ts`,
  `api-routes-session.ts`, `api-routes-voice.ts`, `api-routes-bug-report.ts`,
  `api-routes-reviews.ts`) — add `config: { containerAccessible: true }` to **exactly** the
  routes in the **Allow** table. Every other route is left untouched (default-deny).
- **`src/server/orchestrator/api-routes.ts`** — call `registerContainerOriginGuard` at the
  **top** of `registerApiRoutes` (before the domain route modules) so the hook runs ahead
  of every handler. `deps.containerManager` is already an (optional) `ApiDeps` field; the
  guard is a no-op when it's absent.
- **`src/server/shared/types`** (or a local `declare module "fastify"` augmentation) — add
  the optional `containerAccessible?: boolean` field to Fastify's route `config` type so
  the flag is type-checked at each route definition.
- **New `src/server/orchestrator/api-container-guard.test.ts`** — (a) the **golden-route-table
  test**: boot the app in test mode, enumerate the live route table, compute the
  container-reachable set, assert it deep-equals the committed snapshot; (b) hook behavior
  via `app.inject({ remoteAddress })` with a stubbed
  `containerManager.getSessionByContainerIp` — own-session allow route passes, global +
  non-allowlisted + cross-session 403, hard-denied global 403 even if mis-flagged,
  non-container origin reaches everything; (c) unit-test `isHardDeniedGlobal`.
- **`SECURITY-MODEL.md`** — document the new container-vs-browser boundary under "Agent
  and container containment" and update the "No orchestrator-level user auth" note to
  reflect that container callers are now default-denied to a narrow per-route allowlist.
- **`docs/172-agent-containment/`** — cross-reference: this closes the open-API gap.

## Verification

- `npx vitest run src/server/orchestrator/api-container-guard.test.ts` — golden
  container-reachable route table + `isHardDeniedGlobal` unit table + hook behavior.
- Integration assertions: from a stubbed container IP, `PUT /api/secrets` and
  `POST /api/mcp-servers` → 403 (and stay 403 even if someone adds `containerAccessible`,
  via the hard-deny backstop); `GET /api/sessions/<ownId>/services` and
  `POST /api/sessions/<ownId>/pr/agent-create` → pass through;
  `GET /api/sessions/<otherId>/services` → 403; and a non-container `remoteAddress` reaches
  everything (regression guard for the browser path).
- `npm run lint:dev && npm run typecheck`.
- Manual smoke (optional, containerized): from inside a session container,
  `curl $SHIPIT_HOST:$SHIPIT_PORT/api/mcp-servers` → 403, while the documented
  `.../services` curl and the `gh` / `shipit` shims still work.

## Out of scope / follow-ups

- **Docker-proxy create-time network ownership (SHI-135) — fixed.** The bridge-IP guard
  here identifies container origins via `getSessionByContainerIp`, which only knows
  session-worker containers. A Docker-enabled agent could create a **child** container on a
  foreign named network (e.g. the orchestrator's) whose IP isn't in that map, so the guard
  treated it as a trusted browser origin. Root cause was an asymmetry in the Docker proxy:
  `POST /networks/{id}/connect` enforced `networkBelongsToSession` but `POST /containers/create`
  did not. `sanitizeContainerCreate` now ownership-checks any named `NetworkMode` and every
  `NetworkingConfig.EndpointsConfig` entry, mirroring the connect route. See SHI-135.
- Scoping the **global** blast radius of the genuinely-browser-driven mutations
  (`refreshAgentEnvForAllSessions`) is a separate hardening item; this doc removes the
  container's ability to *trigger* them, which is the SHI-129 acceptance bar.
- Per-session signed token (SHI-129 direction option b) as defense-in-depth for any future
  non-bridge topology — deferred; bridge-IP covers the current containerized model.
