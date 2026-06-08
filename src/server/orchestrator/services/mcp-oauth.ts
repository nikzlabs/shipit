/**
 * MCP OAuth service (docs/088-mcp-integration §"Phase 2").
 *
 * Implements the OAuth 2.1 + PKCE flow ShipIt uses to obtain access tokens
 * for hosted MCP servers (Linear, Notion, …). Stateless functions; flow
 * state lives in {@link InMemoryOAuthStateStore} (per-orchestrator-process
 * — the lifetime of an OAuth handshake is short and re-runnable).
 *
 * Why PKCE only? ShipIt is effectively a public OAuth client — there's no
 * server-side secret we could keep secret per install. PKCE protects the
 * code redemption step without needing a `client_secret`, which is the
 * RFC 8252 recommendation for "native apps" like ours.
 *
 * Why an in-memory state store and not the database? OAuth state has a
 * < 10-minute useful lifetime. Persisting across orchestrator restarts
 * isn't worth the complexity; the user can just click "Connect" again.
 *
 * Near-expired MCP OAuth tokens are refreshed by an async path
 * ({@link refreshExpiredMcpOAuthTokens}) triggered at orchestrator startup
 * and before each agent turn, NOT inline during compose secret resolution
 * (docs/184 removed the `source: platform:*` compose-resolver path that used
 * to drive an inline refresh). Refresh failures fall through to "return
 * current (expired) token" so the worker can at least emit a meaningful
 * `mcp_server_status` failure rather than silently dropping the server.
 */

import crypto from "node:crypto";
import type { CredentialStore } from "../credential-store.js";
import type {
  McpOAuthProviderConfig,
  OAuthTokens,
  McpOAuthStatus,
} from "../../shared/types/mcp-types.js";
import {
  MCP_OAUTH_PROVIDERS,
  getMcpOAuthProvider,
} from "../mcp-oauth-providers.js";
import { ServiceError } from "./types.js";
import { getErrorMessage } from "../../shared/utils.js";
import {
  discoverOAuthMetadata,
  type DiscoveredOAuthMetadata,
} from "./mcp-oauth-discovery.js";

/**
 * Hard ceiling for every outbound call to a provider's OAuth endpoints
 * (token exchange, refresh, dynamic client registration). `fetch` has no
 * default timeout, so without this an unresponsive token endpoint hangs the
 * request forever. That mattered most for {@link refreshExpiredMcpOAuthTokens}
 * on the pre-spawn env-prep path — an un-timed refresh stalled the whole turn
 * before the agent could spawn. The env-prep caller also fails open after its
 * own (longer) timeout; this inner bound additionally ABORTS the dangling
 * socket so we don't leak a connection the caller has already walked away from.
 */
const OAUTH_FETCH_TIMEOUT_MS = 7_000;

/**
 * `AbortSignal` that fires after {@link OAUTH_FETCH_TIMEOUT_MS}. Factored out
 * so the default is applied consistently and tests can reason about it.
 */
