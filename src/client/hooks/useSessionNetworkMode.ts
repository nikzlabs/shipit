// eslint-disable-next-line no-restricted-imports -- useEffect: hydrate a session's network mode from the server and follow invalidations (external system sync)
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EgressEnforcementStatus,
  EgressSessionSettings,
} from "../../server/shared/types.js";

/**
 * docs/285 — one session's network mode, shared by the composer control and the
 * Session settings dialog.
 *
 * Requirement 7 asks for **one authoritative value, consistently represented**,
 * not one location. Two surfaces may show and change it; what they may not do is
 * disagree. This hook is how they don't:
 *
 *  - it reads and writes the same routes the dialog already used, so there is no
 *    second store and no caching layer to go stale;
 *  - every response is applied only if BOTH the session it was asked about and
 *    the mutation revision it was issued under still hold. Session ownership
 *    alone stops session A's answer landing in B, but not an older GET for A
 *    landing after a newer PUT for A — and the revisions have to come from one
 *    shared clock, or the dialog's writes and the composer's writes are ordered
 *    against nothing;
 *  - a change from either surface, in this tab or another, invalidates the rest
 *    through the transient `session_egress_changed` SSE.
 */

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

/** What a session actually resolves to, given the workspace default. */
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

// ---------------------------------------------------------------------------
// The shared mutation clock
// ---------------------------------------------------------------------------

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

/**
 * Tell every mounted consumer that this session's network mode changed, so they
 * re-read it. Called by the writer here, and by the SSE handler for a change
 * that happened somewhere else.
 */
