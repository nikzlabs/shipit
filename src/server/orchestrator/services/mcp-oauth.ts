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

// Bound token and registration requests so they cannot hold agent startup indefinitely.
const OAUTH_FETCH_TIMEOUT_MS = 7_000;

function oauthFetchSignal(): AbortSignal {
  return AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS);
}

export interface OAuthFlowState {
  source: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  /** Preserve discovered endpoints for the callback instead of resolving them again. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  createdAt: number;
}

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

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

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

export interface StartOAuthFlowResult {
  authorizeUrl: string;
  state: string;
}

export interface OAuthCallbackInput {
  state: string;
  code: string;
}

export interface OAuthCallbackResult {
  source: string;
  provider: McpOAuthProviderConfig;
}

export async function startOAuthFlow(opts: {
  source: string;
  stateStore: InMemoryOAuthStateStore;
  redirectUri: string;
  credentialStore: CredentialStore;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<StartOAuthFlowResult> {
  const provider = getMcpOAuthProvider(opts.source);
  if (!provider) {
    throw new ServiceError(404, `Unknown MCP OAuth provider: ${opts.source}`);
  }
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl;

  let discovered: DiscoveredOAuthMetadata | undefined;
  try {
    discovered = await discoverOAuthMetadata({
      mcpUrl: provider.mcpUrl,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
  } catch (err) {
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

  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const envClientId = provider.clientIdEnv ? env[provider.clientIdEnv] : undefined;
  if (envClientId) {
    clientId = envClientId;
    clientSecret = provider.clientSecretEnv ? env[provider.clientSecretEnv] : undefined;
  } else {
    const cached = opts.credentialStore.getMcpOAuthClient(provider.id);
    if (cached) {
      clientId = cached.clientId;
      clientSecret = cached.clientSecret;
    } else if (registrationEndpoint) {
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
  }

  if (!clientId) {
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

/** Use the same redirect URI for registration, authorization, and token exchange. */
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

export async function handleOAuthCallback(opts: {
  input: OAuthCallbackInput;
  stateStore: InMemoryOAuthStateStore;
  credentialStore: CredentialStore;
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

async function exchangeCodeForTokens(opts: {
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
    throw new Error(`Token endpoint request failed: ${getErrorMessage(err)}`, { cause: err });
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
    // Accept expires_at in either seconds or milliseconds.
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
  // Providers can omit an unchanged refresh token; retain it for the next refresh.
  if (!next.refreshToken && current.refreshToken) {
    next.refreshToken = current.refreshToken;
  }
  opts.credentialStore.setMcpOAuthTokens(opts.source, next);
  return next;
}

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

export function disconnectMcpOAuth(credentialStore: CredentialStore, source: string): void {
  if (!getMcpOAuthProvider(source)) {
    throw new ServiceError(404, `Unknown MCP OAuth provider: ${source}`);
  }
  credentialStore.deleteMcpOAuthTokens(source);
}

/** Refresh ahead of expiry so tokens remain valid between agent startup and tool calls. */
export async function refreshExpiredMcpOAuthTokens(opts: {
  credentialStore: CredentialStore;
  safetyMarginMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshed: string[]; failed: { source: string; error: string }[] }> {
  const safetyMarginMs = opts.safetyMarginMs ?? 5 * 60 * 1000;
  const now = (opts.now ?? Date.now)();
  const all = opts.credentialStore.getAllMcpOAuthTokens();
  const refreshed: string[] = [];
  const failed: { source: string; error: string }[] = [];
  for (const [source, tokens] of Object.entries(all)) {
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
