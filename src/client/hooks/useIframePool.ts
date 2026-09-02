import { useState, useRef, useCallback } from "react";

/**
 * Maximum number of retained iframes across all sessions and ports — counted in
 * `(session, port)` pairs, so a multi-service stack spends several.
 *
 * Reassessed after each slot started costing its own renderer process
 * (docs/009-preview-system, "Is `MAX_IFRAME_SLOTS = 20` still right?"); 20 was
 * kept. Read that before changing it — the short version is that the number is
 * not the lever it looks like, and releasing slots whose preview is no longer
 * running would beat lowering it.
 */
export const MAX_IFRAME_SLOTS = 20;

export interface IframeSlot {
  url: string;
  containerMode: boolean;
  /**
   * How many times this key has been dropped and rebuilt. `PreviewFrame` folds
   * it into the iframe's React key, which is what makes a recreated slot a NEW
   * element (planning#394): the key is `${sessionId}:${port}`, so a rebuilt slot
   * carries the same URL, and re-pointing a live iframe at the URL it already
   * has reloads nothing. Stamped by {@link IframePool.setSlot}, never by the
   * caller.
   */
  generation?: number;
  /**
   * The Compose service that owned this slot's port when the slot was
   * created (planning#394) — the same `services.find(s => s.port === port)`
   * derivation the toolbar label uses. `undefined` for a preview with no
   * service row (a local dev server) or one created before the service list
   * arrived. `usePreviewSlot` compares it with the port's current owner and
   * drops the slot when both are known and differ; an `undefined` on either
   * side never drops, because that is a transient list state, not an
   * ownership change.
   */
  service?: string;
}

export interface IframePool {
  /** Map of slot key -> slot data (URL + container mode). */
  slots: Map<string, IframeSlot>;
  /** LRU order, most recent first. Used to render iframes and to evict old ones. */
  slotOrder: string[];
  /** Refs to the DOM iframe elements, keyed by slot key. */
  iframeRefs: React.RefObject<Map<string, HTMLIFrameElement | null>>;
  /** Set of slot keys that have already been created. */
  createdSlotsRef: React.RefObject<Set<string>>;
  /** Promote a slot to the front of the LRU and evict oldest if over capacity. */
  promoteSlot: (key: string) => void;
  /** Add or update a slot with the given URL/containerMode metadata. */
  setSlot: (key: string, slot: IframeSlot) => void;
  /**
   * Remove one slot and its iframe from the pool. `usePreviewSlot` use only —
   * see the hook docstring for why nothing else may call this.
   */
  dropSlot: (key: string) => void;
  /**
   * Drop every slot belonging to one session, whatever port. `PreviewFrame` use
   * only, for a session whose previews have stopped — see the hook docstring's
   * second exception. Returns the keys it dropped.
   */
  dropSessionSlots: (sessionId: string) => string[];
  /**
   * Read a slot outside the render cycle (stable identity). `usePreviewSlot`
   * uses this to compare a retained slot's recorded owner at effect time
   * without putting `slots` in its deps.
   */
  getSlot: (key: string) => IframeSlot | undefined;
}

/**
 * Iframe pool: retains one iframe per (session, port) slot, keyed by
 * `${sessionId}:${port}`. Only the active slot is visible; background slots
 * keep their iframes mounted so re-attach is instant. LRU eviction past
 * {@link MAX_IFRAME_SLOTS} is the *only* thing that drops a slot — nothing
 * else may evict on its own, because a dropped iframe is a reload the user
 * sees as their preview resetting. (A merged PR used to prune its session's
 * background slot; it bought nothing — container reclamation is driven by
 * viewers and agent turns, not by a mounted iframe — and reliably destroyed
 * exactly the preview the user came back to.)
 *
 * There are exactly two documented exceptions, and both are cases where the
 * retained document is already forfeit rather than judgements about when a
 * preview is "worth" keeping.
 *
 * 1. **planning#394** — `usePreviewSlot` drops a slot whose port has been taken
 *    over by a *different service*. The key is `${sessionId}:${port}`, so a port
 *    that moves to a new owner reuses the key, and the retained iframe would
 *    keep serving the previous owner's already-loaded document under the new
 *    owner's row.
 * 2. **planning#496** — `PreviewFrame` drops a session's slots
 *    ({@link IframePool.dropSessionSlots}) when the server says that session's
 *    previews have STOPPED. Since planning#492 each retained slot holds its own
 *    renderer process, and once the Compose stack is torn down that process is
 *    held for a document whose containers are gone; `PreviewFrame` reloads such
 *    a slot when the services return (planning#478) rather than showing the
 *    stale page, so the retention cannot pay off. Note this is narrower than
 *    "the container was reclaimed": the idle enforcer's tier 1 and the
 *    agent-restart path stop the agent container while deliberately keeping the
 *    preview serving, and the server does not announce those — a slot whose
 *    preview is still live is never touched. The active session is skipped as
 *    well, so this can never drop the iframe the user is looking at.
 *
 * Both drops go through {@link IframePool.dropSlot}, which is also what LRU
 * eviction uses, so there is one removal routine and two narrow exceptions —
 * not a second eviction policy. No other caller: for every other purpose a
 * dropped slot is the destroyed preview the paragraph above forbids. In
 * particular, note what the reverted prune got wrong — it fired on PR merge,
 * which says nothing at all about whether the preview is still being served.
 *
 * The hook exposes the pool data structures and the mutation operations
 * (`promoteSlot`, `setSlot`, `dropSlot`). Consumers own the rendering — they
 * read `slots`/`slotOrder` and render the iframes themselves. `createdSlotsRef`
 * is shared with `usePreviewSlot` so it can tell a first visit from a revisit.
 */
