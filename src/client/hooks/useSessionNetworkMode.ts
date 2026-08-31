// eslint-disable-next-line no-restricted-imports -- useEffect: hydrate a session's network mode from the server and follow invalidations (external system sync)
import { useCallback, useEffect, useRef, useState } from "react";
import { useEgressStore } from "../stores/egress-store.js";
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
 * Monotonic READ counter, separate from the write revision above.
 *
 * The write clock orders writes against reads, and cannot order reads against
 * each other: two GETs issued at the same revision — the mount hydration and a
 * refetch triggered by another tab's change — both pass its check, so whichever
 * response arrives LAST wins regardless of which was asked last. The older one
 * winning is permanent, and shows a value the server has already replaced.
 */
const reads = new Map<string, number>();

function nextRead(sessionId: string): number {
  const next = (reads.get(sessionId) ?? 0) + 1;
  reads.set(sessionId, next);
  return next;
}

/**
 * Tell every mounted consumer that this session's network mode changed, so they
 * re-read it. Called by the writer here, and by the SSE handler for a change
 * that happened somewhere else.
 */
export function notifySessionNetworkModeChanged(
  sessionId: string,
  /** The listener that caused the change, which already has the answer. */
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
  reads.clear();
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
  /**
   * The session this hook is CURRENTLY mounted against.
   *
   * Revision ownership alone is not enough. Revisions are keyed per session, so a
   * response for session A can still satisfy `currentRevision(A)` long after the
   * user navigated to B — and `applySettings` would then paint A's value onto B's
   * control. Read from a ref rather than the closure so an in-flight request
   * checks where we are NOW, not where we were when it was issued.
   */
  const mountedSession = useRef<string | null>(sessionId);
  mountedSession.current = sessionId;
  /** This hook's own subscription, so its writes do not notify itself. */
  const listenerRef = useRef<((changed: string) => void) | null>(null);
  /**
   * Writes this hook still has in flight. `saving` is per-hook — it is set by
   * this hook's own `setMode` — so a read may only open the barrier when this
   * hook is not itself mid-write. Otherwise an invalidation arriving at the same
   * revision as an in-flight PUT would release Send before that PUT landed,
   * which is the barrier's whole failure mode.
   */
  const writesInFlight = useRef(0);
  /**
   * Whether the value currently ON SCREEN is one the server reported, as opposed
   * to an optimistic pick that has not been confirmed. Set by `applySettings`,
   * cleared the moment a pick is displayed optimistically.
   *
   * This is what the Send barrier actually waits for, and it is not the same
   * question as "did MY write succeed". Two rapid picks settle in whatever order
   * the server answers, so the write that finishes last is routinely not the one
   * whose value is displayed — asking each write about its own outcome left the
   * barrier shut forever whenever the responses came back out of order.
   */
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
      const readAt = nextRead(id);
      try {
        const res = await fetch(`/api/egress/session/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const settings = (await res.json()) as EgressSessionSettings;
        // Three ways this answer can be obsolete, and all three have bitten:
        // a write has overtaken it; a LATER READ has overtaken it (the mount
        // hydration racing a cross-tab refetch); or the hook has navigated to a
        // different session since asking.
        if (currentRevision(id) !== issuedAt) return false;
        if ((reads.get(id) ?? 0) !== readAt) return false;
        if (mountedSession.current !== id) return false;
        applySettings(settings);
        // A successful read is a value the server reported, which is exactly
        // what the Send barrier waits for — so it opens here too, not only on
        // the write path. Without this, a failed PUT whose immediate recovery
        // read ALSO failed left the barrier closed for good: the next
        // invalidation would fetch the true value and display it, while Send
        // stayed barred until the user navigated away. Staying barred on an
        // unreachable server is the safe direction; staying barred after the
        // server has answered is just broken.
        if (writesInFlight.current === 0) setSaving(false);
        return true;
      } catch (err) {
        console.error("[session-network-mode] failed to read the session's mode:", err);
        return false;
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
    listenerRef.current = listener;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId, refresh]);

  const setMode = useCallback(
    (next: NetworkMode) => {
      if (!sessionId) return;
      // Optimistic: a settings control that lags a click reads as broken, and
      // the Send barrier below is what makes the optimism safe.
      displayedFromServer.current = false;
      setModeState(next);
      setSaving(true);
      writesInFlight.current += 1;
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
          // truth, and applying this would move the control backwards. A session
          // switch invalidates it for the same reason a read is invalidated.
          if (currentRevision(sessionId) !== revision) return;
          if (mountedSession.current !== sessionId) return;
          applySettings(settings);
          // req 7 — tell every other mounted surface directly. The transient SSE
          // carries this to OTHER TABS, but within one tab it is not the path:
          // an SSE interruption during a write would leave the composer and the
          // dialog holding different values indefinitely, which is the exact
          // disagreement req 7 forbids.
          notifySessionNetworkModeChanged(sessionId, listenerRef.current);
        } catch (err) {
          console.error("[session-network-mode] failed to write the session's mode:", err);
          // RE-READ rather than revert to a remembered value. Any local guess is
          // a guess about a server this client just failed to talk to, and the
          // orderings make it wrong: capture the value at issue time and an
          // older write that SUCCEEDED never advanced it, so a newer failure
          // reverts past a change the server did accept — showing Inherit while
          // the server holds Open, with Send released. Asking is cheap, correct
          // in every interleaving, and cannot drift.
          //
          // Awaited inside the barrier: `saving` stays true until the displayed
          // value is one the server actually reported.
          if (currentRevision(sessionId) === revision && mountedSession.current === sessionId) {
            await refresh(sessionId);
          }
        } finally {
          writesInFlight.current -= 1;
          // The barrier opens only when NOTHING is still being written for this
          // session and the value on screen is one the server reported.
          //
          // Both halves are load-bearing, and each replaced a wrong rule. Asking
          // only "did my own write succeed" opened it while a sibling write was
          // still rebuilding a container. Adding this write's own revision to the
          // test then closed it forever whenever two responses came back out of
          // order, because the last write to settle is routinely not the one whose
          // value is displayed. Staying barred on an unreachable server is the safe
          // direction and is recoverable — the next read reopens it — but staying
          // barred after the server has answered is just broken.
          if (
            writesInFlight.current === 0
            && displayedFromServer.current
            && mountedSession.current === sessionId
          ) {
            setSaving(false);
          }
        }
      })();
    },
    [sessionId, applySettings, refresh],
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
  /**
   * req 8 — which claim this composer is waiting for, as a stable identity.
   *
   * `sessionId === null` plus `expectingClaim` is not enough to own a draft:
   * navigating `/repo-A/new` → `/repo-B/new` before A's claim lands leaves both
   * renders at `(null, true)`, so a pick made for A survives and is written into
   * B when B's claim returns — a mode the user chose for a different session, in
   * a different repository. Anything that changes per new-session route works;
   * the repo URL is what the caller has.
   */
  claimScope: string | null,
): SessionNetworkModeState {
  const server = useSessionNetworkMode(sessionId);
  /**
   * req 10 — while there is no session there is nothing to read a per-session
   * view from, and the hook's own default would have the menu say "Inherit
   * workspace — currently Contained" on an OPEN workspace. That is a false
   * statement made in exactly the interval this feature promises the control
   * works, so the workspace default is read from the store instead of assumed.
   */
  const storeGlobalEnabled = useEgressStore((s) => s.globalEnabled);
  const storeEnforcement = useEgressStore((s) => s.enforcementStatus);
  const storeGlobalLoaded = useEgressStore((s) => s.globalLoaded);
  const loadGlobal = useEgressStore((s) => s.loadGlobal);
  // eslint-disable-next-line no-restricted-syntax -- external system sync: read the workspace default when no session can report it
  useEffect(() => {
    if (!sessionId) void loadGlobal();
  }, [sessionId, loadGlobal]);

  // The pick, and the claim it is waiting for. One piece of state, so the
  // "is it still valid" question cannot be answered by two values that disagree.
  const [draft, setDraft] = useState<NetworkMode | null>(null);
  // Held in a ref as well so the write effect can consume it without listing the
  // setter's identity among its dependencies.
  const pending = useRef<NetworkMode | null>(null);

  // req 8 — the draft belongs to ONE claim. A route change abandons it rather
  // than carrying a pick into whatever session arrives next.
  // eslint-disable-next-line no-restricted-syntax -- external system sync: drop a draft whose claim the user navigated away from
  useEffect(() => {
    return () => {
      pending.current = null;
      setDraft(null);
    };
  }, [claimScope]);

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
    // req 10 — before the claim, the workspace default comes from the store; the
    // per-session view takes over the moment there is a session to read.
    globalEnabled: sessionId ? server.globalEnabled : storeGlobalEnabled,
    enforcementStatus: sessionId ? server.enforcementStatus : storeEnforcement,
    // …and `loaded` says whether that value has actually been READ. The store's
    // initial `true` is an optimistic placeholder chosen so a capable deployment
    // never flashes a warning, which makes it exactly the wrong thing to print
    // as fact: on an Open workspace the pre-claim menu would say "Inherit —
    // currently Contained" until the request returned. The control names no
    // value until one is known.
    loaded: sessionId ? server.loaded : storeGlobalLoaded,
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
