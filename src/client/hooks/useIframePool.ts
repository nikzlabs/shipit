import { useState, useRef, useCallback } from "react";

/** Maximum number of retained iframes across all sessions and ports. */
export const MAX_IFRAME_SLOTS = 20;

export interface IframeSlot {
  url: string;
  containerMode: boolean;
  /**
   * The Compose service that owned this slot's port when the slot was
   * created (planning#394) — the same `services.find(s => s.port === port)`
   * derivation the toolbar label uses. `undefined` for a preview with no
   * service row (a local dev server) or one created before the service list
   * arrived. The health poller compares it with the port's current owner and
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
  /** Set of slot keys that have already been created (poll has succeeded). */
  createdSlotsRef: React.RefObject<Set<string>>;
  /** Set of slot keys currently being polled — used to avoid duplicate polls. */
  pollingRef: React.RefObject<Set<string>>;
  /** Promote a slot to the front of the LRU and evict oldest if over capacity. */
  promoteSlot: (key: string) => void;
  /** Add or update a slot with the given URL/containerMode metadata. */
  setSlot: (key: string, slot: IframeSlot) => void;
  /**
   * Remove one slot and its iframe from the pool. Health-poller use only —
   * see the hook docstring for why nothing else may call this.
   */
  dropSlot: (key: string) => void;
  /**
   * Read a slot outside the render cycle (stable identity). The health
   * poller uses this to compare a retained slot's recorded owner at effect
   * time without putting `slots` in its deps.
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
 * There is exactly one documented exception (planning#394): the health
 * poller drops a slot whose port has been taken over by a *different
 * service* — the key is `${sessionId}:${port}`, so a port that moves to a
 * new owner reuses the key, and the retained iframe would keep serving the
 * previous owner's already-loaded document under the new owner's row. That
 * drop goes through {@link IframePool.dropSlot}, which is also what LRU
 * eviction uses, so there is one removal routine and one narrow exception —
 * not a second eviction policy. No other caller: for every other purpose a
 * dropped slot is the destroyed preview the paragraph above forbids.
 *
 * The hook exposes the pool data structures and the mutation operations
 * (`promoteSlot`, `setSlot`, `dropSlot`). Consumers own the rendering — they
 * read `slots`/`slotOrder` and render the iframes themselves. The two refs
 * (`createdSlotsRef`, `pollingRef`) are shared with the health-poll hook
 * so it can coordinate slot creation without re-polling.
 */
export function useIframePool(): IframePool {
  const [slots, setSlots] = useState<Map<string, IframeSlot>>(new Map());
  const [slotOrder, setSlotOrder] = useState<string[]>([]);
  // Mirror of `slots`, written only beside it in `setSlot`/`dropSlot`. The
  // health poller reads a retained slot's recorded owner at effect time
  // through `getSlot`; putting `slots` in its deps would instead re-run the
  // poll effect on every slot creation — and cancel-and-restart the very
  // takeover poll the ownership drop starts.
  const slotsRef = useRef<Map<string, IframeSlot>>(new Map());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement | null>>(new Map());
  const createdSlotsRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef<Set<string>>(new Set());

  /**
   * Remove a slot and its iframe from everything the pool tracks. The ref
   * check makes a repeat drop (React may double-invoke a render, the poller
   * may re-run its effect) a no-op rather than churn.
   */
  const dropSlot = useCallback((key: string) => {
    if (!slotsRef.current.has(key)) return;
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
    updated.set(key, slot);
    slotsRef.current = updated;
    setSlots(updated);
  }, []);

  const getSlot = useCallback((key: string) => slotsRef.current.get(key), []);

  return {
    slots,
    slotOrder,
    iframeRefs,
    createdSlotsRef,
    pollingRef,
    promoteSlot,
    setSlot,
    dropSlot,
    getSlot,
  };
}