export function useIframePool(): IframePool {
  const [slots, setSlots] = useState<Map<string, IframeSlot>>(new Map());
  const [slotOrder, setSlotOrder] = useState<string[]>([]);
  // Mirror of `slots`, written only beside it in `setSlot`/`dropSlot`. The
  // slot hook reads a retained slot's recorded owner at effect time through
  // `getSlot`; putting `slots` in its deps would instead re-run the effect on
  // every slot creation — including the takeover recreation it starts itself.
  const slotsRef = useRef<Map<string, IframeSlot>>(new Map());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement | null>>(new Map());
  const createdSlotsRef = useRef<Set<string>>(new Set());
  /** Rebuild count per key — see {@link IframeSlot.generation}. */
  const generationsRef = useRef<Map<string, number>>(new Map());

  /**
   * Remove a slot and its iframe from everything the pool tracks. The ref
   * check makes a repeat drop (React may double-invoke a render, the hook
   * may re-run its effect) a no-op rather than churn.
   */
  const dropSlot = useCallback((key: string) => {
    if (!slotsRef.current.has(key)) return;
    generationsRef.current.set(key, (generationsRef.current.get(key) ?? 0) + 1);
    const updated = new Map(slotsRef.current);
    updated.delete(key);
    slotsRef.current = updated;
    iframeRefs.current.delete(key);
    createdSlotsRef.current.delete(key);
    setSlots(updated);
    setSlotOrder((prev) => prev.filter((k) => k !== key));
  }, []);

  const promoteSlot = useCallback((key: string) => {
    setSlotOrder((prev) => {
      const without = prev.filter((k) => k !== key);
      const next = [key, ...without];
      // Evict oldest slots beyond the cap — through `dropSlot`, so a slot
      // leaving the pool has exactly one cleanup path however it leaves.
      if (next.length > MAX_IFRAME_SLOTS) {
        for (const k of next.slice(MAX_IFRAME_SLOTS)) dropSlot(k);
        return next.slice(0, MAX_IFRAME_SLOTS);
      }
      return next;
    });
  }, [dropSlot]);

  /**
   * Drop every slot for one session — planning#496's exception, whose whole
   * point is that a session's previews die together, so every port goes.
   *
   * Reads from `slotsRef` rather than the reactive `slots`, so the callback
   * identity is stable and a caller can hold it without re-subscribing on every
   * slot change. Routes each removal through {@link dropSlot} so a slot leaving
   * the pool still has exactly one cleanup path.
   */
  const dropSessionSlots = useCallback((sessionId: string) => {
    // Slot keys are `${sessionId}:${port}` and a session id never contains a
    // colon, so the prefix cannot match a different session.
    const prefix = `${sessionId}:`;
    const doomed = [...slotsRef.current.keys()].filter((k) => k.startsWith(prefix));
    for (const key of doomed) dropSlot(key);
    return doomed;
  }, [dropSlot]);

  const setSlot = useCallback((key: string, slot: IframeSlot) => {
    const updated = new Map(slotsRef.current);
    updated.set(key, { ...slot, generation: generationsRef.current.get(key) ?? 0 });
    slotsRef.current = updated;
    setSlots(updated);
  }, []);

  const getSlot = useCallback((key: string) => slotsRef.current.get(key), []);

  return {
    slots,
    slotOrder,
    iframeRefs,
    createdSlotsRef,
    promoteSlot,
    setSlot,
    dropSlot,
    dropSessionSlots,
    getSlot,
  };
}
