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
 * request, so the browser's copy is the only stale view.
 *
 * Three guards, each for a distinct race (all from the independent review):
 *
 * 1. **Foreign-session responses are dropped** — a response that lands after
 *    the user switched away would gate the tab on another repository.
 * 2. **Latest-wins within one session** — the seeding fetch and one or more
 *    `files_changed` fetches overlap freely, so an older response arriving
 *    last must not overwrite a newer declaration. A monotonic generation
 *    counter, not response order, decides.
 * 3. **`pending` is retried, never cached** — an evicted or mid-restore
 *    checkout cannot answer "what does this repo declare?", and caching its
 *    empty answer would silently cost the session its Plugins tab until the
 *    next shipit.yaml event. Mirrors `declarationsPending` in issues-store.
 */

/** Backoff for the pending retry, matching the issues-store warm loop. */
const PENDING_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Monotonic across ALL fetches, deliberately not per session: a switch away
 * and back must invalidate the older session's in-flight response too, and one
 * counter makes "is this the newest request?" a single comparison.
 */
let fetchGeneration = 0;

interface PluginReposState {
  /** The active session's snapshot; null until the first fetch lands. */
  snapshot: PluginReposSnapshot | null;
  /** Which session `snapshot` belongs to — read alongside it, never on its own. */
  forSessionId: string | null;
  fetchSnapshot: (sessionId: string) => Promise<void>;
  reset: () => void;
}

export const usePluginReposStore = create<PluginReposState>((set) => ({
  snapshot: null,
  forSessionId: null,

  fetchSnapshot: async (sessionId: string) => {
    const generation = ++fetchGeneration;
    const applied = await fetchOnce(sessionId, generation, set);
    // Retry in the background while the answer is still moving: the checkout
    // can't answer yet (`pending`), or a repository is mid-activation and
    // nothing pushes its completion. Resolving now rather than blocking keeps
    // the caller (a render effect) cheap.
    if (applied && (applied.pending || applied.activating)) {
      void retryWhilePending(sessionId, generation, set);
    }
  },

  reset: () => {
    // Invalidate in-flight fetches: a response from before the reset would
    // otherwise repopulate the store for a session the user has left.
    fetchGeneration++;
    set({ snapshot: null, forSessionId: null });
  },
}));

type SetState = (partial: Partial<PluginReposState>) => void;

/** One request; returns the snapshot if it was applied, else null. */
async function fetchOnce(
  sessionId: string,
  generation: number,
  set: SetState,
): Promise<PluginReposSnapshot | null> {
  try {
    const res = await fetch(`/api/plugin-repos?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const snapshot = (await res.json()) as PluginReposSnapshot;
    if (generation !== fetchGeneration) return null;
    if (useSessionStore.getState().sessionId !== sessionId) return null;
    set({ snapshot, forSessionId: sessionId });
    return snapshot;
  } catch (err) {
    console.warn("[plugin-repos]", err);
    return null;
  }
}

async function retryWhilePending(
  sessionId: string,
  generation: number,
  set: SetState,
): Promise<void> {
  for (const delayMs of PENDING_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    if (generation !== fetchGeneration) return;
    if (useSessionStore.getState().sessionId !== sessionId) return;
    const snapshot = await fetchOnce(sessionId, generation, set);
    // A dropped response (a newer fetch won) ends this loop — that fetch owns
    // the retry from here.
    if (!snapshot) return;
    if (!snapshot.pending && !snapshot.activating) return;
  }
}

/**
 * The snapshot for `sessionId`, or null when the store holds another session's.
 *
 * Every read goes through this: the store is one slot, and a switch that
 * forgot to reset it would otherwise show the previous session's tab, dot and
 * cards. Pairing the value with its owner makes that structurally impossible
 * rather than dependent on each reset call site (review finding).
 */
export function snapshotForSession(
  state: PluginReposState,
  sessionId: string | null | undefined,
): PluginReposSnapshot | null {
  if (!sessionId || state.forSessionId !== sessionId) return null;
  return state.snapshot;
}

/**
 * Tab gating (req 13): plugin INTENT shows the tab — a `plugins:` block that
 * parses to zero valid repos still needs its warning surface — and so does a
 * snapshot carrying only warnings (an unreadable shipit.yaml can't prove
 * intent either way, and hiding the tab would erase the one place that says
 * so). `pending` alone shows nothing: the answer isn't known yet, and the
 * retry will bring it.
 */
export function pluginsTabVisible(snapshot: PluginReposSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.declared || snapshot.warnings.length > 0;
}

/**
 * The warn dot (plan §3): parse warnings, per-repo issues, and an unsatisfied
 * plugin credential (req 23) all count; the v0 `declared`
 * (mechanics-not-built-yet) status deliberately does not.
 *
 * A missing key belongs on the dot for the reason the dot exists: the plugin
 * cannot do its job until the user acts, and a closed tab may hide information
 * but never a problem.
 */
export function pluginsAttention(snapshot: PluginReposSnapshot | null): boolean {
  if (!snapshot) return false;
  return (
    snapshot.warnings.length > 0 ||
    snapshot.repos.some(
      (r) =>
        r.issues.length > 0 ||
        // `?? []` — a snapshot cached by an older client build has no
        // `credentials` on its use entries; a stale shape must not throw here.
        r.uses.some((u) => (u.credentials ?? []).some((c) => !c.satisfied)),
    )
  );
}
