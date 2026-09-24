// eslint-disable-next-line no-restricted-imports -- useEffect: hydrate a session's network mode from the server and follow invalidations (external system sync)
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useEgressStore } from "../stores/egress-store.js";
import {
  _resetSessionSettingWrites,
  beginSessionSettingWrite,
  sessionSettingWritesInFlight,
  subscribeSessionSettingWrites,
} from "../utils/session-setting-writes.js";
import type {
  EgressEnforcementStatus,
  EgressSessionSettings,
} from "../../server/shared/types.js";

export type NetworkMode = "inherit" | "contained" | "open";

export function modeFromOverride(override: boolean | null): NetworkMode {
  if (override === true) return "contained";
  if (override === false) return "open";
  return "inherit";
}

export function overrideFromMode(mode: NetworkMode): boolean | null {
  if (mode === "contained") return true;
  if (mode === "open") return false;
  return null;
}

/**
 * docs/285 — the network options, in ONE set of words.
 *
 * The dialog said "Inherit global" while the composer would have said "Inherit
 * workspace", and one value must not have two names. "Workspace" won because it
 * is what the product calls the setting everywhere else (Settings → Network);
 * "global" named nothing the user can point at.
 */
export const NETWORK_MODE_LABEL: Record<NetworkMode, string> = {
  inherit: "Inherit workspace",
  contained: "Contained",
  open: "Open",
};

export function resolvesToContained(mode: NetworkMode, globalEnabled: boolean): boolean {
  if (mode === "contained") return true;
  if (mode === "open") return false;
  return globalEnabled;
}

/**
 * docs/285 — the enforcement warning, naming the CASE and its remediation.
 * `null` when there is nothing to warn about.
 *
 * `enforcementActive: false` covers two deployments whose consequences point in
 * OPPOSITE directions — enforcement switched off means a contained session runs
 * **open**, a missing sidecar image means it **will not start** — so a warning
 * built on the boolean either overstates one case or hedges into telling the
 * user nothing they can act on. Both surfaces read this, so they cannot drift
 * into saying different things about one deployment.
 *
 * Callers show it only while the session resolves to Contained: an Open session
 * is not claiming protection, so there is no gap between claim and reality.
 */
export function enforcementWarning(status: EgressEnforcementStatus): string | null {
  if (status === "disabled") {
    return "Egress enforcement is switched off on this deployment, so a contained session still runs with open network access. An operator can unset SESSION_EGRESS_ENFORCE=0 to restore it.";
  }
  if (status === "no-sidecar") {
    return "The egress sidecar is unavailable on this deployment, so contained sessions will not start. An operator needs to configure SESSION_EGRESS_SIDECAR_IMAGE.";
  }
  return null;
}

/**
 * Per-session mutation revision, bumped by every write from every surface.
 *
 * Module-level rather than per-component precisely because the ordering problem
 * is BETWEEN components: two component-local counters would each be internally
 * consistent and jointly meaningless.
 */
const revisions = new Map<string, number>();
const listeners = new Set<(sessionId: string) => void>();

function bumpRevision(sessionId: string): number {
  const next = (revisions.get(sessionId) ?? 0) + 1;
  revisions.set(sessionId, next);
  return next;
}

function currentRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}

export function notifySessionNetworkModeChanged(
  sessionId: string,

  origin?: unknown,
): void {
  for (const listener of listeners) {
    if (listener === origin) continue;
    listener(sessionId);
  }
}

/** Test-only: drop the shared clock so one case cannot leak into the next. */
export function _resetSessionNetworkModeClock(): void {
  revisions.clear();
  listeners.clear();
  _resetSessionSettingWrites();
}

export interface SessionNetworkModeState {

  mode: NetworkMode;

  globalEnabled: boolean;
  enforcementStatus: EgressEnforcementStatus;

  pendingRestart: boolean;

  loaded: boolean;

  saving: boolean;
  setMode: (next: NetworkMode) => void;
}

