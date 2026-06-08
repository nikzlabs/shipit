---
description: Programmatic HTTP API for driving ShipIt from outside the browser — list sessions, check agent and CI status, start a session with a prompt, send a message to an existing session. Designed for scripts, automation, and external agents.
issue: https://linear.app/shipit-ai/issue/SHI-35
---

# External control API

## Summary

ShipIt today is driven through a browser. The orchestrator already exposes a substantial HTTP API that the browser uses, but the surface is incomplete for headless control: there's no HTTP route to send a message to an existing session (it's WebSocket-only), no authentication on any route (it relies on the orchestrator listening on `127.0.0.1` behind a reverse proxy), and PR/CI status is delivered only via SSE rather than as a fetchable resource.

This doc proposes a small, additive HTTP surface plus a simple auth model so that external programmatic clients can drive ShipIt the way a user does: list active work, see what's running, look at CI, start new work, nudge existing work. The audience is **any** non-browser client — shell scripts, cron jobs, dashboards, other agents, mobile apps. The design is generic; nothing is wired to a particular external system.

## Motivation

A browser-shaped IDE assumes the user is in front of the browser. Many useful workflows don't fit that shape:

- An external agent or assistant on the user's network wants to start a ShipIt session in response to an email, a Slack message, or an incoming issue, with the relevant context inlined as the initial prompt.
- A dashboard or monitoring system wants to render "is any of my work currently running, and is any of my CI red" without opening ShipIt.
- A script wants to file a session per-row of some queue and kick it off without a human.
- A mobile shortcut wants to send "rebase this PR onto main" to an existing session without launching a full browser session.

All of these are doable today only by either driving a browser (Playwright, headless Chromium) or implementing a WebSocket client that speaks ShipIt's `send_message` protocol. Both are heavy. The actual missing piece is a small set of HTTP endpoints + an auth gate.

This is consistent with the product principles: external clients are operating ShipIt, not bypassing it. The same session lifecycle, same auto-commit, same PR flow, same chat history. ShipIt remains the surface; the API is just a different way to reach it.

## What already exists vs. what is missing

What the browser uses today, fully reusable by external clients:

| Capability | Route |
|---|---|
| List sessions | `GET /api/sessions/all` |
| Session runtime status (running + queue length) | `GET /api/sessions/:id/status` |
| Session history (incl. cached PR status) | `GET /api/sessions/:id/history` |
| Create session with initial prompt | `POST /api/sessions/headless` |
| Archive / rename session | `DELETE /api/sessions/:id`, `PATCH /api/sessions/:id` |
| Live updates (session list, active runners, PR status) | `GET /api/events` (SSE) |

What's missing:

1. **No HTTP endpoint to send a message to an existing session.** Currently a WS-only `send_message`. External clients have to implement a WS client to nudge an existing session. (The child-session `POST /api/sessions/:parentId/children/:childId/message` route exists but is parent-to-child only.)
2. **No HTTP endpoint to fetch the current PR/CI status for a session.** The status exists server-side (the poller maintains it) and ships over SSE, but you can't `GET` it on its own — only embedded in the larger `/api/sessions/:id/history` response, which is heavy.
3. **No authentication on any route.** The orchestrator listens on `127.0.0.1` in prod and trusts the network. Fine for browser-on-the-same-host, not fine for an external client over the network.

These three additions close the headless gap with minimal new surface.

## Design

### 1. Auth — personal access tokens

A new account-level config: zero or more personal access tokens, minted from the Settings UI. Each token is a 32-byte random string, stored hashed (not in plaintext) in `CredentialStore`. Tokens carry an optional human label (e.g. `"home dashboard"`, `"phone shortcut"`) so the user can revoke them individually.

Token validation middleware applies to all `/api/*` routes:

- If the request includes an `Authorization: Bearer <token>` header, validate it by hashing and comparing to stored hashes (constant-time). Valid → continue. Invalid → 401.
- If no header is present, fall back to the existing trust model: allow if the request comes from a same-origin browser context (cheap heuristic: `Origin` matches the configured ShipIt host, or no `Origin` set and request is from `127.0.0.1`). Otherwise 401.

