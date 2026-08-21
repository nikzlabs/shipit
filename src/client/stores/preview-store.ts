import { create } from "zustand";
import { getLocalStorageObject } from "../utils/local-storage.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { DevicePreset } from "../components/device-presets.js";
import type {
  ComposeServiceStatus,
  ComposeServicePreviewMode,
  ComposeServiceOriginView,
} from "../../server/shared/types/ws-server-messages.js";
import type { SecretRequirement } from "../../server/shared/types/domain-types.js";
import type { PluginCredentialGroup } from "../../server/shared/plugin-credentials.js";

// ---- Compose service state ----

export interface ManagedServiceState {
  name: string;
  status: ComposeServiceStatus;
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;
  /**
   * docs/262 req 3 — the plugin a service came from, absent for the project's
   * own. Services are otherwise first-class and indistinguishable, which is the
   * requirement; this is the one thing that says where one came from, and the
   * server sends it on both the live and the replayed message.
   */
  origin?: ComposeServiceOriginView;
}

// ---- Agent-authored preview links (docs/258) ----

/**
 * A destination a `shipit-preview://` pointer asked for, held until the panel
 * can actually go there (req 2, req 12).
 *
 * **Deliberately not `previewPaths`.** That map means *"the last path this page
 * reported about itself"* and a live page writes to it at any time through the
 * injected `path` message (`PreviewFrame.tsx`). A document still on screen
 * during a pending start or navigation would therefore overwrite the
 * destination before it was ever used: the queued destination and the observed
 * location are two different facts and must not share a slot.
 */
export interface PreviewLinkIntent {
  /** The session the click happened in. An intent means nothing in another one. */
  sessionId: string;
  /** The Compose service the pointer named, matched exactly against `services`. */
  service: string;
  /** The service's declared port — known even while it is stopped. */
  port: number;
  /** `sessionId:port`, the iframe-pool slot this destination belongs to. */
  slotKey: string;
  /** Absolute path with query and fragment. The page's reaction *is* this URL (req 11). */
  targetPath: string;
  /** Fresh per click, and **last click wins** — an incomplete earlier intent is dropped, never queued. */
  clickId: number;
  /** `Date.now()` at the click, so an intent that never resolves cannot fire much later. */
  startedAt: number;
}

/**
 * How long an unfulfilled intent stays live. Not a failure detector (req 10 is
 * best effort): it stops an intent for a service that never starts from firing
 * minutes later, when the user has since selected that port by hand and would be
 * yanked to a destination they no longer remember asking for.
 */
export const PREVIEW_LINK_INTENT_TTL_MS = 120_000;

// ---- Secrets state (087-reusable-preview-secrets, Phase 2) ----

/**
 * A declared secret aggregated across every claimant that referenced it:
 * compose services, and — docs/262 req 23 — activated plugins, by alias. A
 * name claimed by both is one row, because it is one stored secret.
 */
export type DeclaredSecretState = SecretRequirement & { services: string[]; plugins?: string[] };

/**
 * Snapshot of declared secrets for the current session — driven by the
 * `secrets_status` WS message. The Settings panel uses `declared` to render
 * descriptions / required indicators / consumer chips. The preview panel
 * uses `missingRequired` to show a "Configure secrets" banner.
 */
export interface SecretsState {
  declared: DeclaredSecretState[];
  missingByService: Record<string, string[]>;
  missingRequired: string[];
  /**
   * docs/262 req 23 — plugin-declared credentials, grouped per activated
   * plugin. Optional so a client restored from an older snapshot (or a
   * pre-plugin server) reads as "no plugin needs" rather than crashing.
   */
  plugins?: PluginCredentialGroup[];
}

const emptySecretsState: SecretsState = {
  declared: [],
  missingByService: {},
  missingRequired: [],
  plugins: [],
};

export interface StartupStep {
  stepId: "fetch" | "install" | "dev_server";
  status: "pending" | "running" | "complete" | "error";
  durationMs?: number;
  message?: string;
  logLines: string[];
}

