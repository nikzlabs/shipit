---
status: planned
priority: high
description: Dynamic OAuth client registration (RFC 7591) + metadata discovery for hosted MCP servers, so connecting Notion/Linear needs zero operator env-var config.
---

# MCP Dynamic Client Registration (RFC 7591)

Extends the MCP OAuth flow from `docs/088-mcp-integration/` (Phase 2). Today
the "Connect with Notion" / "Connect with Linear" buttons require the operator
to pre-allocate an OAuth client and set `<PROVIDER>_OAUTH_CLIENT_ID` on the
orchestrator process. There is no UI to set that env var, so the flow is **not
end-to-end doable from the UI** — clicking Connect with no env var set throws:

> Missing OAuth client id for Notion. Set NOTION_OAUTH_CLIENT_ID on the
> orchestrator process.

This feature removes that prerequisite by discovering the provider's OAuth
endpoints and **dynamically registering a client** (RFC 7591) on first connect,
caching the resulting `client_id` per account. After this lands, the entire
Notion/Linear connect lifecycle is a single button click with no operator
configuration — matching ShipIt's "everything inside the surface" principle.

## Motivation

Per the product principles in `CLAUDE.md` §1–4: anything the user needs to do
their job should be doable inside ShipIt. An operator-only env var that gates a
user-facing "Connect" button is a hard stop the user can't resolve from the UI.
DCR collapses that operator step into an automatic server-to-server call.

## Verified findings (Notion, probed 2026-05-20)

The full MCP authorization discovery chain against `https://mcp.notion.com`
responds exactly as the MCP auth spec / RFC 8414 / RFC 7591 require:

1. **Auth challenge** — `POST https://mcp.notion.com/mcp` with no token →
   `401` with
   `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"`.

2. **Protected-resource metadata** —
   `GET https://mcp.notion.com/.well-known/oauth-protected-resource[/mcp]` →
   `200`:
   ```json
   {"resource":"https://mcp.notion.com","authorization_servers":["https://mcp.notion.com"],"bearer_methods_supported":["header"],"resource_name":"Notion MCP (Beta)"}
   ```

3. **Authorization-server metadata** —
   `GET https://mcp.notion.com/.well-known/oauth-authorization-server` → `200`:
   ```json
   {
     "issuer": "https://mcp.notion.com",
     "authorization_endpoint": "https://mcp.notion.com/authorize",
     "token_endpoint": "https://mcp.notion.com/token",
     "registration_endpoint": "https://mcp.notion.com/register",
     "response_types_supported": ["code"],
     "grant_types_supported": ["authorization_code", "refresh_token"],
     "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
     "code_challenge_methods_supported": ["plain", "S256"],
     "client_id_metadata_document_supported": false
   }
   ```
   (`/.well-known/openid-configuration` → `404`; the RFC 8414 path is the one
   to use.)

4. **Dynamic client registration** —
   `POST https://mcp.notion.com/register` with client metadata → `201`:
   ```json
   {"client_id":"<issued>","redirect_uris":["http://127.0.0.1:3000/api/mcp-servers/oauth/callback"],"client_name":"ShipIt","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","registration_client_uri":"/register/<issued>","client_id_issued_at":<ts>}
   ```

### What the probe confirms

- **DCR works with zero operator config.** A `client_id` is issued on demand —
  no Notion developer-console app required.
- **It is a public client** (`token_endpoint_auth_method: "none"`, no
  `client_secret` issued). This is exactly ShipIt's PKCE-only model (see the
  rationale comment in `services/mcp-oauth.ts`).
- **S256 PKCE is supported** — matches what `startOAuthFlow` already sends.

### ⚠️ Correction: the hardcoded Notion endpoints in the registry are wrong for DCR

`mcp-oauth-providers.ts` currently points Notion at
`https://api.notion.com/v1/oauth/authorize` + `/token`. That is Notion's
**classic public-integration** OAuth — a *different* authorization server that
requires a manually pre-created integration (which is exactly why it needs the
`client_id` env var). The MCP server's *own* authorization server, advertised
via discovery, is `https://mcp.notion.com` with `/authorize`, `/token`, and
`/register`.

**Implication:** the DCR flow must drive endpoints from **discovery starting at
`mcpUrl`**, not from the hardcoded `authorizationEndpoint`/`tokenEndpoint`. The
hardcoded fields become an optional fallback (for providers that don't publish
metadata) rather than the source of truth. This is also what makes the flow
generalize to any spec-compliant hosted MCP server, not just Notion.

## Design

Flow becomes: **discover → register (if no cached/env client_id) → PKCE authorize → token exchange.**

### 1. Discovery (`services/mcp-oauth-discovery.ts`, new)

Given a provider's `mcpUrl`:

1. Derive the origin and fetch
   `<origin>/.well-known/oauth-protected-resource` (try the path-suffixed
   variant `.../oauth-protected-resource/mcp` too, per the `WWW-Authenticate`
   `resource_metadata` value). Read `authorization_servers[0]`.
   - Optionally short-circuit: do an unauthenticated probe of `mcpUrl` and read
     `resource_metadata` straight from the `WWW-Authenticate` header.
