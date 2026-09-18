import { create } from "zustand";
import type {
  EgressAllowlistEntry,
  EgressAllowlistView,
  EgressEnforcementStatus,
  EgressHostGrantOutcome,
  EgressSettings,
} from "../../server/shared/types.js";

export type EgressScope = "global" | "session";

interface EgressState {
  loaded: boolean;

  sessionId: string | null;

  entries: EgressAllowlistEntry[];

  globalEnabled: boolean;

  enforcementActive: boolean;

  enforcementStatus: EgressEnforcementStatus;

  globalLoaded: boolean;

  override: boolean | null;

  effectiveContained: boolean;

  defaultsCustomized: boolean;

  applyView: (v: EgressAllowlistView) => void;
  load: (sessionId?: string | null) => Promise<void>;

  loadGlobal: () => Promise<void>;
  refresh: () => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  setOverride: (override: boolean | null) => Promise<void>;

  addHost: (host: string, scope: EgressScope) => Promise<EgressHostGrantOutcome | null>;
  removeHost: (host: string, scope: EgressScope) => Promise<void>;
  editHost: (oldHost: string, newHost: string, scope: EgressScope) => Promise<void>;
  restoreDefaults: () => Promise<void>;
}

function apiScope(scope: EgressScope, sessionId: string | null): string | null {
  if (scope === "global") return "global";
  return sessionId;                                                 
}

async function postJson(url: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return await res.json().catch(() => null);
}

export const useEgressStore = create<EgressState>((set, get) => ({
  loaded: false,
  sessionId: null,
  entries: [],
  globalEnabled: true,

  enforcementActive: true,
  enforcementStatus: "active",
  globalLoaded: false,
  override: null,
  effectiveContained: true,
  defaultsCustomized: false,

  applyView: (v) =>

    // fetch mock in an unrelated test, or a transient server error) must never

    set({
      entries: Array.isArray(v?.entries) ? v.entries : [],
      globalEnabled: v?.globalEnabled ?? true,
      enforcementActive: v?.enforcementActive ?? true,
      enforcementStatus: v?.enforcementStatus ?? (v?.enforcementActive ? "active" : "no-sidecar"),
      globalLoaded: true,
      override: v?.session?.override ?? null,
      effectiveContained: v?.session?.effectiveContained ?? v?.globalEnabled ?? true,
      defaultsCustomized: v?.defaultsCustomized ?? false,
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

  loadGlobal: async () => {
    if (get().globalLoaded) return;
    try {
      const res = await fetch("/api/egress/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const settings = (await res.json()) as EgressSettings;
      set({
        globalEnabled: settings.globalEnabled,
        enforcementActive: settings.enforcementActive,
        enforcementStatus: settings.enforcementStatus
          ?? (settings.enforcementActive ? "active" : "no-sidecar"),
        globalLoaded: true,
      });
    } catch (err) {

      // warning nor claims protection this store cannot see.
      console.error("[egress] failed to read the workspace default:", err);
    }
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

  /**
   * Add a host, and report what it took effect on (planning#376). The route
   * answers with `grant` — which surfaces are live now and which keep the old
   * allowlist until they restart — because the two scopes behave differently
   * and the editor said nothing at all after a successful add.
   */
  addHost: async (host, scope) => {
    const trimmed = host.trim();
    const s = apiScope(scope, get().sessionId);
    if (!trimmed || !s) return null;

    const optimistic: EgressAllowlistEntry = {
      host: trimmed,
      source: scope === "global" ? "user-global" : "user-session",
      removable: true,
    };
    const prev = get().entries;
    if (!prev.some((e) => e.host === trimmed)) set({ entries: [...prev, optimistic] });
    try {
      const body = (await postJson("/api/egress/hosts", "POST", { host: trimmed, scope: s })) as {
        grant?: EgressHostGrantOutcome;
      } | null;
      await get().refresh();
      return body?.grant ?? null;
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

    await postJson("/api/egress/hosts", "DELETE", { host: oldHost, scope: s });
    await postJson("/api/egress/hosts", "POST", { host: next, scope: s });
    await get().refresh();
  },

  restoreDefaults: async () => {
    await postJson("/api/egress/defaults/restore", "POST", {});
    await get().refresh();
  },
}));
