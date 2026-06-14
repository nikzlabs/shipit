import { create } from "zustand";
import type { EgressAllowlistEntry, EgressAllowlistView } from "../../server/shared/types.js";

/**
 * Egress containment settings store (docs/172 / SHI-90).
 *
 * Backs the Settings → Advanced → "Network egress" section: the default-on
 * global containment toggle (Contained vs Open), the per-session containment
 * override, and the **effective allowlist editor** — the full set of hosts a
 * session can reach, each tagged with provenance (built-in / operator / MCP /
 * user-added). Built-in/operator/MCP rows render read-only; user-added rows are
 * removable + editable. Adds/removes persist to the durable store and (for the
 * active session / a session-scoped add) trigger the in-netns resolver + ipset
 * reload so a brand-new host actually opens without a restart.
 *
 * Loaded lazily when the Settings dialog opens (`load`) for whichever session is
 * in scope, and kept in sync across tabs by the `egress_settings` SSE event.
 * Mutations are optimistic where it helps perceived latency, then reconciled
 * against the server's authoritative effective view (`refresh`).
 *
 * The `/api/egress/*` routes are NOT `containerAccessible` — SHI-129's
 * default-deny keeps the contained agent from reaching them to loosen its own
 * containment.
 */

/** Add/remove scope: the global allowlist, or the in-scope session's extras. */
export type EgressScope = "global" | "session";

interface EgressState {
  loaded: boolean;
  /** Session in scope for per-session rows + override (null = global-only). */
  sessionId: string | null;
  /** The effective allowlist with provenance. */
  entries: EgressAllowlistEntry[];
  /** Global containment switch: true = Contained (default-deny), false = Open. */
  globalEnabled: boolean;
  /** In-scope session override: null = inherit global, true/false = force. */
  override: boolean | null;
  /** Resolved containment for the in-scope session (override ?? global). */
  effectiveContained: boolean;

  applyView: (v: EgressAllowlistView) => void;
  load: (sessionId?: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  setOverride: (override: boolean | null) => Promise<void>;
  addHost: (host: string, scope: EgressScope) => Promise<void>;
  removeHost: (host: string, scope: EgressScope) => Promise<void>;
  editHost: (oldHost: string, newHost: string, scope: EgressScope) => Promise<void>;
}

/** Resolve a UI scope to the API scope string (a session id for "session"). */
function apiScope(scope: EgressScope, sessionId: string | null): string | null {
  if (scope === "global") return "global";
  return sessionId; // null when no session in scope → caller no-ops
}

async function postJson(url: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export const useEgressStore = create<EgressState>((set, get) => ({
  loaded: false,
  sessionId: null,
  entries: [],
  globalEnabled: true,
  override: null,
  effectiveContained: true,

  applyView: (v) =>
    set({
      entries: v.entries,
      globalEnabled: v.globalEnabled,
      override: v.session?.override ?? null,
      effectiveContained: v.session?.effectiveContained ?? v.globalEnabled,
      loaded: true,
    }),

  load: async (sessionId) => {
    const sid = sessionId ?? null;
    set({ sessionId: sid });
    const q = sid ? `?session=${encodeURIComponent(sid)}` : "";
    const res = await fetch(`/api/egress/allowlist${q}`);
    if (!res.ok) throw new Error(`Failed to load egress allowlist: ${res.status}`);
    get().applyView((await res.json()) as EgressAllowlistView);
  },

  refresh: async () => {
    await get().load(get().sessionId);
  },

  setGlobalEnabled: async (enabled) => {
    const prev = get().globalEnabled;
    set({ globalEnabled: enabled });
    try {
      await postJson("/api/egress/settings", "PUT", { globalEnabled: enabled });
      await get().refresh();
    } catch (err) {
      set({ globalEnabled: prev });
      throw err;
    }
  },

  setOverride: async (override) => {
    const sid = get().sessionId;
    if (!sid) return;
    const prev = get().override;
    set({ override });
    try {
      await postJson(`/api/egress/session/${encodeURIComponent(sid)}`, "PUT", { override });
      await get().refresh();
    } catch (err) {
      set({ override: prev });
      throw err;
    }
  },

  addHost: async (host, scope) => {
    const trimmed = host.trim();
    const s = apiScope(scope, get().sessionId);
    if (!trimmed || !s) return;
    // Optimistic: show the row immediately (source matches the scope).
    const optimistic: EgressAllowlistEntry = {
      host: trimmed,
      source: scope === "global" ? "user-global" : "user-session",
      removable: true,
    };
    const prev = get().entries;
    if (!prev.some((e) => e.host === trimmed)) set({ entries: [...prev, optimistic] });
    try {
      await postJson("/api/egress/hosts", "POST", { host: trimmed, scope: s });
      await get().refresh();
    } catch (err) {
      set({ entries: prev });
      throw err;
    }
  },

  removeHost: async (host, scope) => {
    const s = apiScope(scope, get().sessionId);
    if (!s) return;
    const prev = get().entries;
    set({ entries: prev.filter((e) => e.host !== host) });
    try {
      await postJson("/api/egress/hosts", "DELETE", { host, scope: s });
      await get().refresh();
    } catch (err) {
      set({ entries: prev });
      throw err;
    }
  },

  editHost: async (oldHost, newHost, scope) => {
    const next = newHost.trim();
    const s = apiScope(scope, get().sessionId);
    if (!s || !next || next === oldHost) return;
    // Replace = remove old + add new at the same scope, then reconcile once.
    await postJson("/api/egress/hosts", "DELETE", { host: oldHost, scope: s });
    await postJson("/api/egress/hosts", "POST", { host: next, scope: s });
    await get().refresh();
  },
}));