2. For the chosen authorization server, fetch
   `<as>/.well-known/oauth-authorization-server` (RFC 8414). Fall back to
   `<as>/.well-known/openid-configuration` if the former 404s.
3. Return a normalized record:
   `{ authorizationEndpoint, tokenEndpoint, registrationEndpoint?, codeChallengeMethods }`.
4. Validate `S256 ∈ code_challenge_methods_supported` (we always send S256).

Cache the discovered metadata in-memory with a short TTL (endpoints are stable;
re-discovering on every connect is cheap and avoids staleness). No need to
persist.

### 2. Dynamic registration (`services/mcp-oauth.ts`)

New `registerOAuthClient({ registrationEndpoint, redirectUri, provider, fetchImpl })`:

- `POST` RFC 7591 body:
  ```json
  {
    "client_name": "ShipIt",
    "redirect_uris": ["<orchestrator>/api/mcp-servers/oauth/callback"],
    "token_endpoint_auth_method": "none",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"]
  }
  ```
- On `201`, parse `client_id` (+ optional `client_secret`,
  `registration_client_uri`, `client_id_issued_at`).
- Cache the registered client in the new `CredentialStore.mcpOAuthClients` map
  (see Data model) so it's reused on the next connect instead of registering
  again. The client_id also flows through `OAuthFlowState` for the current
  handshake and lands in `OAuthTokens.clientId` on successful exchange (which is
  what the existing refresh path reads).

### 3. `startOAuthFlow` client-id resolution order

Replace the "env var or bust" check (`services/mcp-oauth.ts:164–174`) with:

1. **Operator override** — `env[provider.clientIdEnv]` if set (keeps the escape
   hatch / rate-limit workaround documented in `mcp-oauth-providers.ts`).
2. **Cached registered client** — `CredentialStore` client_id for this source,
   if a prior registration succeeded.
3. **Dynamic registration** — discover, then register, then use the issued id.
4. Only if all three fail **and** the provider published no
   `registration_endpoint` do we throw the existing "Missing OAuth client id"
   error (now genuinely an edge case).

Also: when discovery succeeds, prefer the **discovered** authorize/token
endpoints over the registry's hardcoded values for building the authorize URL
and for the code exchange. Thread the resolved endpoints through `OAuthFlowState`
so `handleOAuthCallback` exchanges at the same `token_endpoint` discovery
returned.

### 4. Registry cleanup (`mcp-oauth-providers.ts`)

- Mark `authorizationEndpoint` / `tokenEndpoint` as **fallback-only** in
  comments; for Notion they're currently the *wrong* server, so either:
  - replace them with the discovered `mcp.notion.com` endpoints as static
    fallback, or
  - make them optional in `McpOAuthProviderConfig` and rely on discovery.
- `registrationEndpoint` stays optional — discovery supplies it; the static
  field is a fallback for providers without metadata.

## Data model

`CredentialStore.mcpOAuth` already exists (`Record<string, OAuthTokens>`), and
`OAuthTokens` already has `clientId?` / `clientSecret?` (used by the refresh
path). `OAuthTokens.accessToken` is **required**, so a registered client_id
can't live in `mcpOAuth` before the first token exists without either loosening
the type or writing a half-populated record — and a half-populated record would
be a problem, because `getAllMcpOAuthTokens()` feeds the `MCP_PLATFORM_*` env
vars and `listMcpOAuthProviders()` treats "has a tokens record" as
**Connected**.

**Decision (settled): add a separate `mcpOAuthClients` map** (option B).

```ts
// CredentialData
mcpOAuthClients?: Record<
  string, // provider source id (e.g. "notion_oauth")
  { clientId: string; clientSecret?: string; registeredAt: number }
>;
```

New `CredentialStore` methods mirroring the `mcpOAuth` accessors:
`getMcpOAuthClient(source)`, `setMcpOAuthClient(source, client)`,
`deleteMcpOAuthClient(source)`, and inclusion in `clear()`. Persistence piggybacks
on the existing `save()`.

Why this over the alternatives:
- Keeps "I have a registered client" cleanly separate from "I have live tokens",
  so there is **no false-Connected risk** and no broken `MCP_PLATFORM_*` env var.
- **Registers once per account/provider** and reuses the cached client on every
  subsequent connect — no orphan client registrations accruing provider-side,
  and resilient to DCR rate limits (the same concern the `clientIdEnv` escape
  hatch exists for).
- Tiny, self-contained addition that mirrors the existing `mcpOAuth` map; does
  not touch the resolver / status / refresh code paths.

Rejected: a partial `OAuthTokens` record / making `accessToken` optional —
ripples through `mcp-resolve.ts`, `getAllMcpOAuthTokens`,
`listMcpOAuthProviders`, and refresh, all of which assume `accessToken` is
present. Also rejected: no persistence at all (re-register every connect) — it's
the smallest diff but leaks orphan clients and risks rate limits for no real
benefit now that we have the cache.

