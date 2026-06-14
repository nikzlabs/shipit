import { create } from "zustand";
import type { EgressSettings } from "../../server/shared/types.js";

/**
 * Egress containment settings store (docs/172 / SHI-90).
 *
 * Backs the Settings → Advanced → "Network egress" section: the default-on
 * global containment toggle (Contained vs Open) and the user-managed allowlist
 * editor. State is loaded lazily when the Settings dialog opens (`load`) and
 * kept in sync across tabs by the `egress_settings` SSE event.
 *
 * Mutations are optimistic with rollback: the toggle/host change updates the
 * store immediately, fires the browser-only `/api/egress/*` route, and reverts
 * on failure (surfacing a toast via the caller). These routes are NOT
 * `containerAccessible` — SHI-129's default-deny keeps the contained agent from
 * reaching them, so it can never loosen its own containment.
 */
interface EgressState {
  /** Whether the settings have been fetched at least once. */
  loaded: boolean;
  /** Global containment switch: true = Contained (default-deny), false = Open. */
  globalEnabled: boolean;
  /** User-managed global allowlist hosts (on top of built-ins + MCP + operator). */
  globalHosts: string[];

  /** Apply a server snapshot (from `load` or the SSE broadcast). */
  applySnapshot: (s: EgressSettings) => void;
  /** Fetch the current settings from the server. */
  load: () => Promise<void>;
  /** Flip the global containment toggle (optimistic; throws on failure). */
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  /** Add a host to the global allowlist (optimistic; throws on failure). */
  addHost: (host: string) => Promise<void>;
  /** Remove a host from the global allowlist (optimistic; throws on failure). */
  removeHost: (host: string) => Promise<void>;
}

export const useEgressStore = create<EgressState>((set, get) => ({
  loaded: false,
  globalEnabled: true,
  globalHosts: [],

  applySnapshot: (s) => set({ globalEnabled: s.globalEnabled, globalHosts: s.globalHosts, loaded: true }),

  load: async () => {
    const res = await fetch("/api/egress/settings");
    if (!res.ok) throw new Error(`Failed to load egress settings: ${res.status}`);
    get().applySnapshot((await res.json()) as EgressSettings);
  },

  setGlobalEnabled: async (enabled) => {
    const prev = get().globalEnabled;
    set({ globalEnabled: enabled });
    try {
      const res = await fetch("/api/egress/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalEnabled: enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      get().applySnapshot((await res.json()) as EgressSettings);
    } catch (err) {
      set({ globalEnabled: prev });
      throw err;
    }
  },

  addHost: async (host) => {
    const trimmed = host.trim();
    if (!trimmed) return;
    const prev = get().globalHosts;
    // Optimistic: show it immediately (de-duped), server returns the truth.
    if (!prev.includes(trimmed)) set({ globalHosts: [...prev, trimmed] });
    try {
      const res = await fetch("/api/egress/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      get().applySnapshot((await res.json()) as EgressSettings);
    } catch (err) {
      set({ globalHosts: prev });
      throw err;
    }
  },

  removeHost: async (host) => {
    const prev = get().globalHosts;
    set({ globalHosts: prev.filter((h) => h !== host) });
    try {
      const res = await fetch("/api/egress/hosts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      get().applySnapshot((await res.json()) as EgressSettings);
    } catch (err) {
      set({ globalHosts: prev });
      throw err;
    }
  },
}));
