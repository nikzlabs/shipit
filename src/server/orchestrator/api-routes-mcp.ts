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
  refreshOAuthTokens,
} from "./services/index.js";
import {
  isAgentSecretsCapable,
  refreshAgentEnvForAllSessions,
  selectAgentEnvForPush,
  type AccountAgentEnvSource,
} from "./session-agent-env.js";
import { getErrorMessage } from "./validation.js";

export interface McpRoutesDeps {
  credentialStore: CredentialStore;
  runnerRegistry: SessionRunnerRegistry;
  serviceManagers: Map<string, ServiceManager>;
  oauthStateStore?: InMemoryOAuthStateStore;
  oauthRedirectUri?: string;
  oauthFetchImpl?: typeof fetch;
}

interface McpTestCapableRunner {
  proxyMcpTest(config: unknown): Promise<unknown>;
}

function isMcpTestCapable(runner: unknown): runner is McpTestCapableRunner {
  return (
    !!runner &&
    typeof (runner as McpTestCapableRunner).proxyMcpTest === "function"
  );
}

export function extractPlatformSourcesFromMcpConfig(config: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const re = /\$platform:([a-z][a-z0-9_]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value))) found.add(m[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };
  visit(config);
  return [...found];
}

function isMcpAuthFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const ok = (result as { ok?: unknown }).ok;
  const error = (result as { error?: unknown }).error;
  if (ok !== false || typeof error !== "string") return false;
  return /\b401\b/.test(error) || /invalid[_ -]?token|unauthori[sz]ed/i.test(error);
}

async function pushAgentEnvToRunner(
  runner: unknown,
  deps: {
    credentialStore: AccountAgentEnvSource;
  },
): Promise<void> {
  if (!isAgentSecretsCapable(runner)) return;
  await runner.tryPushAgentSecrets(
    selectAgentEnvForPush({
      serviceManager: runner.serviceManager ?? null,
      credentialStore: deps.credentialStore,
    }),
  );
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

  app.get("/api/mcp-servers", async () => {
    return { servers: listMcpServers(credentialStore) };
  });

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

  app.post<{ Params: { id: string } }>(
    "/api/mcp-servers/:id/test",
    async (request, reply) => {
      const server = credentialStore.getMcpServer(request.params.id);
      if (!server) {
        reply.code(404);
        return { error: `MCP server "${request.params.id}" not found` };
      }

      // User-supplied MCP commands must run inside a session container.
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
        const first = await runner.proxyMcpTest(server);
        if (!isMcpAuthFailure(first)) return first;

        const platformSources = extractPlatformSourcesFromMcpConfig(server);
        if (platformSources.length === 0) return first;

        const refreshed: string[] = [];
        const failed: string[] = [];
        for (const source of platformSources) {
          try {
            await refreshOAuthTokens({
              source,
              credentialStore,
              ...(oauthFetchImpl !== undefined ? { fetchImpl: oauthFetchImpl } : {}),
            });
            refreshed.push(source);
          } catch (err) {
            failed.push(`${source}: ${getErrorMessage(err)}`);
          }
        }

        if (refreshed.length === 0) {
          return {
            ok: false,
            error:
              `MCP OAuth token was rejected and refresh failed. ` +
              `Reconnect this provider in Settings. ${failed.join("; ")}`,
          };
        }

        refreshAgentEnvForAllSessions(serviceManagers);
        await pushAgentEnvToRunner(runner, { credentialStore });
        const retry = await runner.proxyMcpTest(server);
        if (!isMcpAuthFailure(retry)) return retry;
        return {
          ok: false,
          error:
            `MCP OAuth token was rejected even after refreshing ` +
            `${refreshed.join(", ")}. Reconnect this provider in Settings.`,
        };
      } catch (err) {
        return { ok: false, error: getErrorMessage(err) };
      }
    },
  );

  app.get("/api/mcp-servers/oauth/providers", async () => {
    return {
      providers: listMcpOAuthProviders(credentialStore).map(({ provider, status }) => ({
        id: provider.id,
        label: provider.label,
        description: provider.description,
        mcpUrl: provider.mcpUrl,
        defaultServerName: provider.defaultServerName,
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
    {
      // Permit the provider's redirect; handleOAuthCallback validates one-time state.
      config: { crossOriginNavigation: true },
    },
    async (request, reply) => {
      const { code, state, error, error_description: errorDescription } = request.query;
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

function deriveCallbackUrl(headers: Record<string, string | string[] | undefined>): string {
  const proto = headerString(headers["x-forwarded-proto"]) ?? "http";
  const host = headerString(headers["x-forwarded-host"]) ?? headerString(headers.host) ?? "localhost:3000";
  return `${proto}://${host}/api/mcp-servers/oauth/callback`;
}

function headerString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

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
