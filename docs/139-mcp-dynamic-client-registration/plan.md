---
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
- `client_id_metadata_document_supported: false` confirms there's no
  client-ID-metadata-document shortcut — DCR is the path to a `client_id`.

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

1. **Find the protected-resource metadata URL — header first.** Do an
   unauthenticated probe of `mcpUrl` (`POST` an empty/`initialize` body) and read
   the `resource_metadata` value out of the `401`'s `WWW-Authenticate` header
   (the verified probe returns
   `…/.well-known/oauth-protected-resource/mcp` there — this is the
   **authoritative** source, per the MCP auth spec). Only if the challenge is
   absent, fall back to guessing the well-known paths
   `<origin>/.well-known/oauth-protected-resource` and the resource-path-suffixed
   `<origin>/.well-known/oauth-protected-resource/mcp`.
   - **SSRF guard:** require the `resource_metadata` URL's origin to equal
     `mcpUrl`'s origin before fetching it — a compromised MCP endpoint must not
     be able to redirect discovery at an arbitrary host.
2. Fetch the protected-resource metadata and read `authorization_servers[0]`.
   **Validate** that AS origin against the `resource` origin (don't follow an
   arbitrary cross-origin AS).
3. Fetch the authorization-server metadata (RFC 8414). **Path construction:** for
   an origin-rooted issuer (Notion's case) it's
   `<issuer>/.well-known/oauth-authorization-server`; for an issuer *with a path
   component* RFC 8414 requires inserting the well-known segment **between host
   and path** (`https://host/.well-known/oauth-authorization-server/<path>`), not
   appending. Fall back to `<issuer>/.well-known/openid-configuration` on 404
   (Notion 404s this — RFC 8414 is the live path).
4. **Validate** each discovered endpoint (`authorization_endpoint`,
   `token_endpoint`, `registration_endpoint`) shares the AS origin before ShipIt
   POSTs registration data or redeems a code there.
5. Validate `S256 ∈ code_challenge_methods_supported` (we always send S256);
   throw a clear error otherwise.
6. Return a normalized record:
   `{ authorizationEndpoint, tokenEndpoint, registrationEndpoint?, codeChallengeMethods }`.

Cache the discovered metadata in-memory with a short TTL (endpoints are stable;
re-discovering on every connect is cheap and avoids staleness). No need to
persist.

> **Scope of the "generalizes to any spec-compliant server" claim:** the
> origin-rooted RFC 8414 path and the origin checks above assume `mcpUrl` is a
> trusted, registry/operator-controlled value (it is today). If `mcpUrl` ever
> becomes user-supplied, the SSRF surface widens — revisit the origin checks and
> consider an allowlist before relaxing that.

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
   hatch / rate-limit workaround documented in `mcp-oauth-providers.ts`). When
   the override is used we still need endpoints — run discovery, or fall back to
   the registry endpoints if discovery is unavailable.
2. **Cached registered client** — `credentialStore.getMcpOAuthClient(source)`
   (keyed by `provider.id`, e.g. `notion_oauth`), if a prior registration
   succeeded.
3. **Dynamic registration** — discover, then `POST` to the discovered
   `registration_endpoint`, then use the issued id.
4. Only if all three fail **and** the provider published no
   `registration_endpoint` (and none was hardcoded) do we throw the existing
   "Missing OAuth client id" error (now genuinely an edge case).

**`startOAuthFlow` becomes `async`.** It currently returns
`StartOAuthFlowResult` synchronously (`mcp-oauth.ts:148–158`) and the route calls
it without `await` (`api-routes-mcp.ts:240`). Discovery + registration are network
calls, so the signature changes to `Promise<StartOAuthFlowResult>` and
`POST /api/mcp-servers/oauth/start` must `await` it. The route already returns
JSON before the popup opens, so failures surface as a `ServiceError` → JSON error
the Settings panel renders inline (the popup is only opened *after* a successful
`authorizeUrl` is returned).