### Lifecycle

- **Register:** `startOAuthFlow` checks `mcpOAuthClients[source]` first; on a
  miss it discovers + registers and writes the result here.
- **Use:** the client_id is copied into `OAuthFlowState` for the live handshake,
  and into `OAuthTokens.clientId` on successful exchange (so the existing
  refresh path is unchanged).
- **Disconnect:** `deleteMcpOAuthTokens(source)` drops the tokens. We **keep**
  `mcpOAuthClients[source]` so reconnect skips re-registration — the registered
  public client is harmless without tokens. (A future "forget this provider
  entirely" affordance can call `deleteMcpOAuthClient`.)

## UX (unchanged surface, working button)

Settings → MCP Servers → "One-click connections" (`McpServerSettings.tsx:336–389`)
stays exactly as-is. The only behavioral change: **Connect Notion** now works
with no operator config.

1. Row shows label + description + **Connect Notion** (primary button).
2. Click → button shows **"Connecting…"**. Server-side (invisible): discover →
   register (first time only; cached thereafter) → build authorize URL.
3. Notion consent popup → user picks workspace → **Allow access**.
4. Callback exchanges the code, popup posts back and closes.
5. Row flips to **"● Connected"** with **Disconnect**; a `notion` server entry
   auto-appears in the list and validates ("loaded" badge) on the next session.
6. Refresh continues via `refreshExpiredMcpOAuthTokens` (Notion issues
   non-expiring workspace tokens, so refresh is largely a no-op there).

The user never sees the env-var error or any "create an OAuth app in Notion"
step again.

## Security considerations

- **Public client, PKCE-only.** No client secret to leak; PKCE protects the code
  redemption (RFC 8252 native-app guidance, same as today).
- **Discovery is fetched over TLS** from the provider origin; validate the
  `authorization_servers` entry shares the resource origin (don't follow an
  arbitrary cross-origin AS without a sanity check).
- **Redirect URI** registered must exactly match the orchestrator callback used
  in the flow; mismatch is the most common DCR failure mode.
- **Registration is per account** (CredentialStore is account-scoped) — one
  registered client per provider per account, reused across sessions.
- Throwaway client minted during verification (`Q4b8…`) is harmless — public,
  no secret, no tokens ever issued to it.

## Key files

- `src/server/orchestrator/services/mcp-oauth.ts` — add registration + reorder
  client-id resolution in `startOAuthFlow`; thread discovered endpoints through
  `OAuthFlowState` → `handleOAuthCallback`.
- `src/server/orchestrator/services/mcp-oauth-discovery.ts` — **new**: metadata
  discovery (protected-resource → authorization-server) with TTL cache.
- `src/server/orchestrator/mcp-oauth-providers.ts` — fix/relax hardcoded Notion
  endpoints; clarify they're fallback-only.
- `src/server/shared/types/mcp-types.ts` — add the `mcpOAuthClients` entry type
  (`{ clientId; clientSecret?; registeredAt }`); `registrationEndpoint` already
  present on `McpOAuthProviderConfig`.
- `src/server/orchestrator/credential-store.ts` — add `mcpOAuthClients` to
  `CredentialData` plus `getMcpOAuthClient` / `setMcpOAuthClient` /
  `deleteMcpOAuthClient`, and wire it into `clear()`.
- `src/server/shipit-docs/mcp.md` — document that hosted providers now
  auto-register; remove/soften the env-var prerequisite.
- Tests: `services/mcp-oauth.test.ts` (+ a new discovery test) — cover
  discovery parsing, registration parsing, resolution order (env > cached >
  register), S256 validation, and the no-registration-endpoint fallback error.

## Testing

- Unit: stub `fetchImpl` to return the four canned responses above; assert
  `startOAuthFlow` discovers, registers, caches, and builds an authorize URL
  pointed at the **discovered** `authorization_endpoint`.
- Unit: env-var override wins over registration (operator escape hatch intact).
- Unit: a `client_id` cached in `mcpOAuthClients` skips the `/register` call
  (assert `fetchImpl` sees no registration request).
- Unit: `deleteMcpOAuthTokens` (disconnect) leaves `mcpOAuthClients` intact, so a
  reconnect reuses the cached client.
- Unit: provider with no `registration_endpoint` in metadata and no env var →
  the existing `ServiceError(400)` is thrown.
- Manual: real connect against `mcp.notion.com` from Settings, confirm
  "Connected" + a working `notion` server in a live session.

## Phasing / relationship to 088

This is the implementation of the deferred bullet in
`docs/088-mcp-integration/checklist.md` → "Phase 2 — deferred / follow-up →
Dynamic client registration (RFC 7591)". 088 reserved the
`McpOAuthProviderConfig.registrationEndpoint` schema field for exactly this.
Linear (the other current provider) does **not** publish DCR metadata, so it
keeps the env-var path; Notion moves to fully UI-driven.
