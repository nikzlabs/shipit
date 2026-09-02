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
 * There is exactly one documented exception (planning#394):
 * `usePreviewSlot` drops a slot whose port has been taken over by a
 * *different service* — the key is `${sessionId}:${port}`, so a port that moves to a
 * new owner reuses the key, and the retained iframe would keep serving the
 * previous owner's already-loaded document under the new owner's row. That
 * drop goes through {@link IframePool.dropSlot}, which is also what LRU
 * eviction uses, so there is one removal routine and one narrow exception —
 * not a second eviction policy. No other caller: for every other purpose a
 * dropped slot is the destroyed preview the paragraph above forbids.
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
    getSlot,
  };
}