**Endpoint threading (load-bearing — this is the actual bug being fixed).** The
discovered `authorization_endpoint` is used to build the authorize URL, and the
discovered `token_endpoint` **must** be used for the later code exchange. Today
`handleOAuthCallback` re-derives the provider via `getMcpOAuthProvider(flow.source)`
and exchanges at `provider.tokenEndpoint` (`mcp-oauth.ts:224–236`, `:268`) — the
*hardcoded* registry value, which for Notion is the wrong `api.notion.com` server.
Concrete changes:

- Add `tokenEndpoint: string` (and, for symmetry, `authorizationEndpoint: string`)
  to `OAuthFlowState` (`mcp-oauth.ts:47–55`). `startOAuthFlow` writes the resolved
  values when it `put()`s the flow state. **All three client-id resolution
  branches must populate these** — the env-override branch (which skips
  registration) still runs discovery for endpoints, or falls back to the
  corrected registry `tokenEndpoint`; never leave the flow state's endpoints
  unset.
- `handleOAuthCallback` / `exchangeCodeForTokens` must read `flow.tokenEndpoint`
  instead of `provider.tokenEndpoint`.
- The **same** `redirectUri` value must be used at all three steps —
  registration, authorize URL, and token exchange — or the provider rejects the
  exchange. Reuse the single derived callback URL (`deriveCallbackUrl`,
  `api-routes-mcp.ts:333`) throughout the flow; `registerOAuthClient` is called
  from inside `startOAuthFlow` so it already has that `redirectUri` in scope.

**Failure UX** (all surface as inline errors in the Settings panel, before the
popup opens):

- Discovery 404 on both well-known paths / no `WWW-Authenticate` challenge →
  `ServiceError(502, "Couldn't discover <provider> OAuth configuration")`.
- `/register` 4xx (incl. rate limit — the scenario `clientIdEnv` exists for) →
  `ServiceError(502, …)` with a hint to set `<PROVIDER>_OAUTH_CLIENT_ID` as a
  fallback.
- Metadata missing `S256` → `ServiceError(502, "provider doesn't support S256
  PKCE")`.

### 4. Registry cleanup (`mcp-oauth-providers.ts`)

- **Commit (not "either/or"): replace Notion's hardcoded endpoints with the
  discovered `mcp.notion.com` values** (`authorize` / `token`) so the static
  fallback is at least the *correct* server. Discovery still overrides them at
  runtime; this just makes the fallback safe and fixes the refresh path (below).
- Mark `authorizationEndpoint` / `tokenEndpoint` as **fallback-only** in the
  field comments. `registrationEndpoint` stays optional — discovery supplies it;
  the static field is a fallback for providers without metadata.
- **Fix the stale header comment** at `mcp-oauth-providers.ts:16–23`, which today
  claims the registered client_id is cached "in `CredentialStore.mcpOAuth[id].clientId`."
  That contradicts the settled decision (separate `mcpOAuthClients` map) — update
  it. Also reconcile the `clientIdEnv` comment block, which describes DCR as
  already-implemented behavior when it isn't yet.

### Refresh-path correctness