export interface PreviewError {
  id: string;
  type: "error" | "console";
  level?: "error" | "warn";
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  timestamp: string;
}

/** Maximum number of errors to keep in the rolling buffer. */
const MAX_ERRORS = 50;

/**
 * Cap on how many trailing log lines we retain per startup step. The overlay
 * only renders ~5 lines (`max-h-[5lh]` in `StartupSteps.tsx`); 50 is enough
 * to give us a comfortable buffer for the rendered tail without unbounded
 * growth on chatty installs (npm install can emit thousands of log lines).
 */
const MAX_STARTUP_STEP_LOG_LINES = 50;

/** Time window in ms for deduplication — same error within this window is dropped. */
const DEDUP_WINDOW_MS = 1000;

/** Per-session state that gets snapshotted on session switch. */
export interface SessionPreviewSnapshot {
  status: PreviewStatus | null;
  selectedPort: number | null;
  errors: PreviewError[];
  autoFixRetries: number;
  startupSteps: StartupStep[];
  services: ManagedServiceState[];
  composeError: string | null;
  composeNotConfigured: boolean;
  secrets: SecretsState;
  devicePreset: DevicePreset | null;
  isLandscape: boolean;
  customSize: { width: number; height: number } | null;
}

interface PreviewState {
  status: PreviewStatus | null;
  selectedPort: number | null;
  errors: PreviewError[];
  autoFixEnabled: boolean;
  autoFixRetries: number;
  startupSteps: StartupStep[];

  /** Compose services for the current session (keyed by service name). */
  services: ManagedServiceState[];
  /** Error message when Docker Compose stack fails to start. */
  composeError: string | null;
  /**
   * Most recent preview-proxy error for an in-flight preview, by port. The
   * orchestrator emits `preview_error` when the proxy can't reach the
   * container or HMR upgrade fails — we render an inline overlay so the
   * user sees something more actionable than a blank iframe.
   *
   * See docs/124-session-rescue-and-diagnostics §1.5.
   */
  previewProxyError: { port: number; message: string; upgrade?: boolean; at: number } | null;
  /** True when no compose file is configured in shipit.yaml. */
  composeNotConfigured: boolean;
  /**
   * Declared secrets + missing-required snapshot (from `secrets_status` WS
   * message). Drives the secrets banner in the preview panel and the
   * declared-secrets section in the Settings → Secrets tab.
   */
  secrets: SecretsState;

  /** Active device preset for viewport sizing. null = "Responsive" (fill panel). */
  devicePreset: DevicePreset | null;
  /** True when the active preset is rotated to landscape (swap width/height). */
  isLandscape: boolean;
  /** Custom user-entered viewport size (separate from named presets). */
  customSize: { width: number; height: number } | null;

  /** Saved preview state per session, keyed by sessionId. */
  sessionSnapshots: Record<string, SessionPreviewSnapshot>;

  /**
   * Last path each preview was on, keyed by iframe-pool slot (`sessionId:port`).
   * Reported by the injected preview script (`preview-proxy.ts`) on load and on
   * every history change, so it tracks client-side routing too.
   *
   * Deliberately global and NOT part of `SessionPreviewSnapshot`: the key
   * already carries the session, and the whole point is to outlive everything
   * that can drop an iframe — a session switch, a `PreviewFrame` unmount, LRU
   * eviction past `MAX_IFRAME_SLOTS`, a container restart, a page reload
   * (hence the localStorage mirror). A recreated slot re-enters at this path
   * instead of the app's front page.
   */
  previewPaths: Record<string, string>;

  /**
   * The destination a `shipit-preview://` pointer is waiting to reach, or `null`
   * (docs/258). At most one: last click wins. See {@link PreviewLinkIntent}.
   */
  previewLinkIntent: PreviewLinkIntent | null;

  /**
   * Whether the Services drawer at the bottom of the Preview tab is expanded
   * (docs/175). A global UI preference (not per-session), persisted to
   * localStorage. Lifted into the store so the PreviewFrame's "View logs"
   * overlay button can open the drawer that's rendered as its sibling.
   */
  servicesDrawerExpanded: boolean;

