/**
 * MCP server API routes (docs/088-mcp-integration).
 *
 * Account-level CRUD for user-configured MCP servers, plus a connectivity
 * test that is proxied into an active session container (the orchestrator
 * never execs user-supplied stdio binaries itself — see plan §"Test endpoint
 * isolation").
 *
 * Server config blobs hold `$secret:` placeholders only; raw secret values
 * live in `CredentialStore.agentEnv` under `mcp__<server>__*` and are never
 * echoed back. After every mutation we trigger the agent-env refresh path on
 * each active session's ServiceManager so the merged `.shipit/.env.agent` is
 * rewritten and pushed to the worker (reusing 087's transport substrate).
 */

import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "./credential-store.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import {
  ServiceError,
  listMcpServers,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  startOAuthFlow,
  handleOAuthCallback,
  listMcpOAuthProviders,
  disconnectMcpOAuth,
  InMemoryOAuthStateStore,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";

export interface McpRoutesDeps {
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
  /** Per-session ServiceManager registry — used to push refreshed agent env. */
  serviceManagers: Map<string, ServiceManager>;
  /**
   * Optional override for the in-process OAuth flow state store. Tests
   * substitute a deterministic implementation; production defaults to a
   * fresh {@link InMemoryOAuthStateStore} per orchestrator process.
   */
  oauthStateStore?: InMemoryOAuthStateStore;
  /**
   * Optional override for the redirect URI used when starting OAuth flows.
   * When omitted, the route derives it from the inbound request's
   * `x-forwarded-host` (or `host`) header so the same orchestrator works
   * behind a reverse proxy without configuration.
   */
  oauthRedirectUri?: string;
  /** Override for `fetch` used during token exchange. Tests inject. */
  oauthFetchImpl?: typeof fetch;
}

/** A runner that can proxy an MCP test into its container. */
interface McpTestCapableRunner {
  proxyMcpTest(config: unknown): Promise<unknown>;
}

function isMcpTestCapable(runner: unknown): runner is McpTestCapableRunner {
  return (
    !!runner &&
    typeof (runner as McpTestCapableRunner).proxyMcpTest === "function"
  );
}

/**
 * Trigger the agent-env refresh on every active session's ServiceManager.
 * Each `refreshSecrets()` re-runs `syncSecrets()`, which re-reads the
 * `mcp__*` keys from CredentialStore, rewrites `.shipit/.env.agent`, and
 * pushes the full set to the worker via `PUT /secrets`. The worker REPLACES
 * its tracked set on every push, so deleted/renamed keys are dropped without
 * an explicit clear list. Fire-and-forget per session.
 */
