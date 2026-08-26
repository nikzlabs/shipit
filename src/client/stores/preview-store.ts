import { create } from "zustand";
import { getLocalStorageObject } from "../utils/local-storage.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import { customPreset, type DevicePreset } from "../components/device-presets.js";
import { useSessionStore } from "./session-store.js";
import {
  loadViewportMemory,
  saveViewportMemory,
  viewportEntryFromState,
  viewportStateFromEntry,
  withViewportEntry,
  type PersistedViewport,
} from "./viewport-memory.js";
import {
  loadPreviewTargetMemory,
  savePreviewTargetMemory,
  withPreviewTargetEntry,
  type PersistedPreviewTarget,
} from "./preview-target-memory.js";
import type {
  ComposeServiceStatus,
  ComposeServicePreviewMode,
  ComposeServiceOriginView,
} from "../../server/shared/types/ws-server-messages.js";
import { deriveEffectivePreviewStatus } from "../utils/preview-status.js";
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

/**
 * Per-session state that gets snapshotted on session switch.
 *
 * The device-viewport choice is deliberately NOT here (docs/278): it lives in
 * `viewportMemory`, written through on every mutation and localStorage-backed,
 * so it survives a page reload — which this in-memory snapshot cannot. The
 * same now goes for which preview the pane is on (`previewTargetMemory`,
 * planning#478): a snapshotted `selectedPort` is a port, and a port can change
 * hands or stop existing while a session sits off screen, so it was never a
 * safe thing to restore. The rest of the snapshot is transport state the server
 * re-sends anyway.
 */
export interface SessionPreviewSnapshot {
  status: PreviewStatus | null;
  errors: PreviewError[];
  autoFixRetries: number;
  startupSteps: StartupStep[];
  services: ManagedServiceState[];
  composeError: string | null;
  composeNotConfigured: boolean;
  secrets: SecretsState;
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
  /** Custom viewport size, always stored as rendered (docs/278). */
  customSize: { width: number; height: number } | null;

  /**
   * Remembered viewport choice per session (docs/278 req 6). The single source
   * of truth for restoring the viewport: hydrated from localStorage at load,
   * written through (against the *current* session) by every viewport setter,
   * and read back by `restoreSession` — on switches and on cold loads alike.
   * Like `previewPaths`, it deliberately outlives the session-scoped `reset()`.
   */
  viewportMemory: Record<string, PersistedViewport>;

  /**
   * Which preview each session is on, by Compose service name (planning#478).
   * localStorage-backed like `viewportMemory`, and the single source of truth
   * for `selectedPort`, which is derived from it. Written on an explicit
   * selection AND pinned to whatever the pane first shows, so nothing but a
   * user action can move the pane to a different service. Like `previewPaths`,
   * it outlives the session-scoped `reset()`.
   */
  previewTargetMemory: Record<string, PersistedPreviewTarget>;

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
  /**
   * Record an explicit choice of which preview to look at (planning#478). The
   * owning service is resolved from `services` and remembered for the session,
   * so the choice survives the service restarting, the session being switched
   * away from, and a page reload. `null` forgets the choice, returning the
   * session to "whatever the pane shows next" — which is then pinned in turn.
   */
  setSelectedPort: (port: number | null) => void;
  /**
   * Re-derive `selectedPort` from the session's remembered target. Called by
   * every action that can change the answer (`setStatus`, `setServices`,
   * `updateService`, `restoreSession`); exposed for tests and for any future
   * call site that mutates services outside those.
   */
  reconcilePreviewTarget: (forSessionId?: string) => void;
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
  /**
   * Swap the rendered width and height. On a named preset this flips
   * `isLandscape`; on a custom size it swaps the stored dims instead, so a
   * custom size is always stored as rendered (docs/278).
   */
  toggleLandscape: () => void;
  /**
   * Activate a freeform/custom viewport at `width`×`height` — one atomic set of
   * synthetic preset + `customSize` + `isLandscape: false`. Atomic because the
   * drag handles call this per pointermove; chained setters would render (and
   * persist) partial states.
   */
  setFreeformSize: (width: number, height: number) => void;
  /** Forget every remembered viewport. Full reset only — see `reset`. */
  clearViewportMemory: () => void;
  /** Forget every remembered preview target. Full reset only — see `reset`. */
  clearPreviewTargetMemory: () => void;
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

// ---- Viewport write-through (docs/278) ----

/**
 * Debounce for flushing `viewportMemory` to localStorage. A drag emits ~60
 * viewport mutations per second; the state map is updated synchronously in the
 * same `set()` (so it is always correct at mutation time, whatever session the
 * flush later fires under) and only the serialization is deferred.
 */
export const VIEWPORT_FLUSH_DEBOUNCE_MS = 300;

let viewportFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Flush the pending write, if any. A no-op when nothing is unsaved, so the
 * page-hide listeners below don't serialize on every tab switch. */
function flushViewportMemoryNow(): void {
  if (!viewportFlushTimer) return;
  clearTimeout(viewportFlushTimer);
  viewportFlushTimer = null;
  saveViewportMemory(usePreviewStore.getState().viewportMemory);
}

function scheduleViewportFlush(): void {
  if (viewportFlushTimer) clearTimeout(viewportFlushTimer);
  viewportFlushTimer = setTimeout(flushViewportMemoryNow, VIEWPORT_FLUSH_DEBOUNCE_MS);
}

/**
 * The `viewportMemory` update for the viewport fields about to be set, keyed by
 * the session the user is making the choice in — read from the session store at
 * mutation time, which is what keeps a debounced flush from ever attributing a
 * choice to whatever session is on screen when the timer fires. No session
 * (home screen) means nothing to remember.
 */
function viewportMemoryUpdate(
  current: Record<string, PersistedViewport>,
  viewport: {
    devicePreset: DevicePreset | null;
    isLandscape: boolean;
    customSize: { width: number; height: number } | null;
  },
): { viewportMemory: Record<string, PersistedViewport> } | Record<string, never> {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) return {};
  return { viewportMemory: withViewportEntry(current, sessionId, viewportEntryFromState(viewport)) };
}