`refreshOAuthTokens` (`mcp-oauth.ts:334–384`) exchanges at `provider.tokenEndpoint`
(`:359`) — the registry value. After this feature, Notion's registry endpoint is
corrected to `mcp.notion.com/token` (above), so refresh hits the right server. We
do **not** rely on "Notion tokens never expire": `refreshExpiredMcpOAuthTokens`
runs for any source with a `refreshToken` + `expiresAt`, so the endpoint must be
correct regardless. (Belt-and-suspenders: we could also persist the discovered
`tokenEndpoint` alongside the registered client and have refresh prefer it, but
correcting the registry value is sufficient and simpler. Persisting it is the
follow-up if a provider's token endpoint ever diverges from its registry entry.)

## Data model

`CredentialStore.mcpOAuth` already exists (`Record<string, OAuthTokens>`), and
`OAuthTokens` already has `clientId?` / `clientSecret?` (used by the refresh
path). `OAuthTokens.accessToken` is **required**, so a registered client_id
can't live in `mcpOAuth` before the first token exists without either loosening
the type or writing a half-populated record — and a half-populated record would
be a problem because `listMcpOAuthProviders()` (`mcp-oauth.ts:398–410`) treats
*any* tokens record as `connected: true` (it never checks `accessToken`), so a
client-only record would falsely show **Connected** in Settings. (The env-var
writer is *not* at risk: `collectMcpAgentEnv()` in `secret-resolver.ts:267–287`
already guards `if (!tokens?.accessToken) continue;` at `:280`, so a tokenless
record would not push a broken `MCP_PLATFORM_*` env var — but the false-Connected
status alone is reason enough to keep the two concerns separate.)

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
  so there is **no false-Connected risk** in `listMcpOAuthProviders`.
- **Registers once per account/provider** and reuses the cached client on every
  subsequent connect — no orphan client registrations accruing provider-side,
  and resilient to DCR rate limits (the same concern the `clientIdEnv` escape
  hatch exists for).
- Tiny, self-contained addition that mirrors the existing `mcpOAuth` map; does
  not touch the resolver / status / refresh code paths.

Rejected: a partial `OAuthTokens` record / making `accessToken` optional —
ripples through `secret-resolver.ts` (`collectMcpAgentEnv`), `mcp-resolve.ts`,
`listMcpOAuthProviders`, and refresh, all of which assume `accessToken` is
present. Also rejected: no persistence at all (re-register every connect) — it's
the smallest diff but leaks orphan clients and risks rate limits for no real
benefit now that we have the cache.

### Lifecycle

- **Register:** `startOAuthFlow` checks `mcpOAuthClients[source]` first; on a
  miss it discovers + registers and writes the result here.
- **Use:** the client_id is copied into `OAuthFlowState` for the live handshake,
  and into `OAuthTokens.clientId` on successful exchange. The refresh path
  (`refreshOAuthTokens`) is structurally unchanged — it reads `clientId` off the
  stored tokens — and now hits the correct token endpoint because Notion's
  registry `tokenEndpoint` is corrected to `mcp.notion.com/token` (see
  Refresh-path correctness).
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
  redemption (RFC 8252 native-app guidance, same as today). State/PKCE handling
  is unchanged from the existing flow (opaque `state`, 10-min TTL store).
- **SSRF surface from discovery (the main new risk).** Discovery follows URLs
  derived from the provider's responses, so the orchestrator must validate
  origins before each fetch/POST (enforced in Discovery §1):
  - the `resource_metadata` URL from the `WWW-Authenticate` header must share
    `mcpUrl`'s origin;
  - `authorization_servers[0]` must share the `resource` origin;
  - the discovered `authorization_endpoint` / `token_endpoint` /
    `registration_endpoint` must share the AS origin.
  All fetches are HTTPS-only. `mcpUrl` is registry/operator-controlled today; if
  it ever becomes user-supplied, add an allowlist (noted in Discovery §1).
- **Redirect URI** must be byte-identical at registration, authorize, and token
  exchange (single derived `deriveCallbackUrl` value); mismatch is the most
  common DCR failure mode.
- **Registration is per account** (CredentialStore is account-scoped) — one
  registered client per provider per account, reused across sessions.
- Throwaway client minted during verification (`Q4b8…`) is harmless — public,
  no secret, no tokens ever issued to it.

## Key files

- `src/server/orchestrator/services/mcp-oauth.ts` — make `startOAuthFlow` async +
  reorder client-id resolution; add `registerOAuthClient`; add
  `tokenEndpoint`/`authorizationEndpoint` to `OAuthFlowState`; have
  `handleOAuthCallback`/`exchangeCodeForTokens` exchange at `flow.tokenEndpoint`
  (not `provider.tokenEndpoint`).
- `src/server/orchestrator/services/mcp-oauth-discovery.ts` — **new**: metadata
  discovery (WWW-Authenticate → protected-resource → authorization-server) with
  origin validation, S256 check, and TTL cache.
- `src/server/orchestrator/api-routes-mcp.ts` — `await` the now-async
  `startOAuthFlow` at the `POST /oauth/start` route (`:240`); reuse the single
  `deriveCallbackUrl` (`:333`) as the redirect URI for register/authorize/exchange.
- `src/server/orchestrator/mcp-oauth-providers.ts` — correct Notion's hardcoded
  endpoints to `mcp.notion.com/{authorize,token}`; mark them fallback-only; fix
  the stale header comment (`:16–23`) that points client-id caching at
  `mcpOAuth[id].clientId`, and the `clientIdEnv` comment that implies DCR already
  exists.
- `src/server/shared/types/mcp-types.ts` — add the `mcpOAuthClients` entry type
  (`{ clientId; clientSecret?; registeredAt }`); `registrationEndpoint` already
  present on `McpOAuthProviderConfig`.
- `src/server/orchestrator/credential-store.ts` — add `mcpOAuthClients` to
  `CredentialData` plus `getMcpOAuthClient` / `setMcpOAuthClient` /
  `deleteMcpOAuthClient`, and wire it into `clear()`.
- `src/server/shipit-docs/secrets.md` — the agent-facing platform-credentials doc
  (there is **no** `mcp.md` today). Its `source:` table (`:121`) lists only
  `claude_oauth` / `github_token` and never mentions the MCP OAuth
  `platform:<id>` sources; add the MCP OAuth providers and note hosted providers
  now auto-register (no `<PROVIDER>_OAUTH_CLIENT_ID` prerequisite). Optionally
  split this into a dedicated `mcp.md` if the section grows.
- Tests: `services/mcp-oauth.test.ts` + new `services/mcp-oauth-discovery.test.ts`
  (see Testing).

## Testing

- Unit: stub `fetchImpl` to return the four canned responses above; assert
  `startOAuthFlow` discovers, registers, caches, and builds an authorize URL
  pointed at the **discovered** `authorization_endpoint`.
- Unit (**the actual bug fix**): drive `startOAuthFlow` → `handleOAuthCallback`
  end-to-end with a stub `fetchImpl`; assert the code exchange POSTs to the
  **discovered** `mcp.notion.com/token`, never the registry's old
  `api.notion.com/v1/oauth/token`.
- Unit: env-var override wins over registration (operator escape hatch intact).
- Unit: a `client_id` cached in `mcpOAuthClients` skips the `/register` call
  (assert `fetchImpl` sees no registration request).
- Unit: `deleteMcpOAuthTokens` (disconnect) leaves `mcpOAuthClients` intact, so a
  reconnect reuses the cached client.
- Unit: provider with no `registration_endpoint` in metadata and no env var →
  the existing `ServiceError(400)` is thrown.
- Unit (discovery): `WWW-Authenticate` header parsing; RFC 8414 success +
  `openid-configuration` fallback on 404; missing-S256 → error; **origin-mismatch
  rejection** for a `resource_metadata` / AS / endpoint pointing off-origin
  (SSRF guard).
- Manual: real connect against `mcp.notion.com` from Settings, confirm
  "Connected" + a working `notion` server in a live session.

## Phasing / relationship to 088

This is the implementation of the deferred bullet in
`docs/088-mcp-integration/checklist.md` → "Phase 2 — deferred / follow-up →
Dynamic client registration (RFC 7591)". 088 reserved the
`McpOAuthProviderConfig.registrationEndpoint` schema field for exactly this.
Linear (the other current provider) does **not** publish DCR metadata, so it
keeps the env-var path; Notion moves to fully UI-driven.