  /**
   * True when the user collapsed the drawer *during the current no-preview
   * episode*. Ephemeral (never persisted, cleared as soon as a preview runs):
   * it only suppresses the auto-open below, and the saved preference above
   * keeps its own meaning — "how I like the drawer while a preview is up".
   */
  servicesDrawerIdleCollapsed: boolean;

  setStatus: (status: PreviewStatus | null) => void;
  setSelectedPort: (port: number | null) => void;
  setServicesDrawerExpanded: (expanded: boolean) => void;
  setServicesDrawerIdleCollapsed: (collapsed: boolean) => void;
  addError: (error: PreviewError) => void;
  clearErrors: () => void;
  setAutoFixEnabled: (enabled: boolean) => void;
  setAutoFixRetries: (retries: number) => void;
  disableAutoFix: () => void;
  toggleAutoFix: () => void;
  initStartupSteps: () => void;
  setStartupStep: (update: Partial<StartupStep> & { stepId: string }) => void;
  /**
   * Append a log line (or text chunk that may contain newlines) to the
   * specified startup step, retaining only the trailing
   * {@link MAX_STARTUP_STEP_LOG_LINES} so the in-overlay tail stays bounded.
   * No-op when the step doesn't exist (e.g. startup steps were cleared).
   */
  appendStartupStepLog: (stepId: StartupStep["stepId"], text: string) => void;
  clearStartupSteps: () => void;
  /** Replace the full service list (from service_list WS message). */
  setServices: (services: ManagedServiceState[]) => void;
  /** Update a single service status (from service_status WS message). */
  updateService: (update: ManagedServiceState) => void;
  setComposeError: (error: string | null) => void;
  setComposeNotConfigured: (value: boolean) => void;
  setPreviewProxyError: (error: PreviewState["previewProxyError"]) => void;
  /** Replace the secrets snapshot (from `secrets_status` WS message). */
  setSecrets: (secrets: SecretsState) => void;
  /** Set the active device preset (or null to return to "Responsive"). */
  setDevicePreset: (preset: DevicePreset | null) => void;
  /** Swap width and height on the active preset. */
  toggleLandscape: () => void;
  /** Set a custom viewport size; selecting null clears it. */
  setCustomSize: (size: { width: number; height: number } | null) => void;
  /** Save current top-level state into sessionSnapshots[sessionId]. */
  snapshotSession: (sessionId: string) => void;
  /** Restore from snapshot if exists, otherwise reset to defaults. */
  restoreSession: (sessionId: string) => void;
  /** Read-only access to a session's snapshot. */
  getSnapshot: (sessionId: string) => SessionPreviewSnapshot | undefined;
  /**
   * Remember where an iframe-pool slot currently is. `path` is untrusted (the
   * previewed page authors it) and is sanitized here; an unusable value is
   * dropped rather than stored.
   */
  setPreviewPath: (slotKey: string, path: unknown) => void;
  /** Forget every remembered path. Full reset only — see `reset`. */
  clearPreviewPaths: () => void;
  /** Record where an agent-authored pointer wants the preview to go (docs/258). */
  setPreviewLinkIntent: (intent: PreviewLinkIntent) => void;
  /**
   * Drop the intent. With a `clickId`, only when it still owns the intent — so a
   * late resolution of a superseded click can't cancel the current one.
   */
  clearPreviewLinkIntent: (clickId?: number) => void;
  reset: () => void;
}

/**
 * Dedup state lives outside Zustand to avoid triggering renders on every
 * dedup-map mutation. Only the actual errors array is reactive.
 */
let idCounter = 0;
const recentKeys = new Map<string, number>();

/** Build a dedup key from an error's core fields. */
function dedupKey(type: string, message: string, source?: string, line?: number): string {
  return `${type}:${message}:${source ?? ""}:${line ?? ""}`;
}