// ---- Which preview the pane is on (planning#478) ----

/** Every port the current `status` says is previewable, in the server's order. */
function availablePreviewPorts(status: PreviewStatus | null): number[] {
  if (!status?.running) return [];
  const ports = [...(status.detectedPorts ?? [])];
  if ((status.source === "vite" || status.source === "managed") && !ports.includes(status.port)) {
    ports.push(status.port);
  }
  return ports;
}

/** The subset of store state {@link resolvePreviewTarget} reads. */
interface PreviewTargetInputs {
  previewTargetMemory: Record<string, PersistedPreviewTarget>;
  services: ManagedServiceState[];
  status: PreviewStatus | null;
}

/**
 * Decide which preview the pane is on, and what to remember about it.
 *
 * The pane must never change service on its own (planning#478). Two things used
 * to make it do exactly that, and both are the same defect — the pane's identity
 * was a *port*, derived fresh from whatever was running:
 *
 * - `selectedPort` was cleared whenever the chosen port was not among the
 *   running ones, so a session switch that found the container reclaimed (or
 *   the service merely restarting) forgot the choice permanently.
 * - With no choice recorded, the pane followed `status.port` — the server's
 *   *first running* preview service. A second service starting, or the first
 *   one restarting, silently moved the pane to a different app.
 *
 * So the session's target is remembered **by service name**, and it is recorded
 * for whatever the pane is showing — a pin the user never had to make. A
 * remembered service that is not running right now keeps the pane: a declared
 * service keeps its port while stopped, so the pane holds that port and waits
 * for the service to come back rather than showing a different app.
 *
 * `write`: `undefined` leaves the memory alone, `null` deletes the entry, an
 * object replaces it.
 */
function resolvePreviewTarget(
  state: PreviewTargetInputs,
  sessionId: string | undefined,
): { selectedPort: number | null; write?: PersistedPreviewTarget | null } {
  // The SAME status the pane renders from, synthetic fallback included: the
  // pane pins what it is showing, and `preview_status` can lag `service_status`
  // by long enough for the two to disagree about which port that is.
  const status = deriveEffectivePreviewStatus(state.status, state.services, sessionId);
  let entry = sessionId ? state.previewTargetMemory[sessionId] : undefined;

  // A remembered service that an authoritative list no longer declares is dead
  // memory — the compose file renamed or dropped it. Forget it and pin afresh,
  // rather than falling back forever to a name that will never come back. An
  // empty list is not authoritative: it is also what the store holds in the
  // moment before `service_list` arrives.
  const forget =
    !!entry?.service &&
    state.services.length > 0 &&
    !state.services.some((s) => s.name === entry?.service);
  if (forget) entry = undefined;

  if (entry?.service) {
    const svc = state.services.find((s) => s.name === entry?.service);
    // The port is held whatever the service's status is — a declared service
    // keeps its port while stopped, so the pane can WAIT for it. Handing the
    // user a different app for the duration is the replacement this exists to
    // stop; `PreviewFrame` renders a waiting state over the dormant slot
    // instead. A service with no port at all (a worker) has nothing to show, so
    // that alone falls back.
    return { selectedPort: svc?.port ?? null };
  }
  if (entry) {
    // Port-only memory: a preview no Compose service owns (Vite / `managed`).
    const ports = availablePreviewPorts(status);
    return { selectedPort: ports.includes(entry.port) ? entry.port : null };
  }

  // Nothing remembered — pin what the pane is showing right now.
  if (!sessionId || !status?.running || !status.port) {
    return { selectedPort: null, write: forget ? null : undefined };
  }
  const svc = state.services.find((s) => s.port === status.port);
  if (!svc && status.source === "detected") {
    // Every `detected` port comes from a Compose service, so no row for it
    // means `service_list` has not landed yet. Pinning by port here would
    // record the weaker handle for something that HAS a name — wait for the
    // list, which reconciles again the moment it arrives.
    return { selectedPort: null, write: forget ? null : undefined };
  }
  return {
    selectedPort: status.port,
    write: svc ? { service: svc.name, port: status.port } : { port: status.port },
  };
}