This keeps the browser flow unchanged on default deployments while gating external requests on a real token. The fallback is honest about what it is: a check that suits a single-user, single-host deployment, not a real auth boundary against an attacker on the local network. The doc and Settings UI should say so plainly — users deploying ShipIt past their LAN should still front it with a real auth proxy (Cloudflare Access, Tailscale, OAuth gateway).

Storage shape, extending `CredentialData` in `src/server/orchestrator/credential-store.ts`:

```typescript
interface CredentialData {
  // ... existing fields
  apiTokens?: Array<{
    id: string;            // ulid-style, used for revocation
    label: string;         // human-readable, set by user
    hash: string;          // sha256 of the token bytes, hex
    createdAt: number;
    lastUsedAt?: number;   // updated on successful auth, eventually-consistent
  }>;
}
```

Token CRUD lives in a new `services/api-tokens.ts` and `api-routes-api-tokens.ts`:

- `POST /api/tokens` → `{ id, label, token }`. **Plaintext token is returned exactly once**, in the response body of the create call. After that it's only available as a hash. UI shows it once with a copy button and a "you won't see this again" warning.
- `GET /api/tokens` → list (id, label, createdAt, lastUsedAt; no hashes, no plaintext).
- `DELETE /api/tokens/:id` → revoke.

### 2. New endpoint — send a message to an existing session

`POST /api/sessions/:id/message`. Body:

```json
{
  "text": "string, required",
  "permissionMode": "default | acceptEdits | bypassPermissions | plan (optional)",
  "images": [],
  "files": [],
  "uploads": []
}
```

Response (immediate; the agent runs asynchronously):

```json
{
  "status": "queued | started",
  "queuePosition": 1,
  "sessionId": "ses_…"
}
```

Server behaviour mirrors the existing WS `send_message` handler:

- Resolve the runner via `runnerRegistry.get(sessionId)`. If absent, start one (same path as a fresh browser attach).
- If the runner is currently running a turn, enqueue the message into `runner.messageQueue` and return `{ status: "queued" }`.
- Otherwise, kick off a turn and return `{ status: "started" }` immediately. Do **not** wait for the turn to finish — that's a streaming concern, handled separately via SSE or by polling `/status`.
- Emit the same WS `message_queued` / `session_status` broadcasts so any attached browser viewers see the message land in real time.

The HTTP route is a thin wrapper around the same code path the WS handler uses; the implementation should factor the shared work into a service function (`services/session-message.ts` or similar) so the WS handler and HTTP route call the same thing.

`POST /api/sessions/:id/interrupt` should be added at the same time — symmetric, lets an external client stop a runaway turn without holding a WS connection.

### 3. New endpoint — fetch PR / CI status

`GET /api/sessions/:id/pr-status` → the cached `PrStatusSummary` from the poller for one session. 404 if no PR exists for the branch.

`GET /api/pr-status` → all `PrStatusSummary` entries the poller currently knows about, one per session that has a PR. Useful for dashboards.

Both are pure reads of state the poller already maintains in memory. No new poller work, no new fetches to GitHub.

The `PrStatusSummary` shape is already public (`src/server/shared/types/github-types.ts`) and contains everything an external client needs: PR state (`open` / `merged` / `closed`), check rollup (`pending` / `success` / `failure`, plus per-check failures), mergeable state, deployments, review threads. The browser already renders against this exact shape; external clients get parity.

### 4. SSE — reuse, with auth applied

`GET /api/events` already exists and already pushes the events external clients want (`active_runners`, `pr_status`, `session_list`). It needs the same auth middleware applied. No schema changes.

Per-session filtering (`GET /api/events?session=ses_…`) is a nice-to-have but not required for v1 — clients can filter the global stream client-side. If event volume becomes a problem we can add it later.

### 5. Schema notes

- Times are unix ms numbers, consistent with the rest of the API.
- All routes return JSON. `Content-Type: application/json` required on writes.
- Errors use `{ "error": "human-readable", "code": "machine-readable" }` with the appropriate HTTP status.
- Routes that take a session id return 404 for unknown ids and 410 for archived ones (the archived/unarchive distinction matters — clients can act on it).

### 6. What this is not

