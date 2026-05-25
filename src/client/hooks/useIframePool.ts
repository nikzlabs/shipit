import { useState, useRef, useCallback } from "react";

/** Maximum number of retained iframes across all sessions and ports. */
export const MAX_IFRAME_SLOTS = 20;

export interface IframeSlot {
  url: string;
  containerMode: boolean;
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
  /** Remove slots matching a predicate and clear their tracking refs. */
  pruneSlots: (shouldRemove: (key: string) => boolean) => void;
}

/**
 * Iframe pool: retains one iframe per (session, port) slot, keyed by
 * `${sessionId}:${port}`. Only the active slot is visible; background slots
 * keep their iframes mounted so re-attach is instant. LRU eviction keeps the
 * pool from growing without bound across many sessions/ports.
 *
 * The hook exposes the pool data structures and the two mutation operations
 * (`promoteSlot`, `setSlot`). Consumers own the rendering — they read
 * `slots`/`slotOrder` and render the iframes themselves. The two refs
 * (`createdSlotsRef`, `pollingRef`) are shared with the health-poll hook
 * so it can coordinate slot creation without re-polling.
 */
export function useIframePool(): IframePool {
  const [slots, setSlots] = useState<Map<string, IframeSlot>>(new Map());
  const [slotOrder, setSlotOrder] = useState<string[]>([]);
  const iframeRefs = useRef<Map<string, HTMLIFrameElement | null>>(new Map());
  const createdSlotsRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef<Set<string>>(new Set());

  const promoteSlot = useCallback((key: string) => {
    setSlotOrder((prev) => {
      const without = prev.filter((k) => k !== key);
      const next = [key, ...without];
      // Evict oldest slots beyond the cap
      if (next.length > MAX_IFRAME_SLOTS) {
        const evicted = next.slice(MAX_IFRAME_SLOTS);
        setSlots((s) => {
          const updated = new Map(s);
          for (const k of evicted) {
            updated.delete(k);
            iframeRefs.current.delete(k);
            createdSlotsRef.current.delete(k);
          }
          return updated;
        });
        return next.slice(0, MAX_IFRAME_SLOTS);
      }
      return next;
    });
  }, []);

  const setSlot = useCallback((key: string, slot: IframeSlot) => {
    setSlots((prev) => {
      const updated = new Map(prev);
      updated.set(key, slot);
      return updated;
    });
  }, []);

  const pruneSlots = useCallback((shouldRemove: (key: string) => boolean) => {
    const removed = new Set<string>();
    setSlotOrder((prev) => {
      const next = prev.filter((key) => {
        if (!shouldRemove(key)) return true;
        removed.add(key);
        return false;
      });
      return next.length === prev.length ? prev : next;
    });
    if (removed.size === 0) return;
    setSlots((prev) => {
      const updated = new Map(prev);
      for (const key of removed) {
        updated.delete(key);
        iframeRefs.current.delete(key);
        createdSlotsRef.current.delete(key);
        pollingRef.current.delete(key);
      }
      return updated;
    });
  }, []);

  return {
    slots,
    slotOrder,
    iframeRefs,
    createdSlotsRef,
    pollingRef,
    promoteSlot,
    setSlot,
    pruneSlots,
  };
}
