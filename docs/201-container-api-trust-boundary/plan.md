---
issue: planning#131
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
and it is the prerequisite for making the egress allowlist (planning#92) UI-configurable
safely — until there's a caller trust boundary, no orchestrator-side setting is safe to
expose as an agent-reachable mutation.

Tracked by **planning#131**.

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

## How a caller is resolved, and what that resolution costs

The hook is registered at the **root**, so it runs for every request the orchestrator
serves — the browser's included, and the `/ws/sessions/:id` upgrade with them. Step 2
above is therefore on the critical path of the whole UI, and its two halves have very
different costs. `getSessionByContainerIp` is an in-memory map of the agent containers
ShipIt created, so an agent's request is resolved with no I/O. Everything else —
planning#371's *other* containers of a session, the Compose services and the sidecars
sharing their namespaces — is resolved through `getSessionByAnyContainerIp`, which reads
an IP → session index built from one `listContainers` filtered on `shipit-parent-session`.

**A browser IP is in neither, so it is a miss in both.** Refreshing that index on the miss
therefore put a Docker round-trip in front of every browser request. On a production host
carrying 259 containers (35 live sessions, 128 of them egress sidecars) the query measured
0.70–1.19 s against the 1 s timeout it was raced with, so it failed about as often as it
succeeded; the failure path then cleared the negative cache and awaited a *second* Docker
operation before giving up. Session switches showed "Reconnecting to server…" for a
couple of seconds, and new-session creation was slow for the same reason.

The index is kept warm by a background loop instead (`session-container.ts`,
`ORIGIN_INDEX_REFRESH_MS`), and a snapshot younger than `ORIGIN_INDEX_FRESH_MS` answers a
lookup from memory. **What makes that safe is that the snapshot is a proof of absence, not
merely a cache**: it enumerates every container carrying the label, so a miss against a
fresh snapshot is as authoritative as a hit — *at the instant it was taken*. Keeping that
true afterwards is the whole design, and it rests on two things, neither of which is the
refresh cadence.

### 1. A bracket, not a notification

`beginContainerTopologyChange()` is opened **before** an operation that can start a
labelled container (or hand one a new address) and closed after it; while any bracket is
open, a completing snapshot publishes its map but **not** its freshness stamp, so no miss
can be read as absence. Comparison is by a monotonic **generation counter**, never by wall
clock: a same-millisecond tie between an announcement and a snapshot resolves the wrong
way, and a wall-clock step resolves it wrongly for as long as the step. The request path's
own "did I join a snapshot that predates me?" test uses `<=` for the same reason.

The ordering is the point. `docker compose up` and `POST /containers/{id}/start` both
return with the container **already running**, so anything announced afterwards has
already lost the race to that container's own entrypoint. Three callers open brackets:

- **`ComposeCli`** — around `up` / `upService`, **retry included**. The bracket sits on
  `upWithConflictRecovery` rather than on the single `run` beneath it because the first
  attempt can start some services before failing on a container-name conflict, and a
  per-command bracket closes in that gap with those services already running. `stop` and
  `down` are deliberately outside it: neither can bring a caller into existence, and `down`
  waits out every service's stop grace period.
- **The Docker API proxy** (`docker-proxy.ts`) — around `containers/{id}/start`,
  `containers/{id}/restart` and `networks/{id}/connect`, taken **inside the handler,
  immediately before forwarding an already-authorised request**, never at dispatch. The
  caller here is the semi-trusted agent, and a bracket opened before the body is read lets
  a deliberately slow request hold every browser request on the Docker path.
  `sanitizeContainerCreate` *stamps* the label on every container a Docker-enabled agent
  creates, so those containers are callers this boundary denies, and the agent — not
  ShipIt — chooses when they start. Those handlers **await** the daemon exchange;
  `pipeToDocker` was fire-and-forget, which closed the bracket before the daemon had been
  asked to start anything.

  Which routes, not "every mutating method", and the scoping cuts both ways. A bracket
  suspends the fast path, so bracketing `docker logs -f` or a long `exec` would put a
  Docker round-trip back in front of every browser request for the length of the stream.
  `containers/create` is excluded because a created container runs nothing and holds no
  address until it is started; stops, kills and removals because they can only *remove* an
  index entry, and a stale positive fails toward denial.
- **`containComposeServices`** — it attaches an already-running service to
  `shipit-egress-<id>`, giving that service a second address and making it the preferred
  route. It runs *after* the Compose command's own bracket has closed, so it needs its own.

`SessionContainerManager.create` is deliberately **not** bracketed. A create runs for
seconds to minutes and a bracket suspends the fast path for its whole duration, so it would
have to buy something — and it buys nothing: the agent container is resolved from
`this.containers` by address rather than from the index, and its egress sidecars share its
network namespace, so they add no address of their own.

A miss returned by the **Docker path** (rather than by a warm snapshot) is absence even
mid-bracket, and that is a different claim from the fast path's: the snapshot answering it
began *after* the request arrived, and a container has to be running to have sent the
packet that produced the request. The bracket's job is to force that path, not to poison
its result.

### 2. A miss inside a session subnet is not absence

Even with no bracket and a fresh snapshot, an address that one of the session networks can
hold is not evidence of a browser — an unindexed container is the likelier explanation, so
it costs a Docker round-trip rather than trust. `isLikelySessionContainerIp` is used here
as a **deny-side** signal only. It is emphatically *not* a pre-gate on the lookup: the
ranges map is populated only for sessions whose networks have been inspected, so an empty
or stale map used as an *allow* gate would hand a real service container the browser trust
level. Used this way, an empty map costs nothing but the fast path.

`recordSessionNetworkRanges` inspects **three** names per session, and the third was
missing: the Docker-access bridge is `shipit-session-<first 12 chars>`
(`container-lifecycle.ts`), not the full-id name the Compose and egress networks use. Asking
only for the full-id names left an agent-created child's subnet out of the map by
construction — and that child is the one class of container a Docker-enabled agent starts
itself. The background loop also refreshes those ranges (`SESSION_RANGE_REFRESH_MS`), which
is what finally gives the guard's `catch` branch something to be closed on; before, the
ranges were refreshed only by the failure they were supposed to answer, so in production
they were almost always empty.

### The backstop, and what is honestly not covered

The Docker event stream (`container-health.ts`) reports a **labelled container start** —
nothing else. That covers the one case nobody drives: a Compose service that Docker's own
restart policy brings back on a new address. It is a backstop, never the ordering
mechanism, because event delivery is asynchronous with respect to the container's own
process. `die` and unlabelled starts are deliberately not reported: they cannot create an
unrecognised caller, and reporting them would let unrelated churn on a shared daemon drop
the freshness stamp continuously. (Subscribing to `start` also surfaced a latent bug in
that handler: Docker streams newline-delimited JSON and one chunk routinely carries several
records, so `JSON.parse(chunk)` threw and swallowed the whole batch — crash events with it.
The handler now splits on newlines.)

Two things this does **not** cover, stated so they are not mistaken for covered. A hung
`docker compose` leaks its bracket for as long as it hangs, which costs latency and nothing
else — the bracket has no deadline on purpose, because an auto-close would reopen exactly
the window it exists to close. And the agent container's own secondary (compose-network)
address is in neither origin lookup, so it reads as browser/host; that predates this work
and is filed as **planning#506**.

The request path keeps the expensive lookup for a cold or stale index, but bounds its own
wait at `ORIGIN_LOOKUP_DEADLINE_MS` — separately from the Docker timeout, which is now
generous enough to actually complete. **Overrunning that deadline is not a deny.** The
lookup reports the index unavailable, and the guard resolves that with
`isLikelySessionContainerIp`: fail-closed for an address inside a session subnet, and an
**allow** for everything else. That is the pre-existing availability choice — failing the
whole browser UI closed whenever Docker is unreachable would be worse — and it is stated
here because it is easy to read the throw as a denial. It is only a denial for callers the
subnet ranges recognise, which is exactly why keeping those ranges warm matters.

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

- **Docker-proxy create-time network ownership (planning#137) — fixed.** The bridge-IP guard
  here identifies container origins via `getSessionByContainerIp`, which only knows
  session-worker containers. A Docker-enabled agent could create a **child** container on a
  foreign named network (e.g. the orchestrator's) whose IP isn't in that map, so the guard
  treated it as a trusted browser origin. Root cause was an asymmetry in the Docker proxy:
  `POST /networks/{id}/connect` enforced `networkBelongsToSession` but `POST /containers/create`
  did not. `sanitizeContainerCreate` now ownership-checks any named `NetworkMode` and every
  `NetworkingConfig.EndpointsConfig` entry, mirroring the connect route. See planning#137.
- Scoping the **global** blast radius of the genuinely-browser-driven mutations
  (`refreshAgentEnvForAllSessions`) is a separate hardening item; this doc removes the
  container's ability to *trigger* them, which is the planning#131 acceptance bar.
- Per-session signed token (planning#131 direction option b) as defense-in-depth for any future
  non-bridge topology — deferred; bridge-IP covers the current containerized model.
- **The worker end of the same channel (planning#313) — fixed separately.** This guard covers
  agent→orchestrator. It says nothing about agent→**another agent's worker**, which is
  reachable because agent containers share one bridge and each worker binds `0.0.0.0:9100`.
  A request to B's worker is relayed onward by B's own `OrchestratorClient` with **B's**
  session id injected, so it reaches this guard already looking like a legitimate
  own-session call. Closed at the worker boundary instead — see
  `docs/251-worker-trust-boundary/`.
