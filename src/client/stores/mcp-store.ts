/**
 * MCP server store (docs/088-mcp-integration).
 *
 * Mirrors the account-level MCP server configs from the server and exposes
 * CRUD + connectivity-test actions that round-trip through `/api/mcp-servers`.
 * Per-server runtime state (loaded / failed / crashed) arrives separately via
 * `mcp_server_status` WS messages and is merged into `statuses`.
 *
 * Server config blobs hold `$secret:` placeholders only — raw secret values
 * are never returned by the API, so this store never holds them.
 */

import { create } from "zustand";
import type {
  McpServerConfig,
  McpServerState,
  McpTestResult,
  McpOAuthStatus,
} from "../../server/shared/types.js";

export interface McpOAuthProviderInfo {
  id: string;
  label: string;
  description?: string;
  mcpUrl: string;
  defaultServerName: string;
  status: McpOAuthStatus;
}

class McpApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new McpApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface McpServerStatusEntry {
  state: McpServerState;
  reason?: string;
}

interface McpState {
  servers: McpServerConfig[];

  statuses: Record<string, McpServerStatusEntry>;
  loading: boolean;

  error: string | null;

  oauthProviders: McpOAuthProviderInfo[];
  oauthLoading: boolean;

  oauthError: string | null;

  fetchServers: () => Promise<void>;
  /**
   * Add a server. `config` carries `$secret:` placeholders; `secrets` maps
   * `mcp__<name>__*` keys to raw values (stored server-side, never echoed).
   */
  addServer: (config: McpServerConfig, secrets?: Record<string, string>) => Promise<void>;
  updateServer: (
    id: string,
    config: McpServerConfig,
    secrets?: Record<string, string>,
  ) => Promise<void>;
  removeServer: (id: string) => Promise<void>;
  testServer: (id: string) => Promise<McpTestResult>;

  applyStatus: (name: string, state: McpServerState, reason?: string) => void;

  clearStatus: (name: string) => void;

  reset: () => void;

  fetchOAuthProviders: () => Promise<void>;

  startOAuthFlow: (source: string) => Promise<{ ok: boolean; message?: string }>;

  disconnectOAuth: (source: string) => Promise<void>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  statuses: {},
  loading: false,
  error: null,
  oauthProviders: [],
  oauthLoading: false,
  oauthError: null,

  fetchServers: async () => {
    set({ loading: true, error: null });
    try {
      const { servers } = await request<{ servers: McpServerConfig[] }>(
        "GET",
        "/api/mcp-servers",
      );
      set({ servers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  addServer: async (config, secrets) => {
    set({ error: null });
    try {
      const { server } = await request<{ server: McpServerConfig }>(
        "POST",
        "/api/mcp-servers",
        { config, secrets },
      );
      set((s) => ({ servers: [...s.servers, server].sort((a, b) => a.name.localeCompare(b.name)) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  updateServer: async (id, config, secrets) => {
    set({ error: null });
    try {
      const { server } = await request<{ server: McpServerConfig }>(
        "PUT",
        `/api/mcp-servers/${encodeURIComponent(id)}`,
        { config, secrets },
      );
      set((s) => ({
        servers: s.servers
          .filter((srv) => srv.name !== id)
          .concat(server)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  removeServer: async (id) => {
    set({ error: null });
    try {
      await request("DELETE", `/api/mcp-servers/${encodeURIComponent(id)}`);
      set((s) => {
        const statuses = Object.fromEntries(
          Object.entries(s.statuses).filter(([name]) => name !== id),
        );
        return { servers: s.servers.filter((srv) => srv.name !== id), statuses };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  testServer: async (id) => {
    const result = await request<McpTestResult>(
      "POST",
      `/api/mcp-servers/${encodeURIComponent(id)}/test`,
    );

    if (result.ok) {
      get().applyStatus(id, "loaded");
    } else {
      get().applyStatus(id, "failed", result.error);
    }
    return result;
  },

  applyStatus: (name, state, reason) => {
    set((s) => ({ statuses: { ...s.statuses, [name]: { state, reason } } }));
  },

  clearStatus: (name) => {
    set((s) => {
      if (!(name in s.statuses)) return s;
      const { [name]: _dropped, ...rest } = s.statuses;
      return { statuses: rest };
    });
  },

  reset: () =>
    set({
      servers: [],
      statuses: {},
      loading: false,
      error: null,
      oauthProviders: [],
      oauthLoading: false,
      oauthError: null,
    }),

  fetchOAuthProviders: async () => {
    set({ oauthLoading: true, oauthError: null });
    try {
      const { providers } = await request<{ providers?: McpOAuthProviderInfo[] }>(
        "GET",
        "/api/mcp-servers/oauth/providers",
      );

      set({ oauthProviders: providers ?? [], oauthLoading: false });
    } catch (err) {
      set({
        oauthLoading: false,
        oauthError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  startOAuthFlow: async (source) => {
    set({ oauthError: null });
    try {
      const { authorizeUrl } = await request<{ authorizeUrl: string; state: string }>(
        "POST",
        "/api/mcp-servers/oauth/start",
        { source },
      );

      const popup = window.open(
        authorizeUrl,
        `shipit-mcp-oauth-${source}`,
        "width=520,height=720,popup=yes",
      );
      if (!popup) {
        const msg = "Popup was blocked. Allow popups for ShipIt and try again.";
        set({ oauthError: msg });
        return { ok: false, message: msg };
      }
      const result = await waitForOAuthCallback(source, popup);

      await get().fetchOAuthProviders();
      if (!result.ok && result.message) {
        set({ oauthError: result.message });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ oauthError: message });
      return { ok: false, message };
    }
  },

  disconnectOAuth: async (source) => {
    set({ oauthError: null });
    try {
      await request("DELETE", `/api/mcp-servers/oauth/${encodeURIComponent(source)}`);
      await get().fetchOAuthProviders();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ oauthError: message });
      throw err;
    }
  },
}));

function waitForOAuthCallback(
  source: string,
  popup: Window,
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    function cleanup() {
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
    }
    function onMessage(ev: MessageEvent<unknown>) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data;
      if (
        !data ||
        typeof data !== "object" ||
        (data as { type?: string }).type !== "shipit-mcp-oauth-result"
      ) {
        return;
      }
      const payload = data as { ok?: boolean; source?: string; message?: string };
      if (payload.source !== source) return;
      cleanup();
      try {
        popup.close();
      } catch {
        /* ignore */
      }
      resolve({
        ok: Boolean(payload.ok),
        ...(payload.message !== undefined ? { message: payload.message } : {}),
      });
    }
    window.addEventListener("message", onMessage);

    const poll = setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve({ ok: false, message: "Authentication window was closed." });
      }
    }, 500);
  });
}