function oauthFetchSignal(): AbortSignal {
  return AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// In-memory state store for pending OAuth flows
// ---------------------------------------------------------------------------

/**
 * Per-flow state captured at start time so the callback can complete the
 * exchange even though it's a separate HTTP request.
 */
export interface OAuthFlowState {
  source: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  /**
   * Endpoints resolved at flow start (from discovery, falling back to the
   * registry). The callback MUST exchange at `tokenEndpoint` rather than
   * re-deriving the provider's hardcoded endpoint — for Notion the registry's
   * old value pointed at the wrong (`api.notion.com`) authorization server.
   * See docs/139-mcp-dynamic-client-registration.
   */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Unix ms when the state record was created (for TTL eviction). */
  createdAt: number;
}

/**
 * Simple in-memory state store with a 10-minute TTL. Pluggable so tests can
 * substitute a deterministic implementation.
 */
export class InMemoryOAuthStateStore {
  private readonly TTL_MS = 10 * 60 * 1000;
  private readonly store = new Map<string, OAuthFlowState>();

  put(state: string, value: OAuthFlowState): void {
    this.evictExpired();
    this.store.set(state, value);
  }

  take(state: string): OAuthFlowState | undefined {
    this.evictExpired();
    const v = this.store.get(state);
    if (v) this.store.delete(state);
    return v;
  }

  size(): number {
    this.evictExpired();
    return this.store.size;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [k, v] of this.store) {
      if (v.createdAt < cutoff) this.store.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** RFC 7636 §4.1 — code_verifier = 43–128 chars of URL-safe ASCII. */
function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

/** RFC 7636 §4.2 — code_challenge = BASE64URL(SHA256(code_verifier)). */
function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(24));
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Public API — flow lifecycle
// ---------------------------------------------------------------------------

export interface StartOAuthFlowResult {
  /** URL the UI should open in a browser popup. */
  authorizeUrl: string;
  /** Opaque state token the callback will hand back. */
  state: string;
}

export interface OAuthCallbackInput {
  state: string;
  code: string;
}

export interface OAuthCallbackResult {
  source: string;
  /** The provider config that completed — used by the route to render the
   * "Connected to X" landing page. */
  provider: McpOAuthProviderConfig;
}

/**
 * Begin an OAuth flow for a provider. Generates PKCE verifier/challenge,
 * resolves the client id (operator override → cached registered client →
 * RFC 7591 dynamic registration), persists flow state under an opaque
 * `state` value, and returns the authorize URL the UI must open in a popup.
 *
 * Endpoints are driven from discovery (RFC 8414) starting at the provider's
 * `mcpUrl`, falling back to the (corrected) registry endpoints when discovery
 * is unavailable. The resolved `authorization_endpoint` / `token_endpoint`
 * are persisted in the flow state so the callback exchanges at the right
 * server. See docs/139-mcp-dynamic-client-registration.
 *
 * Async because discovery + registration are network calls.
 *
 * Throws `ServiceError(404)` for unknown source ids.
 * Throws `ServiceError(502)` when discovery / registration fails.
 * Throws `ServiceError(400)` only when no client id can be obtained at all
 * (no env var, no cached client, and no registration endpoint anywhere).
 */
export async function startOAuthFlow(opts: {
  source: string;
  stateStore: InMemoryOAuthStateStore;
  /** Absolute redirect URL the provider will navigate back to. */
  redirectUri: string;
  /** Credential store — reads/writes the cached registered client. */
  credentialStore: CredentialStore;
  /**
   * Lookup for operator-supplied client credentials. Defaults to
   * `process.env`. Override for tests.
   */
  env?: NodeJS.ProcessEnv;
  /** Override for `fetch` used during discovery + registration. Tests inject. */
  fetchImpl?: typeof fetch;
}): Promise<StartOAuthFlowResult> {
  const provider = getMcpOAuthProvider(opts.source);
  if (!provider) {
    throw new ServiceError(404, `Unknown MCP OAuth provider: ${opts.source}`);
  }
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl;

  // Discover endpoints from the MCP server's own authorization server. This
  // is best-effort: branches that already have a client id (env override /
  // cached) can fall back to the registry endpoints if discovery is down.
  let discovered: DiscoveredOAuthMetadata | undefined;
  try {
    discovered = await discoverOAuthMetadata({
      mcpUrl: provider.mcpUrl,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
  } catch (err) {
    // Best-effort: fall back to the registry endpoints below. A genuine DCR
    // failure (4xx from /register) surfaces from registerOAuthClient instead.
    console.warn(
      `[mcp-oauth] discovery failed for ${provider.id}, falling back to registry endpoints:`,
      getErrorMessage(err),
    );
  }

  const authorizationEndpoint =
    discovered?.authorizationEndpoint ?? provider.authorizationEndpoint;
  const tokenEndpoint = discovered?.tokenEndpoint ?? provider.tokenEndpoint;
  const registrationEndpoint =
    discovered?.registrationEndpoint ?? provider.registrationEndpoint;

  // Resolve the client id in priority order.
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  // 1. Operator override — keeps the escape hatch / rate-limit workaround.
  const envClientId = provider.clientIdEnv ? env[provider.clientIdEnv] : undefined;
  if (envClientId) {
    clientId = envClientId;
    clientSecret = provider.clientSecretEnv ? env[provider.clientSecretEnv] : undefined;
  } else {
    // 2. Cached registered client — reuse so we register once per account.
    const cached = opts.credentialStore.getMcpOAuthClient(provider.id);
    if (cached) {
      clientId = cached.clientId;
      clientSecret = cached.clientSecret;
    } else if (registrationEndpoint) {
      // 3. Dynamic registration (RFC 7591).
      const registered = await registerOAuthClient({
        registrationEndpoint,
        redirectUri: opts.redirectUri,
        provider,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      });
      opts.credentialStore.setMcpOAuthClient(provider.id, {
        clientId: registered.clientId,
        ...(registered.clientSecret !== undefined
          ? { clientSecret: registered.clientSecret }
          : {}),
        registeredAt: Date.now(),
      });
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
    // else: no registration endpoint anywhere → fall through to the
    // missing-client error below. (A discovery failure is intentionally not
    // surfaced here: a provider with no registration endpoint can't do DCR
    // regardless of whether discovery succeeded, so the actionable guidance
    // is "set the env var", not "discovery failed".)
  }

  if (!clientId) {
    // No env var, no cached client, and no registration endpoint anywhere.
    throw new ServiceError(
      400,
      `Missing OAuth client id for ${provider.label}. ` +
        `${provider.label} doesn't support dynamic client registration; set ` +
        `${provider.clientIdEnv ?? "the client id env var"} on the orchestrator process.`,
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const state = generateState();

  opts.stateStore.put(state, {
    source: provider.id,
    codeVerifier,
    redirectUri: opts.redirectUri,
    clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    authorizationEndpoint,
    tokenEndpoint,
    createdAt: Date.now(),
  });

  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", opts.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (provider.scopes.length > 0) {
    authorizeUrl.searchParams.set("scope", provider.scopes.join(" "));
  }

  return { authorizeUrl: authorizeUrl.toString(), state };
}

/**
 * Register a public OAuth client with the provider's authorization server
 * (RFC 7591 dynamic client registration). ShipIt is a PKCE-only public
 * client, so `token_endpoint_auth_method` is `"none"` and no client secret is
 * expected (though one is parsed and carried if the provider issues it).
 *
 * The `redirectUri` here MUST be byte-identical to the one used in the
 * authorize URL and the later token exchange — a mismatch is the most common
 * DCR failure mode.
 *
 * Throws `ServiceError(502)` on any non-2xx or malformed response, with a
 * hint to set the operator env-var fallback (the scenario `clientIdEnv`
 * exists for — e.g. registration rate limits).
 */
export async function registerOAuthClient(opts: {
  registrationEndpoint: string;
  redirectUri: string;
  provider: McpOAuthProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<{
  clientId: string;
  clientSecret?: string;
  registrationClientUri?: string;
  clientIdIssuedAt?: number;
}> {
  const body = {
    client_name: "ShipIt",
    redirect_uris: [opts.redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  const f = opts.fetchImpl ?? fetch;
  const fallbackHint = opts.provider.clientIdEnv
    ? ` As a fallback, set ${opts.provider.clientIdEnv} on the orchestrator process.`
    : "";
  let res: Response;
  try {
    res = await f(opts.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: oauthFetchSignal(),
    });
  } catch (err) {
    throw new ServiceError(
      502,
      `Dynamic client registration request failed: ${getErrorMessage(err)}.${fallbackHint}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ServiceError(
      502,
      `Dynamic client registration for ${opts.provider.label} returned ${res.status}: ` +
        `${text.slice(0, 300) || res.statusText}.${fallbackHint}`,
    );
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    throw new ServiceError(502, "Dynamic client registration returned a non-object response");
  }
  const r = parsed as Record<string, unknown>;
  const clientId = typeof r.client_id === "string" ? r.client_id : undefined;
  if (!clientId) {
    throw new ServiceError(502, "Dynamic client registration response missing client_id");
  }
  const out: {
    clientId: string;
    clientSecret?: string;
    registrationClientUri?: string;
    clientIdIssuedAt?: number;
  } = { clientId };
  if (typeof r.client_secret === "string") out.clientSecret = r.client_secret;
  if (typeof r.registration_client_uri === "string") {
    out.registrationClientUri = r.registration_client_uri;
  }
  if (typeof r.client_id_issued_at === "number") {
    out.clientIdIssuedAt = r.client_id_issued_at;
  }
  return out;
}

/**
 * Complete an OAuth flow: take the `state` value, exchange the `code` at
 * the provider's token endpoint, and persist the resulting tokens in
 * `CredentialStore.mcpOAuth[source]`.
 *
 * Throws `ServiceError(400)` if `state` is unknown / expired (also covers
 * the CSRF case — an attacker who didn't initiate the flow won't have the
 * state value).
 */
export async function handleOAuthCallback(opts: {
  input: OAuthCallbackInput;
  stateStore: InMemoryOAuthStateStore;
  credentialStore: CredentialStore;
  /** Override for tests — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}): Promise<OAuthCallbackResult> {
  const flow = opts.stateStore.take(opts.input.state);
  if (!flow) {
    throw new ServiceError(400, "OAuth state token is unknown or expired");
  }
  const provider = getMcpOAuthProvider(flow.source);
  if (!provider) {
    throw new ServiceError(400, `Unknown OAuth provider for state: ${flow.source}`);
  }
  const tokens = await exchangeCodeForTokens({
    // Exchange at the endpoint resolved during discovery at flow start — NOT
    // `provider.tokenEndpoint`, which is the (fallback) registry value. See
    // docs/139-mcp-dynamic-client-registration.
    tokenEndpoint: flow.tokenEndpoint,
    code: opts.input.code,
    codeVerifier: flow.codeVerifier,
    redirectUri: flow.redirectUri,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    fetchImpl: opts.fetchImpl,
  });
  opts.credentialStore.setMcpOAuthTokens(flow.source, tokens);
  return { source: flow.source, provider };
}

/**
 * Exchange an authorization code (or refresh token) at the provider's token
 * endpoint. Returns a normalized {@link OAuthTokens} record. Throws on any
 * non-2xx response or malformed body — callers convert to `ServiceError` or
 * propagate.
 */
async function exchangeCodeForTokens(opts: {
  /** The token endpoint resolved at flow start (discovery → registry fallback). */
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(opts.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: oauthFetchSignal(),
    });
  } catch (err) {
    throw new Error(`Token endpoint request failed: ${getErrorMessage(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token endpoint returned ${res.status}: ${text.slice(0, 500) || res.statusText}`,
    );
  }
  const parsed: unknown = await res.json().catch(() => null);
  return normalizeTokenResponse(parsed, { clientId: opts.clientId, clientSecret: opts.clientSecret });
}

/**
 * Convert a token endpoint response body to our internal {@link OAuthTokens}
 * shape. Handles the common variations: `expires_in` (seconds) vs.
 * `expires_at` (unix seconds), token_type capitalization, etc.
 *
 * Exported for unit tests — token endpoints are notoriously
 * implementation-specific and the normalization is the highest-risk piece.
 */
export function normalizeTokenResponse(
  raw: unknown,
  ctx?: { clientId?: string; clientSecret?: string },
): OAuthTokens {
  if (!raw || typeof raw !== "object") {
    throw new Error("Token endpoint returned non-object response");
  }
  const r = raw as Record<string, unknown>;
  const accessToken = typeof r.access_token === "string" ? r.access_token : undefined;
  if (!accessToken) throw new Error("Token endpoint response missing access_token");
  const refreshToken = typeof r.refresh_token === "string" ? r.refresh_token : undefined;
  const tokenType = typeof r.token_type === "string" ? r.token_type : "Bearer";
  const scope = typeof r.scope === "string" ? r.scope : undefined;
  let expiresAt: number | undefined;
  if (typeof r.expires_in === "number" && Number.isFinite(r.expires_in)) {
    expiresAt = Date.now() + r.expires_in * 1000;
  } else if (typeof r.expires_at === "number" && Number.isFinite(r.expires_at)) {
    // expires_at is conventionally unix seconds; multiply if it looks
    // smaller than year 3000 in ms (10^13).
    expiresAt = r.expires_at < 1e12 ? r.expires_at * 1000 : r.expires_at;
  }
  const out: OAuthTokens = { accessToken, tokenType };
  if (refreshToken) out.refreshToken = refreshToken;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  if (scope) out.scope = scope;
  if (ctx?.clientId) out.clientId = ctx.clientId;
  if (ctx?.clientSecret) out.clientSecret = ctx.clientSecret;
  return out;
}

/**
 * Refresh tokens for a source when an access token is near expiry. Returns
 * the fresh tokens (also persists them via the credential store).
 *
 * Throws if the provider has no refresh token on file, or if the refresh
 * call itself fails. The resolver catches and falls back to returning the
 * stale token — better than dropping the platform credential entirely on a
 * transient network failure.
 */
export async function refreshOAuthTokens(opts: {
  source: string;
  credentialStore: CredentialStore;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokens> {
  const provider = getMcpOAuthProvider(opts.source);
  if (!provider) {
    throw new Error(`Unknown MCP OAuth provider: ${opts.source}`);
  }
  const current = opts.credentialStore.getMcpOAuthTokens(opts.source);
  if (!current?.refreshToken) {
    throw new Error(`No refresh token on file for ${opts.source}`);
  }
  const clientId = current.clientId;
  if (!clientId) {
    throw new Error(`No client_id on file for ${opts.source}; reconnect required`);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: clientId,
  });
  if (current.clientSecret) body.set("client_secret", current.clientSecret);

  const f = opts.fetchImpl ?? fetch;
  const res = await f(provider.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: oauthFetchSignal(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Refresh endpoint returned ${res.status}: ${text.slice(0, 500) || res.statusText}`,
    );
  }
  const parsed: unknown = await res.json().catch(() => null);
  const next = normalizeTokenResponse(parsed, {
    clientId,
    ...(current.clientSecret !== undefined ? { clientSecret: current.clientSecret } : {}),
  });
  // Some providers (Linear) reissue the refresh token, others (Notion) keep
  // it stable and omit it. Carry the old refresh token forward when the new
  // response doesn't include one — otherwise we'd lose the ability to
  // refresh next time.
  if (!next.refreshToken && current.refreshToken) {
    next.refreshToken = current.refreshToken;
  }
  opts.credentialStore.setMcpOAuthTokens(opts.source, next);
  return next;
}

// ---------------------------------------------------------------------------
// Read-only helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot of every configured + connected provider for the Settings UI.
 * `connected: false` entries are included so the UI can render "Available
 * to connect" rows even when the user hasn't auth'd yet.
 */
export function listMcpOAuthProviders(
  credentialStore: CredentialStore,
): { provider: McpOAuthProviderConfig; status: McpOAuthStatus }[] {
  return MCP_OAUTH_PROVIDERS.map((provider) => {
    const tokens = credentialStore.getMcpOAuthTokens(provider.id);
    const status: McpOAuthStatus = tokens
      ? {
          source: provider.id,
          connected: true,
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
          ...(tokens.obtainedAt !== undefined ? { obtainedAt: tokens.obtainedAt } : {}),
          ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
        }
      : { source: provider.id, connected: false };
    return { provider, status };
  });
}

/** Remove a provider's tokens. The UI calls this for the "Disconnect" button. */
export function disconnectMcpOAuth(credentialStore: CredentialStore, source: string): void {
  if (!getMcpOAuthProvider(source)) {
    throw new ServiceError(404, `Unknown MCP OAuth provider: ${source}`);
  }
  credentialStore.deleteMcpOAuthTokens(source);
}

/**
 * Refresh every OAuth token in the store whose `expiresAt` is within
 * `safetyMarginMs` of now. Called from {@link refreshExpiredMcpOAuthTokens}
 * on orchestrator startup and (optionally) before each agent turn. Failures
 * are logged and otherwise ignored — the stale token is left in place so
 * the worker can surface a meaningful `mcp_server_status` failure.
 *
 * Default safety margin: 5 minutes. Tokens that expire within the next 5
 * minutes are pre-emptively refreshed to avoid a race where the access
 * token is fresh at agent-start but stale by the time the first MCP tool
 * call lands.
 */
export async function refreshExpiredMcpOAuthTokens(opts: {
  credentialStore: CredentialStore;
  /** Defaults to 5 minutes. */
  safetyMarginMs?: number;
  /** Defaults to `Date.now()`. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshed: string[]; failed: { source: string; error: string }[] }> {
  const safetyMarginMs = opts.safetyMarginMs ?? 5 * 60 * 1000;
  const now = (opts.now ?? Date.now)();
  const all = opts.credentialStore.getAllMcpOAuthTokens();
  const refreshed: string[] = [];
  const failed: { source: string; error: string }[] = [];
  for (const [source, tokens] of Object.entries(all)) {
    // Skip tokens with no expiry — providers like Notion issue
    // non-expiring workspace tokens.
    if (tokens.expiresAt === undefined) continue;
    if (tokens.expiresAt > now + safetyMarginMs) continue;
    if (!tokens.refreshToken) {
      failed.push({ source, error: "expired and no refresh token on file" });
      continue;
    }
    try {
      await refreshOAuthTokens({
        source,
        credentialStore: opts.credentialStore,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      refreshed.push(source);
    } catch (err) {
      failed.push({ source, error: getErrorMessage(err) });
    }
  }
  return { refreshed, failed };
}
