import { create } from "zustand";
import type {
  EgressAllowlistEntry,
  EgressAllowlistView,
  EgressEnforcementStatus,
  EgressHostGrantOutcome,
  EgressSettings,
} from "../../server/shared/types.js";

/**
 * Egress containment settings store (docs/172 / planning#92).
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
 * The `/api/egress/*` routes are NOT `containerAccessible` — planning#131's
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
  /**
   * Whether this deployment can actually ENFORCE containment (enforcement on +
   * sidecar image configured). When containment is the policy but this is false,
   * the panel warns "Contained — NOT enforced on this deployment" instead of a
   * reassuring green state (docs/172, planning#92).
   */
  enforcementActive: boolean;
  /**
   * docs/285 — WHICH deployment this is when enforcement is off, so the warning
   * can name the case and its remediation rather than hedge. See
   * `EgressSettings.enforcementStatus`.
   */
  enforcementStatus: EgressEnforcementStatus;
  /**
   * docs/285 — whether the two GLOBAL fields above have been read from the
   * server, independently of the full allowlist view.
   *
   * Deliberately separate from `loaded`. That flag means "the Settings editor's
   * provenance view is in hand", which is an expensive thing to have and is only
   * ever true while that dialog is open — and Quick Capture needs to name the
   * workspace default without opening it. Folding the two would make the cheap
   * question unanswerable except by paying for the expensive one.
   */
  globalLoaded: boolean;
  /** In-scope session override: null = inherit global, true/false = force. */
  override: boolean | null;
  /** Resolved containment for the in-scope session (override ?? global). */
  effectiveContained: boolean;
  /** True when the user has removed any built-in default (drives "Restore defaults"). */
  defaultsCustomized: boolean;

  applyView: (v: EgressAllowlistView) => void;
  load: (sessionId?: string | null) => Promise<void>;
  /**
   * docs/285 — read just the global switch + enforcement status. Cheap, and
   * idempotent: a second call while the value is already held does nothing, so a
   * surface can ask on every open without a round trip each time.
   */
  loadGlobal: () => Promise<void>;
  refresh: () => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  setOverride: (override: boolean | null) => Promise<void>;
  /** Resolves with what the add took effect on (planning#376), or null if the server said nothing. */
  addHost: (host: string, scope: EgressScope) => Promise<EgressHostGrantOutcome | null>;
  removeHost: (host: string, scope: EgressScope) => Promise<void>;
  editHost: (oldHost: string, newHost: string, scope: EgressScope) => Promise<void>;
  restoreDefaults: () => Promise<void>;
}

/** Resolve a UI scope to the API scope string (a session id for "session"). */
function apiScope(scope: EgressScope, sessionId: string | null): string | null {
  if (scope === "global") return "global";
  return sessionId; // null when no session in scope → caller no-ops
}

async function postJson(url: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Every one of these routes answers with JSON; a body that isn't parseable is
  // not worth failing a successful write over (only `addHost` reads one).
  return await res.json().catch(() => null);
}

export const useEgressStore = create<EgressState>((set, get) => ({
  loaded: false,
  sessionId: null,
  entries: [],
  globalEnabled: true,
  // Optimistic: assume enforcement is active until the server view loads, so a
  // capable deployment doesn't briefly flash the "not enforced" warning.
  enforcementActive: true,
  enforcementStatus: "active",
  globalLoaded: false,
  override: null,
  effectiveContained: true,
  defaultsCustomized: false,

  applyView: (v) =>
    // Coerce defensively: a non-egress / malformed response (e.g. a stray global
    // fetch mock in an unrelated test, or a transient server error) must never
    // poison `entries` to `undefined` — the editor renders `entries.filter(...)`.
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
      // Leave the optimistic defaults. A surface that shows the workspace
      // default is describing a setting, not gating on one, so guessing
      // "Contained and enforced" is the right failure: it neither invents a
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
    // Optimistic: show the row immediately (source matches the scope).
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
    // Replace = remove old + add new at the same scope, then reconcile once.
    await postJson("/api/egress/hosts", "DELETE", { host: oldHost, scope: s });
    await postJson("/api/egress/hosts", "POST", { host: next, scope: s });
    await get().refresh();
  },

  restoreDefaults: async () => {
    await postJson("/api/egress/defaults/restore", "POST", {});
    await get().refresh();
  },
}));