- **Not a streaming API for an in-flight turn.** External clients that want to follow a turn's output token-by-token should connect a WebSocket. The HTTP surface is for control and status, not transcript streaming. Polling `/status` + `/history` covers the "did it finish" case.
- **Not multi-tenant.** Tokens are per-user (the single user who owns this ShipIt instance). No org / team / scope abstraction.
- **Not scoped.** A token is all-or-nothing; if you have one, you can do anything the user can do. Scoped tokens (read-only, single-session, etc.) are a future addition once we know which scopes matter in practice.
- **Not rate-limited.** External use is for the user's own automation. No abuse threat model in v1. If a runaway client is a problem, add a simple per-token bucket later.

### Key files

New:
- `src/server/orchestrator/services/api-tokens.ts` — mint, list, validate, revoke.
- `src/server/orchestrator/api-routes-api-tokens.ts` — token CRUD routes.
- `src/server/orchestrator/services/session-message.ts` — shared "enqueue or start a turn" logic factored out of the WS handler.
- `src/server/orchestrator/auth-middleware.ts` — Fastify preHandler that does Bearer / same-origin gating.
- `src/client/components/settings/ApiTokensSettings.tsx` — token management UI.

Modified:
- `src/server/orchestrator/credential-store.ts` — `apiTokens` field, getters/setters, hash + verify helpers.
- `src/server/orchestrator/ws-handlers/send-message.ts` — delegate to the shared service function.
- `src/server/orchestrator/api-routes-session.ts` — add `POST /:id/message`, `POST /:id/interrupt`, `GET /:id/pr-status`.
- `src/server/orchestrator/api-routes.ts` — add `GET /pr-status`, register the new route file, wire the auth middleware.
- `src/server/orchestrator/index.ts` — apply auth middleware to `/api/events` SSE.

## Reliability and security notes

- Token storage is hashed (sha256). The plaintext is returned exactly once on creation. No "show token" endpoint after that — lost token → revoke and mint a new one.
- The `Origin` fallback is intentionally generous to preserve the existing browser UX on local deployments. Users deploying ShipIt past their LAN should put a real auth gateway in front of it. The Settings UI for tokens should explicitly say this.
- Token validation is constant-time (compare hashes, not raw strings).
- All write endpoints (`POST`, `PATCH`, `DELETE`) require an explicit token in production — same-origin fallback should be opt-out via env var (`SHIPIT_REQUIRE_API_TOKEN=true`) for users who want to harden their deployment.

## Tests

- Unit: `services/api-tokens.ts` — mint, verify (constant time), revoke.
- Integration in `src/server/orchestrator/integration_tests/external-api.test.ts`:
  - Token round-trip: mint, use, revoke, denied.
  - Send message via HTTP: starts a turn, returns `started`.
  - Send message while running: enqueues, returns `queued` with position.
  - Interrupt via HTTP: stops in-flight turn.
  - PR status fetch: returns cached summary; 404 when none.
  - SSE with token: connects and receives events; without token in `REQUIRE_API_TOKEN=true` mode: 401.
- Negative: malformed token, expired/revoked token id, unknown session id, archived session id.

## Open questions

- **Should tokens have an optional expiry?** Cheap to add (`expiresAt?: number`) and a good security default. Lean yes, with sensible defaults (`90d`, `never`, custom).
- **Should we add a `POST /api/sessions/:id/wait?timeout=Ns` long-poll endpoint?** Closes the "send a message and want to know when it's done" loop in one round-trip instead of polling. Mildly hostile to keep-alive proxies. Punt to v2 — polling `/status` is fine for now.
- **Token labels — do we want a "last used from IP" alongside `lastUsedAt`?** Useful for the user to spot stale tokens but adds privacy considerations. Lean yes, last-used IP only, no full request log.
- **CORS?** Today the browser is same-origin so CORS is moot. If we want to allow third-party UIs (a separate dashboard the user builds), we'd need a configurable CORS allowlist. Out of scope for v1; revisit when someone asks.

## Relationship to other docs

- **`docs/159-turn-end-notification-mcp/plan.md`** — outbound notifications. That doc covers ShipIt → external; this doc covers external → ShipIt. Together they form a two-way loop: an external system can be told "ShipIt just finished a turn" (159) and then react by sending a follow-up message (this doc). Either is useful alone, but the pair is the natural shape.
- **`docs/043-websocket-vs-http-analysis/plan.md`** — the WS-vs-HTTP framework. The choices here are consistent with it: control and discrete state reads on HTTP, streaming on WS.
