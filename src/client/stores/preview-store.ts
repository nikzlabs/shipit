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

export interface ManagedServiceState {
  name: string;
  status: ComposeServiceStatus;
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;

  origin?: ComposeServiceOriginView;
}

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

  sessionId: string;

  service: string;

  port: number;

  slotKey: string;

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

/**
 * A declared secret aggregated across every claimant that referenced it:
 * compose services, and — docs/262 req 23 — activated plugins, by alias. A
 * name claimed by both is one row, because it is one stored secret.
 */
export type DeclaredSecretState = SecretRequirement & {
  services: string[];
  plugins?: string[];
  /**
   * reqs 23, 24 — a claiming plugin cannot work without this name. Distinct
   * from `required`, which is compose's and gates the preview banner; this one
   * only stops the row offering "value (optional)" for a key the Plugins card
   * says a plugin needs (`secret-resolver.ts`).
   */
  pluginRequired?: boolean;
};

export interface SecretsState {
  declared: DeclaredSecretState[];
  missingByService: Record<string, string[]>;
  missingRequired: string[];

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

const MAX_ERRORS = 50;

const MAX_STARTUP_STEP_LOG_LINES = 50;

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

  services: ManagedServiceState[];

  composeError: string | null;

  composeNotConfigured: boolean;

  secrets: SecretsState;

  devicePreset: DevicePreset | null;

  isLandscape: boolean;

  customSize: { width: number; height: number } | null;

  viewportMemory: Record<string, PersistedViewport>;

  previewTargetMemory: Record<string, PersistedPreviewTarget>;

  sessionSnapshots: Record<string, SessionPreviewSnapshot>;

  previewPaths: Record<string, string>;

  previewLinkIntent: PreviewLinkIntent | null;

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

  appendStartupStepLog: (stepId: StartupStep["stepId"], text: string) => void;
  clearStartupSteps: () => void;

  setServices: (services: ManagedServiceState[]) => void;

  updateService: (update: ManagedServiceState) => void;
  setComposeError: (error: string | null) => void;
  setComposeNotConfigured: (value: boolean) => void;

  setSecrets: (secrets: SecretsState) => void;

  setDevicePreset: (preset: DevicePreset | null) => void;

  toggleLandscape: () => void;
  /**
   * Activate a freeform/custom viewport at `width`×`height` — one atomic set of
   * synthetic preset + `customSize` + `isLandscape: false`. Atomic because the
   * drag handles call this per pointermove; chained setters would render (and
   * persist) partial states.
   */
  setFreeformSize: (width: number, height: number) => void;

  clearViewportMemory: () => void;

  clearPreviewTargetMemory: () => void;

  snapshotSession: (sessionId: string) => void;

  restoreSession: (sessionId: string) => void;

  getSnapshot: (sessionId: string) => SessionPreviewSnapshot | undefined;

  setPreviewPath: (slotKey: string, path: unknown) => void;

  clearPreviewPaths: () => void;

  setPreviewLinkIntent: (intent: PreviewLinkIntent) => void;

  clearPreviewLinkIntent: (clickId?: number) => void;
  reset: () => void;
}

let idCounter = 0;
const recentKeys = new Map<string, number>();

function dedupKey(type: string, message: string, source?: string, line?: number): string {
  return `${type}:${message}:${source ?? ""}:${line ?? ""}`;
}

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

export const VIEWPORT_FLUSH_DEBOUNCE_MS = 300;

let viewportFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

function availablePreviewPorts(status: PreviewStatus | null): number[] {
  if (!status?.running) return [];
  const ports = [...(status.detectedPorts ?? [])];
  if ((status.source === "vite" || status.source === "managed") && !ports.includes(status.port)) {
    ports.push(status.port);
  }
  return ports;
}

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

  const status = deriveEffectivePreviewStatus(state.status, state.services, sessionId);
  let entry = sessionId ? state.previewTargetMemory[sessionId] : undefined;

  // rather than falling back forever to a name that will never come back. An

  const forget =
    !!entry?.service &&
    state.services.length > 0 &&
    !state.services.some((s) => s.name === entry?.service);
  if (forget) entry = undefined;

  if (entry?.service) {
    const svc = state.services.find((s) => s.name === entry?.service);

    // is the one case with nothing to wait on; it cannot be pinned in the first

    return { selectedPort: svc ? svc.port ?? null : entry.port };
  }
  if (entry) {

    const ports = availablePreviewPorts(status);
    return { selectedPort: ports.includes(entry.port) ? entry.port : null };
  }

  if (!sessionId || !status?.running || !status.port) {
    return { selectedPort: null, write: forget ? null : undefined };
  }
  const svc = state.services.find((s) => s.port === status.port);
  if (!svc && status.source === "detected") {

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

  selectedPort: null as number | null,
  servicesDrawerIdleCollapsed: false,
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

    if (port === null) get().reconcilePreviewTarget();
  },

  reconcilePreviewTarget: (forSessionId) => {

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

    // or has come back — so the pane's target is re-derived here, never left to

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

    // would never fire.
    const viewport = viewportStateFromEntry(get().viewportMemory[sessionId]);

    // it (docs/258) — it is never part of the restored snapshot.

    if (snap) {
      set({ ...snap, ...viewport, selectedPort: null, previewLinkIntent: null });
    } else {
      resetDedupState();
      set({ ...initialSessionState, ...viewport, selectedPort: null, previewLinkIntent: null });
    }

    get().reconcilePreviewTarget(sessionId);
  },

  getSnapshot: (sessionId): SessionPreviewSnapshot | undefined => get().sessionSnapshots[sessionId],

  setPreviewPath: (slotKey, path) => {
    const value = sanitizePreviewPath(path);
    if (!value) return;
    set((state) => {
      if (state.previewPaths[slotKey] === value) return state;

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

      previewPaths: state.previewPaths,

      viewportMemory: state.viewportMemory,
      // Ditto — and load-bearing for planning#478: `reset()` runs on the way to

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

// kills, where `pagehide` may never fire. Flushing twice is idempotent.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushViewportMemoryNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushViewportMemoryNow();
  });
}

export type { DevicePreset } from "../components/device-presets.js";
