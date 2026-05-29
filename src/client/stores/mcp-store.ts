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

/** Provider info returned by `GET /api/mcp-servers/oauth/providers`. */
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

/** Per-server runtime status from `mcp_server_status` WS events. */
export interface McpServerStatusEntry {
  state: McpServerState;
  reason?: string;
}

interface McpState {
  servers: McpServerConfig[];
  /** Per-server runtime status keyed by server name. */
  statuses: Record<string, McpServerStatusEntry>;
  loading: boolean;
  /** Last load/mutation error, surfaced in the Settings panel. */
  error: string | null;

  // ---- Phase 2: OAuth providers ----
  /** Available OAuth providers (Linear, Notion, …) with connection state. */
  oauthProviders: McpOAuthProviderInfo[];
  oauthLoading: boolean;
  /** Last OAuth flow error (popup close / disconnect / start). */
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
  /** Apply a per-server status update from a `mcp_server_status` WS message. */
  applyStatus: (name: string, state: McpServerState, reason?: string) => void;
  /**
   * Drop the cached runtime status for a server. Used after a Reconnect of
   * an OAuth-managed server so the stale `failed — authentication required`
   * entry doesn't keep the UI red while we wait for the next CLI init event
   * to re-emit the real status.
   */
  clearStatus: (name: string) => void;
  /** Reset store state (session switch / full reset). */
  reset: () => void;

  // ---- OAuth actions ----
  fetchOAuthProviders: () => Promise<void>;
  /**
   * Begin an OAuth flow for a provider. Opens the authorize URL in a popup
   * and resolves when the callback page postMessages a result back. Refreshes
   * `oauthProviders` on success.
   */
  startOAuthFlow: (source: string) => Promise<{ ok: boolean; message?: string }>;
  /** Remove stored OAuth tokens for a provider. */
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
    // The Test button is the user's "did I configure this right?" signal — its
    // outcome should also update the badge, which would otherwise stay stale
    // on whatever the last agent init reported (commonly `failed` from a prior
    // bad config the user just fixed).
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

  // ---- OAuth ----

  fetchOAuthProviders: async () => {
    set({ oauthLoading: true, oauthError: null });
    try {
      const { providers } = await request<{ providers?: McpOAuthProviderInfo[] }>(
        "GET",
        "/api/mcp-servers/oauth/providers",
      );
      // Defensive: a partial / unexpected response shouldn't crash the UI
      // — fall back to an empty list so the existing servers section keeps
      // working. Real server always returns { providers: [...] }.
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
      // Open the consent screen in a popup so the user comes back to ShipIt
      // automatically — no manual tab switching required.
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
      // Refresh provider list so the UI flips Connected/Disconnected.
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

/**
 * Wait for the OAuth callback popup to postMessage a result. Resolves when
 * either the popup posts back or the user closes it without completing.
 */
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
    // Poll for popup-closed too — the user might dismiss without completing.
    const poll = setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve({ ok: false, message: "Authentication window was closed." });
      }
    }, 500);
  });
}