function refreshAgentEnvForAllSessions(serviceManagers: Map<string, ServiceManager>): void {
  for (const [sessionId, mgr] of serviceManagers) {
    mgr.refreshSecrets().catch((err: unknown) => {
      console.warn(`[mcp] agent-env refresh failed for session ${sessionId}:`, getErrorMessage(err));
    });
  }
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRoutesDeps,
): Promise<void> {
  const {
    credentialStore,
    runnerRegistry,
    serviceManagers,
    oauthFetchImpl,
  } = deps;
  const oauthStateStore = deps.oauthStateStore ?? new InMemoryOAuthStateStore();

  // GET /api/mcp-servers — list all configured servers (placeholder form).
  app.get("/api/mcp-servers", async () => {
    return { servers: listMcpServers(credentialStore) };
  });

  // POST /api/mcp-servers — add a new server.
  app.post<{ Body: { config?: unknown; secrets?: unknown } }>(
    "/api/mcp-servers",
    async (request, reply) => {
      const { config, secrets } = request.body ?? {};
      try {
        const saved = addMcpServer(credentialStore, config, secrets);
        refreshAgentEnvForAllSessions(serviceManagers);
        return { server: saved };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // PUT /api/mcp-servers/:id — update (or rename) a server.
  app.put<{ Params: { id: string }; Body: { config?: unknown; secrets?: unknown } }>(
    "/api/mcp-servers/:id",
    async (request, reply) => {
      const { config, secrets } = request.body ?? {};
      try {
        const { config: saved } = updateMcpServer(
          credentialStore,
          request.params.id,
          config,
          secrets,
        );
        refreshAgentEnvForAllSessions(serviceManagers);
        return { server: saved };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // DELETE /api/mcp-servers/:id — remove a server and its secrets.
  app.delete<{ Params: { id: string } }>(
    "/api/mcp-servers/:id",
    async (request, reply) => {
      try {
        removeMcpServer(credentialStore, request.params.id);
        refreshAgentEnvForAllSessions(serviceManagers);
        return { deleted: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  // POST /api/mcp-servers/:id/test — connectivity test, proxied into a
  // session container. 409 if no active container exists.
  app.post<{ Params: { id: string } }>(
    "/api/mcp-servers/:id/test",
    async (request, reply) => {
      const server = credentialStore.getMcpServer(request.params.id);
      if (!server) {
        reply.code(404);
        return { error: `MCP server "${request.params.id}" not found` };
      }

      // Find any session runner that can proxy the test into its container.
      let runner: McpTestCapableRunner | undefined;
      for (const id of runnerRegistry.ids()) {
        const candidate = runnerRegistry.get(id);
        if (isMcpTestCapable(candidate)) {
          runner = candidate;
          break;
        }
      }
      if (!runner) {
        reply.code(409);
        return {
          error: "No active session container. Start a session first to test MCP servers.",
        };
      }

      try {
        return await runner.proxyMcpTest(server);
      } catch (err) {
        return { ok: false, error: getErrorMessage(err) };
      }
    },
  );

  // -------------------------------------------------------------------------
  // OAuth (docs/088-mcp-integration §"Phase 2")
  //
  // Path layout:
  //   GET    /api/mcp-servers/oauth/providers   — provider list + connection state
  //   POST   /api/mcp-servers/oauth/start       — { source } → { authorizeUrl }
  //   GET    /api/mcp-servers/oauth/callback    — provider redirects here with ?code&state
  //   DELETE /api/mcp-servers/oauth/:source     — disconnect
  //
  // The OAuth state store is per-orchestrator-process and short-lived
  // (10-minute TTL); flow values never touch disk. Token storage lives in
  // CredentialStore.mcpOAuth and is read by `platform-credentials.ts` on
  // every `syncSecrets()` pass.
  // -------------------------------------------------------------------------

  app.get("/api/mcp-servers/oauth/providers", async () => {
    return {
      providers: listMcpOAuthProviders(credentialStore).map(({ provider, status }) => ({
        id: provider.id,
        label: provider.label,
        description: provider.description,
        mcpUrl: provider.mcpUrl,
        defaultServerName: provider.defaultServerName,
        // Don't echo the env var name — operators can see it in startup logs
        // when missing. Exposing it here just clutters the response.
        status,
      })),
    };
  });

  app.post<{ Body: { source?: string; redirectUri?: string } }>(
    "/api/mcp-servers/oauth/start",
    async (request, reply) => {
      const source = typeof request.body?.source === "string" ? request.body.source : "";
      if (!source) {
        reply.code(400);
        return { error: "source is required" };
      }
      const redirectUri =
        deps.oauthRedirectUri ??
        request.body?.redirectUri ??
        deriveCallbackUrl(request.headers);
      try {
        const result = await startOAuthFlow({
          source,
          stateStore: oauthStateStore,
          redirectUri,
          credentialStore,
          ...(oauthFetchImpl !== undefined ? { fetchImpl: oauthFetchImpl } : {}),
        });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/api/mcp-servers/oauth/callback",
    async (request, reply) => {
      const { code, state, error, error_description: errorDescription } = request.query;
      // Provider may redirect here with `?error=...` on user-cancel /
      // misconfigured client. Render a friendly closing page rather than
      // erroring out.
      if (error) {
        reply.type("text/html");
        return renderClosePopupHtml({
          ok: false,
          source: state ?? "",
          message: errorDescription ?? error,
        });
      }
      if (!code || !state) {
        reply.code(400).type("text/html");
        return renderClosePopupHtml({
          ok: false,
          source: state ?? "",
          message: "Missing code or state parameter",
        });
      }
      try {
        const result = await handleOAuthCallback({
          input: { code, state },
          stateStore: oauthStateStore,
          credentialStore,
          fetchImpl: oauthFetchImpl,
        });
        // Reuse the agent-env refresh path — the new MCP_PLATFORM_<…> env
        // var is computed from CredentialStore in the loader passed to
        // ServiceManager.syncSecrets().
        refreshAgentEnvForAllSessions(serviceManagers);
        reply.type("text/html");
        return renderClosePopupHtml({
          ok: true,
          source: result.source,
          message: `Connected to ${result.provider.label}.`,
        });
      } catch (err) {
        const message = err instanceof ServiceError ? err.message : getErrorMessage(err);
        reply.code(err instanceof ServiceError ? err.statusCode : 500).type("text/html");
        return renderClosePopupHtml({ ok: false, source: state, message });
      }
    },
  );

  app.delete<{ Params: { source: string } }>(
    "/api/mcp-servers/oauth/:source",
    async (request, reply) => {
      try {
        disconnectMcpOAuth(credentialStore, request.params.source);
        refreshAgentEnvForAllSessions(serviceManagers);
        return { deleted: true };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode);
          return { error: err.message };
        }
        throw err;
      }
    },
  );
}

/**
 * Derive the callback URL from the inbound request's `x-forwarded-*` / `host`
 * headers. Used when the deps don't supply an explicit `oauthRedirectUri`.
 *
 * Honors `x-forwarded-proto` / `x-forwarded-host` so the URL the provider
 * redirects back to matches what the user sees in their address bar (the
 * outer proxy in production, the dev host in development).
 */
function deriveCallbackUrl(headers: Record<string, string | string[] | undefined>): string {
  const proto = headerString(headers["x-forwarded-proto"]) ?? "http";
  const host = headerString(headers["x-forwarded-host"]) ?? headerString(headers.host) ?? "localhost:3000";
  return `${proto}://${host}/api/mcp-servers/oauth/callback`;
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Tiny HTML page rendered into the OAuth popup after the callback. It
 * postMessages the result up to the opener (the Settings panel) and then
 * closes itself. Falls back to a static success/failure message if the
 * popup wasn't opened with `window.open()` (e.g. the user pasted the URL
 * directly into a tab).
 */
function renderClosePopupHtml(opts: { ok: boolean; source: string; message: string }): string {
  const payload = JSON.stringify({
    type: "shipit-mcp-oauth-result",
    ok: opts.ok,
    source: opts.source,
    message: opts.message,
  });
  const safeMessage = escapeHtml(opts.message);
  const title = opts.ok ? "Connected" : "Connection failed";
  const color = opts.ok ? "#10b981" : "#ef4444";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title} — ShipIt</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #f5f5f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 24px 32px; max-width: 420px; text-align: center; }
    h1 { color: ${color}; font-size: 18px; margin: 0 0 8px; }
    p { color: #a3a3a3; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${safeMessage}</p>
    <p style="margin-top:12px;font-size:12px;color:#525252;">You can close this window.</p>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, window.location.origin);
      }
    } catch (e) {}
    setTimeout(function() { window.close(); }, 800);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
