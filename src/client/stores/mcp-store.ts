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
} from "../../server/shared/types.js";

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
  /** Reset store state (session switch / full reset). */
  reset: () => void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  statuses: {},
  loading: false,
  error: null,

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
    return request<McpTestResult>("POST", `/api/mcp-servers/${encodeURIComponent(id)}/test`);
  },

  applyStatus: (name, state, reason) => {
    set((s) => ({ statuses: { ...s.statuses, [name]: { state, reason } } }));
  },

  reset: () => set({ servers: [], statuses: {}, loading: false, error: null }),
}));
