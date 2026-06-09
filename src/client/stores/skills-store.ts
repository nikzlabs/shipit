/**
 * Skills store — Settings → Skills tab state (docs/149).
 *
 * Holds the catalog list (Discover) and the repo-targeted install action. The
 * tab is app-wide: catalogs are shared across sessions, and install spawns its
 * own dedicated session + PR (it never touches the active session). Skills
 * *invocation* (the `/`-autocomplete fed by `services/skills.ts`) lives in its
 * own per-session fetch; this store is the *management* surface only.
 *
 * There is no install-list or uninstall here: removing a marketplace skill is a
 * plain "delete the dir + commit" the user asks the agent to do (CLAUDE.md §5).
 */

import { create } from "zustand";
import type { MarketplaceInfo, PluginInfo } from "../../server/shared/types.js";

interface SkillsState {
  marketplaces: MarketplaceInfo[];
  /** Plugin list per marketplace id (already filtered by the server). */
  pluginsByMarketplace: Record<string, PluginInfo[]>;
  /** True while a network request is in flight. */
  loading: boolean;
  /** Last error surfaced from a fetch / install call, if any. */
  error: string | null;

  fetchMarketplaces: (agentId: string) => Promise<void>;
  fetchPlugins: (marketplaceId: string) => Promise<void>;
  refreshMarketplace: (marketplaceId: string) => Promise<void>;
  /**
   * docs/149 v1c — repo-targeted install. Spawns a dedicated session that
   * installs the skill and opens a PR, leaving the current session untouched.
   * Returns the new session id + PR so the caller can point the user at it.
   */
  installToRepo: (
    repoUrl: string,
    marketplaceId: string,
    pluginName: string,
  ) => Promise<InstallToRepoResult>;
  reset: () => void;
}

export interface InstallToRepoResult {
  sessionId: string;
  branch: string;
  pr: { number: number; url: string };
  installedDirs: string[];
}

const initialState = {
  marketplaces: [] as MarketplaceInfo[],
  pluginsByMarketplace: {} as Record<string, PluginInfo[]>,
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

  installToRepo: async (repoUrl, marketplaceId, pluginName) => {
    set({ loading: true, error: null });
    try {
      const data = await jsonOrThrow<InstallToRepoResult>(
        await fetch(`/api/plugins/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoUrl, marketplaceId, pluginName }),
        }),
      );
      return data;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  reset: () => set({ ...initialState }),
}));
