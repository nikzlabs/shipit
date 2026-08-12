import { create } from "zustand";
import type { PluginReposSnapshot } from "../../server/shared/plugin-repos.js";
import { useSessionStore } from "./session-store.js";

/**
 * docs/262 — the session-scoped store behind the Plugins tab (plan §3).
 *
 * Session-scoped, not pane-local: the tab's *visibility* and its warn dot are
 * derived from the snapshot, so the data must exist while the pane is closed.
 * Seeded on session change (App keys a fetch on `sessionId`), refetched by the
 * `files_changed` shipit.yaml hook — the server re-reads the config per
 * request, so the browser's copy is the only stale view. Stale-session
 * guarded: a fetch that resolves after the user switched away is dropped.
 */

interface PluginReposState {
  /** The active session's snapshot; null until the first fetch lands. */
  snapshot: PluginReposSnapshot | null;
  /** Which session `snapshot` belongs to — the stale-fetch guard. */
  forSessionId: string | null;
  fetchSnapshot: (sessionId: string) => Promise<void>;
  reset: () => void;
}

export const usePluginReposStore = create<PluginReposState>((set) => ({
  snapshot: null,
  forSessionId: null,

  fetchSnapshot: async (sessionId: string) => {
    try {
      const res = await fetch(`/api/plugin-repos?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const snapshot = (await res.json()) as PluginReposSnapshot;
      // Guard against a response landing after a session switch — the store
      // holds exactly one session's snapshot, and a foreign one would gate the
      // tab (and its warn dot) on the wrong repository's declarations.
      if (useSessionStore.getState().sessionId !== sessionId) return;
      set({ snapshot, forSessionId: sessionId });
    } catch (err) {
      console.warn("[plugin-repos]", err);
    }
  },

  reset: () => set({ snapshot: null, forSessionId: null }),
}));

/**
 * Tab gating (req 13): plugin INTENT shows the tab — a `plugins:` block that
 * parses to zero valid repos still needs its warning surface — and so does a
 * parse-warning-only snapshot (an unreadable shipit.yaml can't prove intent
 * either way, and hiding the tab would erase the one place that says so).
 */
export function pluginsTabVisible(snapshot: PluginReposSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.declared || snapshot.warnings.length > 0;
}

/**
 * The warn dot (plan §3): parse warnings and per-repo issues count; the v0
 * `declared` (mechanics-not-built-yet) status deliberately does not.
 */
export function pluginsAttention(snapshot: PluginReposSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.warnings.length > 0 || snapshot.repos.some((r) => r.issues.length > 0);
}