/**
 * Check dedup and return true if the error should be suppressed.
 * Mutates the recentKeys map as a side-effect.
 */
function isDuplicate(key: string): boolean {
  const now = Date.now();
  const lastSeen = recentKeys.get(key);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  recentKeys.set(key, now);
  return false;
}

export function nextErrorId(): string {
  return `pe-${++idCounter}`;
}

export function checkDuplicate(type: string, message: string, source?: string, line?: number): boolean {
  return isDuplicate(dedupKey(type, message, source, line));
}

export function resetDedupState(): void {
  recentKeys.clear();
  idCounter = 0;
}

const initialSessionState: SessionPreviewSnapshot = {
  status: null,
  selectedPort: null,
  errors: [],
  autoFixRetries: 0,
  startupSteps: [],
  services: [],
  composeError: null,
  composeNotConfigured: false,
  secrets: emptySecretsState,
  devicePreset: null,
  isLandscape: false,
  customSize: null,
};

const SERVICES_DRAWER_EXPANDED_KEY = "shipit:preview-services:expanded";

function loadServicesDrawerExpanded(): boolean {
  try { return localStorage.getItem(SERVICES_DRAWER_EXPANDED_KEY) === "1"; } catch { return false; }
}

/**
 * Whether the Services drawer is open right now.
 *
 * While a preview runs, the saved preference decides. While none runs, the
 * drawer is the only place to start one — so it opens itself whatever the
 * preference says, because making the user press a "Show services" button first
 * is a step with no decision in it — which is why that button no longer exists.
 * A hand collapse still wins, and holds until a preview starts
 * (`servicesDrawerIdleCollapsed`); the drawer's own caret undoes it.
 */
export function isServicesDrawerOpen(opts: {
  previewRunning: boolean;
  expanded: boolean;
  idleCollapsed: boolean;
}): boolean {
  return opts.expanded || (!opts.previewRunning && !opts.idleCollapsed);
}

const PREVIEW_PATHS_KEY = "shipit:preview-paths";

/**
 * Cap on how many slot→path entries we remember. Keys are `sessionId:port`,
 * so this bounds growth across a long-lived session list. Eviction is by
 * insertion order (oldest first) — plain-object key order is insertion order
 * for these non-numeric keys.
 */
const MAX_REMEMBERED_PATHS = 100;

/**
 * Cap on a remembered preview path. The value is authored by the previewed
 * page, so it is untrusted input — a pathological one must not reach React,
 * the clipboard, or an iframe `src`. Long enough that no real route is clipped.
 */
const MAX_PATH_LENGTH = 2048;

/**
 * Narrow an untrusted `path` postMessage payload to something we can safely
 * hand back to an iframe `src` and render in the toolbar, or `null` if we
 * can't. Requires a same-document absolute path, because the value is resolved
 * against the preview's origin and anything that can escape that origin puts a
 * foreign host in the tooltip, on the clipboard, and in the URL we restore the
 * preview to.
 *
 * "Absolute path" has to be read the way the URL parser does, not the way it
 * looks. For a special scheme (http/https) WHATWG parsing treats `\` as `/` and
 * strips tab/CR/LF anywhere in the input — so `/\evil.example/x` and
 * `/<tab>/evil.example/x` both resolve to `https://evil.example/x` despite
 * passing a naive "starts with a single slash" test. Reject those characters
 * outright rather than trying to predict the parser.
 */
export function sanitizePreviewPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\\\t\n\r]/.test(raw)) return null;
  return raw.slice(0, MAX_PATH_LENGTH);
}

function loadPreviewPaths(): Record<string, string> {
  return getLocalStorageObject<Record<string, string>>(PREVIEW_PATHS_KEY, {}, (parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    // Trailing entries are the most recent (writes re-insert at the end), so an
    // oversized blob — a tampered one, or one written before the cap existed —
    // is truncated from the front rather than loaded whole.
    const entries = Object.entries(parsed as Record<string, unknown>).slice(-MAX_REMEMBERED_PATHS);
    for (const [key, value] of entries) {
      const path = sanitizePreviewPath(value);
      if (path) out[key] = path;
    }
    return out;
  });
}

