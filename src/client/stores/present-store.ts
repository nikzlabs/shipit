/**
 * present-store — agent-emitted presentations (docs/093).
 *
 * Backs the Present tab in the right panel: an ordered list of artifacts the
 * agent showed via the `present` MCP tool, with a single "active" entry shown
 * at a time. New `present_content` messages append + activate (or replace
 * in-place when `replaceId` matches). `present_cleared` drops one entry (LRU
 * eviction) or wipes the list (session switch / full clear).
 *
 * Presentations are intentionally NOT persisted across browser refresh —
 * they're ephemeral by design and the server-side buffer is the source of
 * truth. If the user wants to keep one, they hit "Save to project" first.
 */

import { create } from "zustand";

export interface Presentation {
  presentId: string;
  content: string;
  mimeType: string;
  title?: string;
  createdAt: string;
}

interface PresentState {
  presentations: Presentation[];
  activePresentIndex: number;
  /**
   * Set to true when a presentation arrives and the user isn't viewing the
   * Present tab — drives the badge count and the auto-switch-on-first-arrival
   * behavior. Cleared when the tab is focused.
   */
  unseenCount: number;

  /** Apply a `present_content` WS message. */
  addOrReplace: (p: { presentId: string; replaceId?: string; content: string; mimeType: string; title?: string; createdAt: string }) => void;
  /** Apply a `present_cleared` WS message. `presentId` undefined → wipe all. */
  clear: (presentId?: string) => void;
  /** Switch the visible entry (carousel navigation, click handler). */
  setActiveIndex: (index: number) => void;
  /** Mark the user as having seen current presentations (clears the badge). */
  markSeen: () => void;
  /** Drop everything — used on session switch by `resetSessionState`. */
  reset: () => void;
}

const initialState = {
  presentations: [] as Presentation[],
  activePresentIndex: 0,
  unseenCount: 0,
};

export const usePresentStore = create<PresentState>((set) => ({
  ...initialState,

  addOrReplace: (p) =>
    set((s) => {
      // Revision flow: replace in-place if replaceId points at a known entry.
      if (p.replaceId) {
        const idx = s.presentations.findIndex((q) => q.presentId === p.replaceId);
        if (idx >= 0) {
          const next = [...s.presentations];
          next[idx] = {
            presentId: p.presentId,
            content: p.content,
            mimeType: p.mimeType,
            ...(p.title !== undefined ? { title: p.title } : {}),
            createdAt: p.createdAt,
          };
          return {
            presentations: next,
            activePresentIndex: idx,
            unseenCount: s.unseenCount + 1,
          };
        }
      }

      // Brand-new entry — append + activate so the user sees the latest.
      const next: Presentation = {
        presentId: p.presentId,
        content: p.content,
        mimeType: p.mimeType,
        ...(p.title !== undefined ? { title: p.title } : {}),
        createdAt: p.createdAt,
      };
      const presentations = [...s.presentations, next];
      return {
        presentations,
        activePresentIndex: presentations.length - 1,
        unseenCount: s.unseenCount + 1,
      };
    }),

  clear: (presentId) =>
    set((s) => {
      if (presentId === undefined) {
        return { presentations: [], activePresentIndex: 0, unseenCount: 0 };
      }
      const idx = s.presentations.findIndex((p) => p.presentId === presentId);
      if (idx < 0) return s;
      const next = s.presentations.filter((p) => p.presentId !== presentId);
      // Keep the active index pointing at something sane: shift back when we
      // removed at or before the cursor, clamp to bounds.
      let active = s.activePresentIndex;
      if (idx <= active) active = Math.max(0, active - 1);
      if (next.length === 0) active = 0;
      else if (active >= next.length) active = next.length - 1;
      return { presentations: next, activePresentIndex: active };
    }),

  setActiveIndex: (index) =>
    set((s) => {
      if (s.presentations.length === 0) {
        return { activePresentIndex: 0 };
      }
      const clamped = Math.max(0, Math.min(index, s.presentations.length - 1));
      return { activePresentIndex: clamped };
    }),

  markSeen: () => set({ unseenCount: 0 }),

  reset: () => set({ ...initialState }),
}));