export function notifySessionNetworkModeChanged(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

/** Test-only: drop the shared clock so one case cannot leak into the next. */
export function _resetSessionNetworkModeClock(): void {
  revisions.clear();
  listeners.clear();
}

// ---------------------------------------------------------------------------

export interface SessionNetworkModeState {
  /** The mode to display. Reflects an in-flight optimistic write immediately. */
  mode: NetworkMode;
  /** The workspace default, for naming what `inherit` currently resolves to. */
  globalEnabled: boolean;
  enforcementStatus: EgressEnforcementStatus;
  /** The server's verdict that the live container disagrees with `mode`. */
  pendingRestart: boolean;
  /** True once the value has been read from the server at least once. */
  loaded: boolean;
  /**
   * docs/285 — **the Send barrier.** True while a write is in flight, and after
   * a failed one until the displayed value has reverted.
   *
   * Without it, picking Contained and pressing Send in the same breath lets the
   * server resolve the OLD value, find no mismatch, and run the first turn under
   * the wrong policy — requirement 3 lost to ordinary mutation ordering. It is a
   * save barrier on one control, not a transaction around Send.
   */
  saving: boolean;
  setMode: (next: NetworkMode) => void;
}

/**
 * `sessionId` may be `null` — the new-session composer renders before its claim
 * lands. A pick made then is held by the CALLER as a draft and written when the
 * id arrives; this hook simply reports the default and accepts no writes.
 */
export function useSessionNetworkMode(sessionId: string | null): SessionNetworkModeState {
  const [mode, setModeState] = useState<NetworkMode>("inherit");
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [enforcementStatus, setEnforcementStatus] = useState<EgressEnforcementStatus>("active");
  const [pendingRestart, setPendingRestart] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // The revision this component last issued or accepted. A response older than
  // it is dropped.
  const seenRevision = useRef(0);

  const applySettings = useCallback((settings: EgressSessionSettings) => {
    setModeState(modeFromOverride(settings.override));
    setGlobalEnabled(settings.globalEnabled);
    setEnforcementStatus(settings.enforcementStatus ?? (settings.enforcementActive ? "active" : "no-sidecar"));
    setPendingRestart(settings.pendingRestart);
    setLoaded(true);
  }, []);

  const refresh = useCallback(
    async (id: string) => {
      const issuedAt = currentRevision(id);
      try {
        const res = await fetch(`/api/egress/session/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const settings = (await res.json()) as EgressSessionSettings;
        // Drop a read that a write has already overtaken. `>=` rather than `>`:
        // a write issued at the same revision has authoritative data of its own.
        if (currentRevision(id) !== issuedAt) return;
        seenRevision.current = issuedAt;
        applySettings(settings);
      } catch (err) {
        console.error("[session-network-mode] failed to read the session's mode:", err);
      }
    },
    [applySettings],
  );

  // Hydrate on mount and whenever the session changes. Without this the
  // always-visible trigger would not know an existing session carries an
  // override until the menu was opened once — wrong, not merely stale.
  //
  // req 8 — the state resets with the session, so a pick never carries over to
  // the next new session.
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

  // Follow changes made by the other surface, in this tab or another.
  // eslint-disable-next-line no-restricted-syntax -- external system sync: subscribe to cross-surface invalidation
  useEffect(() => {
    if (!sessionId) return;
    const listener = (changed: string): void => {
      if (changed === sessionId) void refresh(sessionId);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId, refresh]);

  const setMode = useCallback(
    (next: NetworkMode) => {
      if (!sessionId) return;
      const previous = mode;
      // Optimistic: a settings control that lags a click reads as broken, and
      // the Send barrier below is what makes the optimism safe.
      setModeState(next);
      setSaving(true);
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
          // A later write has superseded this one — its own response is the
          // truth, and applying this would move the control backwards.
          if (currentRevision(sessionId) !== revision) return;
          seenRevision.current = revision;
          applySettings(settings);
        } catch (err) {
          // Revert BEFORE clearing `saving`. The barrier's contract is that
          // Send stays blocked until the displayed value is one the server
          // agrees with, and clearing first would open a frame in which the
          // composer shows a mode the server never accepted and lets it be sent.
          if (currentRevision(sessionId) === revision) setModeState(previous);
          console.error("[session-network-mode] failed to write the session's mode:", err);
        } finally {
          if (currentRevision(sessionId) === revision) setSaving(false);
        }
      })();
    },
    [sessionId, mode, applySettings],
  );

  return { mode, globalEnabled, enforcementStatus, pendingRestart, loaded, saving, setMode };
}

/**
 * docs/285 — the composer's view of the same value, with the one thing the
 * session-scoped hook above cannot have: **a pick made before there is a session
 * to write it to.**
 *
 * `/new` claims its session on arrival, but the claim is asynchronous and the
 * control is live throughout — `disabled` blocks Send without making the
 * selector inert, so a mode can be chosen with no id yet. Disabling the section
 * until the claim lands would be simpler and worse: the moment the user is most
 * likely to set this is while the page is still settling.
 *
 * So a pick made then is held as a **draft, scoped to the claim it is waiting
 * for**, written the instant an id arrives, with Send barred until that write
 * succeeds — the same barrier the ordinary path uses, extended over the claim.
 *
 * req 8 — the draft is dropped whenever the session identity changes, so
 * abandoning `/new` and starting another one begins at Inherit. (The server
 * closes the other half of that: an interactive claim that RECYCLES an abandoned
 * draft session resets the override it still carries.)
 */
export function useComposerNetworkMode(
  sessionId: string | null,
  /**
   * Whether a claim for THIS composer is expected to produce `sessionId`.
   *
   * The hook cannot tell "the `/new` claim landed" from "the user navigated to
   * an existing session" by watching the id alone — both are `null` → some id —
   * and writing a draft on the second would apply a pick to a session the user
   * never made it for. The caller knows which route it is on, so it says.
   */
  expectingClaim: boolean,
): SessionNetworkModeState {
  const server = useSessionNetworkMode(sessionId);
  // The pick, and the claim it is waiting for. One piece of state, so the
  // "is it still valid" question cannot be answered by two values that disagree.
  const [draft, setDraft] = useState<NetworkMode | null>(null);
  // Held in a ref as well so the write effect can consume it without listing the
  // setter's identity among its dependencies.
  const pending = useRef<NetworkMode | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- external system sync: write a pre-claim pick once the claim resolves
  useEffect(() => {
    if (!sessionId) return;
    const held = pending.current;
    if (held === null) return;
    pending.current = null;
    setDraft(null);
    // The id arrived for some OTHER reason than this composer's claim (the user
    // navigated to an existing session while a draft was held). Drop it rather
    // than apply it somewhere the user did not choose.
    if (!expectingClaim) return;
    server.setMode(held);
    // `server.setMode`'s identity changes with every mode change, so depending on
    // it would re-run this the instant the write it started lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, expectingClaim]);

  const setMode = useCallback(
    (next: NetworkMode) => {
      if (sessionId) {
        server.setMode(next);
        return;
      }
      pending.current = next;
      setDraft(next);
    },
    [sessionId, server],
  );

  return {
    ...server,
    // While the claim is pending the draft IS the displayed value — the server
    // has nothing to say about a session that does not exist yet.
    mode: sessionId ? server.mode : (draft ?? "inherit"),
    // A held draft bars Send for the same reason an in-flight write does: the
    // server has not been told, so a first turn started now would resolve the
    // old value, find no mismatch, and run under the wrong policy.
    saving: server.saving || draft !== null,
    setMode,
  };
}