const initialSessionState: SessionPreviewSnapshot = {
  status: null,
  errors: [],
  autoFixRetries: 0,
  startupSteps: [],
  services: [],
  composeError: null,
  composeNotConfigured: false,
  secrets: emptySecretsState,
};

/** Live viewport fields at their defaults — the "Responsive" state. */
const initialViewportState = {
  devicePreset: null as DevicePreset | null,
  isLandscape: false,
  customSize: null as { width: number; height: number } | null,
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
  ...initialViewportState,
  autoFixEnabled: false,
  servicesDrawerExpanded: loadServicesDrawerExpanded(),
  sessionSnapshots: {} as Record<string, SessionPreviewSnapshot>,
  previewPaths: loadPreviewPaths(),
  viewportMemory: loadViewportMemory(),
  previewTargetMemory: loadPreviewTargetMemory(),
  // Ephemeral state — never persisted into a session snapshot.
  // `selectedPort` is derived, not owned: `reconcilePreviewTarget` recomputes it
  // from `previewTargetMemory` whenever the status or the service list moves.
  selectedPort: null as number | null,
  servicesDrawerIdleCollapsed: false,
  previewProxyError: null as PreviewState["previewProxyError"],
  previewLinkIntent: null as PreviewLinkIntent | null,
};

export const usePreviewStore = create<PreviewState>((set, get) => ({
  ...initialState,

  setStatus: (status) => {
    set({ status });
    get().reconcilePreviewTarget();
  },

  setSelectedPort: (port) => {
    const sessionId = useSessionStore.getState().sessionId;
    if (sessionId) {
      const svc = port === null ? undefined : get().services.find((s) => s.port === port);
      const entry = port === null ? null : svc ? { service: svc.name, port } : { port };
      const previewTargetMemory = withPreviewTargetEntry(get().previewTargetMemory, sessionId, entry);
      savePreviewTargetMemory(previewTargetMemory);
      set({ previewTargetMemory, selectedPort: port });
    } else {
      set({ selectedPort: port });
    }
    // A cleared choice re-pins to whatever the pane shows now; an explicit one
    // already agrees with the memory just written, so this would be a no-op.
    if (port === null) get().reconcilePreviewTarget();
  },

  reconcilePreviewTarget: (forSessionId) => {
    // The argument exists for `restoreSession`, which knows the incoming
    // session id first-hand; everywhere else the store is the authority.
    const sessionId = forSessionId ?? useSessionStore.getState().sessionId;
    const state = get();
    const { selectedPort, write } = resolvePreviewTarget(state, sessionId);
    const changed = selectedPort !== state.selectedPort;
    if (write !== undefined && sessionId) {
      const previewTargetMemory = withPreviewTargetEntry(state.previewTargetMemory, sessionId, write);
      savePreviewTargetMemory(previewTargetMemory);
      set(changed ? { previewTargetMemory, selectedPort } : { previewTargetMemory });
    } else if (changed) {
      set({ selectedPort });
    }
  },

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

  setDevicePreset: (devicePreset) => {
    set((state) => {
      const viewport = {
        devicePreset,
        isLandscape: state.isLandscape,
        customSize: devicePreset?.category === "custom" ? state.customSize : null,
      };
      return { ...viewport, ...viewportMemoryUpdate(state.viewportMemory, viewport) };
    });
    scheduleViewportFlush();
  },

  toggleLandscape: () => {
    set((state) => {
      if (state.devicePreset?.category === "custom") {
        // Custom sizes are stored as rendered (docs/278): swap the stored dims
        // instead of flipping a flag the label and persistence would then have
        // to reconcile against.
        const current = state.customSize ?? {
          width: state.devicePreset.width,
          height: state.devicePreset.height,
        };
        const viewport = {
          devicePreset: customPreset(current.height, current.width),
          isLandscape: false,
          customSize: { width: current.height, height: current.width },
        };
        return { ...viewport, ...viewportMemoryUpdate(state.viewportMemory, viewport) };
      }
      const viewport = {
        devicePreset: state.devicePreset,
        isLandscape: !state.isLandscape,
        customSize: state.customSize,
      };
      return { isLandscape: viewport.isLandscape, ...viewportMemoryUpdate(state.viewportMemory, viewport) };
    });
    scheduleViewportFlush();
  },

  setFreeformSize: (width, height) => {
    set((state) => {
      const viewport = {
        devicePreset: customPreset(width, height),
        isLandscape: false,
        customSize: { width, height },
      };
      return { ...viewport, ...viewportMemoryUpdate(state.viewportMemory, viewport) };
    });
    scheduleViewportFlush();
  },

  clearViewportMemory: () => {
    if (viewportFlushTimer) {
      clearTimeout(viewportFlushTimer);
      viewportFlushTimer = null;
    }
    saveViewportMemory({});
    set({ viewportMemory: {} });
  },

  setServices: (services) => {
    set({ services, composeError: null, composeNotConfigured: false });
    // The list is what says whether the remembered service is running, exists,
    // or has come back — so the pane's target is re-derived here, never left to
    // a caller to remember (planning#478).
    get().reconcilePreviewTarget();
  },

  setSecrets: (secrets) => set({ secrets }),

  updateService: (update) => {
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
    });
    get().reconcilePreviewTarget();
  },

  snapshotSession: (sessionId) =>
    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
        [sessionId]: {
          status: state.status,
          errors: state.errors,
          autoFixRetries: state.autoFixRetries,
          startupSteps: state.startupSteps,
          services: state.services,
          composeError: state.composeError,
          composeNotConfigured: state.composeNotConfigured,
          secrets: state.secrets,
        },
      },
    })),

  restoreSession: (sessionId) => {
    const snap = get().sessionSnapshots[sessionId];
    // The viewport is resolved from `viewportMemory` in BOTH branches, never
    // from the snapshot (docs/278). Two reasons: the memory is what survives a
    // page reload (req 6), and on a cold load the URL→store sync effect runs
    // resumeSessionInternal against a half-initialized store, so an accidental
    // defaults-snapshot exists by the time this runs — a fallback-only read
    // would never fire.
    const viewport = viewportStateFromEntry(get().viewportMemory[sessionId]);
    // A pointer's destination describes one session and is cancelled by leaving
    // it (docs/258) — it is never part of the restored snapshot.
    // `selectedPort` is cleared rather than carried: it belongs to the outgoing
    // session until the reconcile below re-derives it for this one, and a frame
    // rendered in between would route the pane at the wrong session's port.
    if (snap) {
      set({ ...snap, ...viewport, selectedPort: null, previewLinkIntent: null });
    } else {
      resetDedupState();
      set({ ...initialSessionState, ...viewport, selectedPort: null, previewLinkIntent: null });
    }
    // Same reasoning as the viewport, and the whole point of planning#478: the
    // snapshot's `selectedPort` is a port that may have changed hands (or gone)
    // while this session was off screen, so the pane's target is re-derived
    // from the remembered SERVICE — on switches and cold loads alike. The
    // incoming session's `service_list` reconciles again when it lands.
    get().reconcilePreviewTarget(sessionId);
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
      // Same reasoning, same lifecycle: cross-session memory survives the
      // session-scoped reset; `clearViewportMemory` (full reset) clears it.
      // Spreading `initialState` would otherwise resurrect the load-time map.
      viewportMemory: state.viewportMemory,
      // Ditto — and load-bearing for planning#478: `reset()` runs on the way to
      // the home screen, and forgetting here would mean the next visit to a
      // session re-pins the pane to whatever service happens to be up.
      previewTargetMemory: state.previewTargetMemory,
    }));
  },

  clearPreviewTargetMemory: () => {
    savePreviewTargetMemory({});
    set({ previewTargetMemory: {} });
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

// Flush a pending viewport write when the page goes away or is backgrounded.
// The debounce trades a ≤300ms loss window for not serializing on every drag
// frame; these are the last-chance hooks that close that window for the common
// "pick a viewport, then immediately reload" sequence. `pagehide` covers
// reload/close/navigate; `visibilitychange`→hidden covers mobile background
// kills, where `pagehide` may never fire. Flushing twice is idempotent.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushViewportMemoryNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushViewportMemoryNow();
  });
}

// Re-export DevicePreset type for convenience so consumers don't need to know the source.
export type { DevicePreset } from "../components/device-presets.js";