function savePreviewPaths(paths: Record<string, string>): void {
  try { localStorage.setItem(PREVIEW_PATHS_KEY, JSON.stringify(paths)); } catch { /* ignore */ }
}

const initialState = {
  ...initialSessionState,
  autoFixEnabled: false,
  servicesDrawerExpanded: loadServicesDrawerExpanded(),
  sessionSnapshots: {} as Record<string, SessionPreviewSnapshot>,
  previewPaths: loadPreviewPaths(),
  // Ephemeral state — never persisted into a session snapshot.
  servicesDrawerIdleCollapsed: false,
  previewProxyError: null as PreviewState["previewProxyError"],
  previewLinkIntent: null as PreviewLinkIntent | null,
};

export const usePreviewStore = create<PreviewState>((set, get) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setSelectedPort: (port) => set({ selectedPort: port }),

  setServicesDrawerExpanded: (servicesDrawerExpanded) => {
    try { localStorage.setItem(SERVICES_DRAWER_EXPANDED_KEY, servicesDrawerExpanded ? "1" : "0"); } catch { /* ignore */ }
    set({ servicesDrawerExpanded });
  },

  setServicesDrawerIdleCollapsed: (servicesDrawerIdleCollapsed) => set({ servicesDrawerIdleCollapsed }),

  addError: (error) =>
    set((state) => {
      const next = [...state.errors, error];
      return { errors: next.length > MAX_ERRORS ? next.slice(-MAX_ERRORS) : next };
    }),

  clearErrors: () => {
    resetDedupState();
    set({ errors: [] });
  },

  setAutoFixEnabled: (autoFixEnabled) => set({ autoFixEnabled }),

  setAutoFixRetries: (autoFixRetries) => set({ autoFixRetries }),

  disableAutoFix: () => set({ autoFixEnabled: false, autoFixRetries: 0 }),

  toggleAutoFix: () =>
    set((state) => ({ autoFixEnabled: !state.autoFixEnabled, ...(!state.autoFixEnabled ? {} : { autoFixRetries: 0 }) })),

  initStartupSteps: () =>
    set({
      startupSteps: [
        { stepId: "fetch", status: "running", logLines: [] },
        { stepId: "install", status: "pending", logLines: [] },
        { stepId: "dev_server", status: "pending", logLines: [] },
      ],
    }),

  setStartupStep: (update) =>
    set((state) => ({
      startupSteps: state.startupSteps.map((s) =>
        s.stepId === update.stepId ? { ...s, ...update, logLines: update.logLines ?? s.logLines } : s,
      ),
    })),

  appendStartupStepLog: (stepId, text) =>
    set((state) => {
      const idx = state.startupSteps.findIndex((s) => s.stepId === stepId);
      if (idx < 0) return state;
      // Split incoming chunk on \n and drop empty trailing lines that result
      // from a chunk that happens to end with a newline. Keep blank
      // intermediate lines (npm install renders progress with them).
      const incoming = text.replace(/\n+$/, "").split("\n");
      if (incoming.length === 0) return state;
      const step = state.startupSteps[idx];
      const merged = [...step.logLines, ...incoming];
      const trimmed = merged.length > MAX_STARTUP_STEP_LOG_LINES
        ? merged.slice(merged.length - MAX_STARTUP_STEP_LOG_LINES)
        : merged;
      const next = state.startupSteps.slice();
      next[idx] = { ...step, logLines: trimmed };
      return { startupSteps: next };
    }),

  clearStartupSteps: () => set({ startupSteps: [] }),

  setComposeError: (composeError) => set({ composeError }),

  setComposeNotConfigured: (composeNotConfigured) => set({ composeNotConfigured }),

  setPreviewProxyError: (previewProxyError) => set({ previewProxyError }),

  setDevicePreset: (devicePreset) =>
    set({ devicePreset, customSize: devicePreset?.category === "custom" ? get().customSize : null }),

  toggleLandscape: () => set((state) => ({ isLandscape: !state.isLandscape })),

  setCustomSize: (customSize) =>
    // A typed W×H is an exact request — carrying over a previous preset's
    // landscape rotation would silently transpose it (measured live: typing
    // 500×400 after rotating iPhone SE produced a 400×500 surface). Named
    // presets keep rotation across switches; freeform entry starts upright.
    set({ customSize, isLandscape: false }),

  setServices: (services) => set({ services, composeError: null, composeNotConfigured: false }),

  setSecrets: (secrets) => set({ secrets }),

  updateService: (update) =>
    set((state) => {
      const existing = state.services.find(s => s.name === update.name);
      if (existing) {
        return {
          services: state.services.map(s =>
            s.name === update.name ? { ...s, ...update } : s,
          ),
        };
      }
      return { services: [...state.services, update] };
    }),

  snapshotSession: (sessionId) =>
    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
        [sessionId]: {
          status: state.status,
          selectedPort: state.selectedPort,
          errors: state.errors,
          autoFixRetries: state.autoFixRetries,
          startupSteps: state.startupSteps,
          services: state.services,
          composeError: state.composeError,
          composeNotConfigured: state.composeNotConfigured,
          secrets: state.secrets,
          devicePreset: state.devicePreset,
          isLandscape: state.isLandscape,
          customSize: state.customSize,
        },
      },
    })),

  restoreSession: (sessionId) => {
    const snap = get().sessionSnapshots[sessionId];
    // A pointer's destination describes one session and is cancelled by leaving
    // it (docs/258) — it is never part of the restored snapshot.
    if (snap) {
      set({ ...snap, previewLinkIntent: null });
    } else {
      resetDedupState();
      set({ ...initialSessionState, previewLinkIntent: null });
    }
  },

  getSnapshot: (sessionId): SessionPreviewSnapshot | undefined => get().sessionSnapshots[sessionId],

  setPreviewPath: (slotKey, path) => {
    const value = sanitizePreviewPath(path);
    if (!value) return;
    set((state) => {
      if (state.previewPaths[slotKey] === value) return state;
      // Re-insert at the end so the entry counts as most-recently-used: the
      // cap below evicts from the front, and a slot the user keeps navigating
      // must not age out while an untouched one survives.
      const { [slotKey]: _dropped, ...rest } = state.previewPaths;
      const entries = Object.entries(rest);
      const kept = entries.length >= MAX_REMEMBERED_PATHS
        ? entries.slice(entries.length - MAX_REMEMBERED_PATHS + 1)
        : entries;
      const previewPaths = { ...Object.fromEntries(kept), [slotKey]: value };
      savePreviewPaths(previewPaths);
      return { previewPaths };
    });
  },

  reset: () => {
    resetDedupState();
    set((state) => ({
      ...initialState,
      sessionSnapshots: {},
      // NOT cleared. `reset()` is the session-scoped reset — `resetSessionState`
      // calls it when the route leaves a session for home or `/{slug}/new`, and
      // on desktop that is also the moment `AppLayout` unmounts the right panel
      // and with it the whole iframe pool. Wiping the remembered paths there
      // would erase them at precisely the moment they have to be read back,
      // which is the one job this map has. Clearing belongs to
      // `clearPreviewPaths`, called only from the full reset.
      previewPaths: state.previewPaths,
    }));
  },

  clearPreviewPaths: () => {
    savePreviewPaths({});
    set({ previewPaths: {} });
  },

  setPreviewLinkIntent: (previewLinkIntent) => set({ previewLinkIntent }),

  clearPreviewLinkIntent: (clickId) =>
    set((state) => (
      clickId === undefined || state.previewLinkIntent?.clickId === clickId
        ? { previewLinkIntent: null }
        : state
    )),
}));

// Re-export DevicePreset type for convenience so consumers don't need to know the source.
export type { DevicePreset } from "../components/device-presets.js";