export function useSessionNetworkMode(sessionId: string | null): SessionNetworkModeState {
  const [mode, setModeState] = useState<NetworkMode>("inherit");
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [enforcementStatus, setEnforcementStatus] = useState<EgressEnforcementStatus>("active");
  const [pendingRestart, setPendingRestart] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const sharedWrites = useSyncExternalStore(
    subscribeSessionSettingWrites,
    () => (sessionId ? sessionSettingWritesInFlight(sessionId) : 0),
  );

  const mountedSession = useRef<string | null>(sessionId);
  mountedSession.current = sessionId;
  /** This hook's own subscription, so its writes do not notify itself. */
  const listenerRef = useRef<((changed: string) => void) | null>(null);

  const writesInFlight = useRef(0);
  /**
   * Monotonic READ counter, separate from the write revision. The write clock
   * cannot order two reads issued at the same revision — the mount hydration
   * and a refetch after another surface's change — so without this the older
   * response could land last and show a replaced value. Per instance: a shared
   * counter lets the dialog's own re-read discard the composer's.
   */
  const readSeq = useRef(0);

  const displayedFromServer = useRef(false);

  const applySettings = useCallback((settings: EgressSessionSettings) => {
    displayedFromServer.current = true;
    setModeState(modeFromOverride(settings.override));
    setGlobalEnabled(settings.globalEnabled);
    setEnforcementStatus(settings.enforcementStatus ?? (settings.enforcementActive ? "active" : "no-sidecar"));
    setPendingRestart(settings.pendingRestart);
    setLoaded(true);
  }, []);

  const refresh = useCallback(
    async (id: string): Promise<boolean> => {
      const issuedAt = currentRevision(id);
      const readAt = ++readSeq.current;
      try {
        const res = await fetch(`/api/egress/session/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const settings = (await res.json()) as EgressSessionSettings;

        if (currentRevision(id) !== issuedAt) return false;
        if (readSeq.current !== readAt) return false;
        if (mountedSession.current !== id) return false;
        applySettings(settings);

        if (writesInFlight.current === 0) setSaving(false);
        return true;
      } catch (err) {
        console.error("[session-network-mode] failed to read the session's mode:", err);
        return false;
      }
    },
    [applySettings],
  );

  // req 8 — the state resets with the session, so a pick never carries over to

  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the session's mode when it changes
  useEffect(() => {
    setModeState("inherit");
    setGlobalEnabled(true);
    setPendingRestart(false);
    setLoaded(false);
    setSaving(false);
    if (!sessionId) return;
    void refresh(sessionId);
  }, [sessionId, refresh]);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: subscribe to cross-surface invalidation
  useEffect(() => {
    if (!sessionId) return;
    const listener = (changed: string): void => {
      if (changed === sessionId) void refresh(sessionId);
    };
    listenerRef.current = listener;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId, refresh]);

  const setMode = useCallback(
    (next: NetworkMode) => {
      if (!sessionId) return;

      displayedFromServer.current = false;
      setModeState(next);
      setSaving(true);
      writesInFlight.current += 1;
      const endWrite = beginSessionSettingWrite(sessionId);
      const revision = bumpRevision(sessionId);
      void (async () => {
        try {
          const res = await fetch(`/api/egress/session/${encodeURIComponent(sessionId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ override: overrideFromMode(next) }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const settings = (await res.json()) as EgressSessionSettings;

          if (currentRevision(sessionId) !== revision) return;
          // Notify even if this hook has moved on: the dialog closes mid-write, and
          // the composer must still re-read the value.
          notifySessionNetworkModeChanged(sessionId, listenerRef.current);
          if (mountedSession.current !== sessionId) return;
          applySettings(settings);
        } catch (err) {
          console.error("[session-network-mode] failed to write the session's mode:", err);

          // older write that SUCCEEDED never advanced it, so a newer failure

          // in every interleaving, and cannot drift.

          if (currentRevision(sessionId) === revision && mountedSession.current === sessionId) {
            await refresh(sessionId);
          }
        } finally {
          writesInFlight.current -= 1;
          endWrite();

          // Both halves are load-bearing, and each replaced a wrong rule. Asking

          // order, because the last write to settle is routinely not the one whose

          if (writesInFlight.current === 0 && mountedSession.current === sessionId) {

            const fresh = await refresh(sessionId);
            if (
              (fresh || displayedFromServer.current)
              && mountedSession.current === sessionId
            ) {
              setSaving(false);
            }
          }
        }
      })();
    },
    [sessionId, applySettings, refresh],
  );

  return {
    mode,
    globalEnabled,
    enforcementStatus,
    pendingRestart,
    loaded,
    saving: saving || sharedWrites > 0,
    setMode,
  };
}

/**
 * docs/285 — the composer's view of the same value. Before `/new`'s claim lands
 * there is no session to read, so it shows Inherit and names the workspace
 * default from the egress store. The composer changes the mode only through the
 * Session settings dialog (req 12), which needs a session, so no pick can be
 * made before the claim.
 */
export function useComposerNetworkMode(sessionId: string | null): SessionNetworkModeState {
  const server = useSessionNetworkMode(sessionId);

  const storeGlobalEnabled = useEgressStore((s) => s.globalEnabled);
  const storeEnforcement = useEgressStore((s) => s.enforcementStatus);
  const storeGlobalLoaded = useEgressStore((s) => s.globalLoaded);
  const loadGlobal = useEgressStore((s) => s.loadGlobal);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the workspace default when no session can report it
  useEffect(() => {
    if (!sessionId) void loadGlobal();
  }, [sessionId, loadGlobal]);

  if (sessionId) return server;
  return {
    ...server,
    globalEnabled: storeGlobalEnabled,
    enforcementStatus: storeEnforcement,
    loaded: storeGlobalLoaded,
  };
}
