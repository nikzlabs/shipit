/**
 * Skills store — Settings → Skills tab state (docs/149).
 *
 * Holds the catalog list (Discover sub-tab) and per-session installed
 * plugin rows (Installed sub-tab). Skills *invocation* (the `/`-autocomplete
 * fed by `services/skills.ts`) lives in its own per-session fetch on the
 * client side; this store is for the *management* surface only.
 *
 * Catalog data is app-wide (one set of marketplaces shared across every
 * session) but Discover filters by the active session's agent so a Claude
 * session never sees a Codex catalog. The store keeps per-marketplace plugin
 * lists in a map keyed by marketplace id, so switching the active agent
 * just re-reads the relevant catalogs without re-fetching unrelated ones.
 */

import { create } from "zustand";
import type {
  InstalledPluginInfo,
  MarketplaceInfo,
  PluginInfo,
} from "../../server/shared/types.js";
import { useFileStore } from "./file-store.js";
import { useUiStore } from "./ui-store.js";

interface SkillsState {
  marketplaces: MarketplaceInfo[];
  /** Plugin list per marketplace id (already filtered by the server). */
  pluginsByMarketplace: Record<string, PluginInfo[]>;
  /** Installed plugins for the current session (re-fetched on session switch). */
  installed: InstalledPluginInfo[];
  /** True while a network request is in flight. */
  loading: boolean;
  /** Last error surfaced from a fetch / install / uninstall call, if any. */
  error: string | null;

  fetchMarketplaces: (agentId: string) => Promise<void>;
  fetchPlugins: (marketplaceId: string) => Promise<void>;
  refreshMarketplace: (marketplaceId: string) => Promise<void>;
  fetchInstalled: (sessionId: string) => Promise<void>;
  install: (sessionId: string, marketplaceId: string, pluginName: string) => Promise<void>;
  uninstall: (sessionId: string, marketplaceId: string, pluginName: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  marketplaces: [] as MarketplaceInfo[],
  pluginsByMarketplace: {} as Record<string, PluginInfo[]>,
  installed: [] as InstalledPluginInfo[],
  loading: false,
  error: null as string | null,
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  ...initialState,

  fetchMarketplaces: async (agentId) => {
    set({ loading: true, error: null });
    try {
      const data = await jsonOrThrow<{ marketplaces: MarketplaceInfo[] }>(
        await fetch(`/api/marketplaces?agent=${encodeURIComponent(agentId)}`),
      );
      set({ marketplaces: data.marketplaces });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  fetchPlugins: async (marketplaceId) => {
    set({ loading: true, error: null });
    try {
      const data = await jsonOrThrow<{ plugins: PluginInfo[]; marketplace: MarketplaceInfo }>(
        await fetch(`/api/marketplaces/${encodeURIComponent(marketplaceId)}/plugins`),
      );
      set((s) => ({
        pluginsByMarketplace: { ...s.pluginsByMarketplace, [marketplaceId]: data.plugins },
        // Update the marketplace row in-place too, since the fetch flips it ok/fetch-failed.
        marketplaces: s.marketplaces.map((m) => (m.id === marketplaceId ? data.marketplace : m)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  refreshMarketplace: async (marketplaceId) => {
    set({ loading: true, error: null });
    try {
      await jsonOrThrow<{ marketplace: MarketplaceInfo }>(
        await fetch(`/api/marketplaces/${encodeURIComponent(marketplaceId)}/refresh`, {
          method: "POST",
        }),
      );
      // Pull the fresh plugin list now that the cache is up-to-date.
      await get().fetchPlugins(marketplaceId);
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  fetchInstalled: async (sessionId) => {
    try {
      const data = await jsonOrThrow<{ plugins: InstalledPluginInfo[] }>(
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugins`),
      );
      set({ installed: data.plugins });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  install: async (sessionId, marketplaceId, pluginName) => {
    set({ loading: true, error: null });
    try {
      await jsonOrThrow(
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugins/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ marketplaceId, pluginName }),
        }),
      );
      await get().fetchInstalled(sessionId);
      // Refresh the composer's `/`-autocomplete cache so the new skill is
      // invokable on the next message without a page reload.
      await useFileStore.getState()
        .fetchSkills(sessionId, useUiStore.getState().activeAgentId)
        .catch(() => {});
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  uninstall: async (sessionId, marketplaceId, pluginName) => {
    set({ loading: true, error: null });
    try {
      await jsonOrThrow(
        await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(marketplaceId)}/${encodeURIComponent(pluginName)}`,
          { method: "DELETE" },
        ),
      );
      await get().fetchInstalled(sessionId);
      await useFileStore.getState()
        .fetchSkills(sessionId, useUiStore.getState().activeAgentId)
        .catch(() => {});
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  reset: () => set({ ...initialState }),
}));
