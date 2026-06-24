/**
 * present-store — agent-emitted presentations (docs/093).
 *
 * Backs the Present tab in the right panel: an ordered list of artifacts the
 * agent showed via the `present` MCP tool, with a single "active" entry shown
 * at a time. Entries are METADATA only — the artifact bytes (`content`) are
 * fetched lazily by the Present pane from the authenticated session API and
 * cached back onto the entry via `setContent`. `presentId` is content-addressed
 * by the file path, so a `present_content` whose id is already known means the
 * same file was re-presented (the screenshot iteration loop) → refresh that
 * entry in place and drop its cached bytes so the pane refetches; a new id
 * appends + activates. `present_cleared` drops one entry by id or wipes the list
 * (session switch / full clear).
 *
 * Nothing is persisted across browser refresh — the list rehydrates from the
 * orchestrator's `present_state` replay (metadata), and the pane re-fetches the
 * bytes from disk on demand. The server retains no artifact bytes.
 */

import { create } from "zustand";
import { useSessionStore } from "./session-store.js";
import {
  getSavedActivePresentBySession,
  saveActivePresentBySession,
} from "../utils/local-storage.js";

/**
 * The artifact the user last viewed, keyed by session id. Lives OUTSIDE the
 * store state on purpose: `reset()` fires on every session switch and wipes the
 * list, so a position kept in state would be lost — exactly the bug this fixes.
 * Keyed by the content-addressed `presentId` (not a numeric index, which shifts
 * as artifacts append or clear). `hydrate` runs on every switch / late tab open
 * and restores the remembered entry instead of snapping back to the first one.
 *
 * Seeded from / written through to localStorage so the position survives a full
 * page reload too — browser-local view state (may differ across devices), not
 * server-persisted. A stale entry (artifact since gone) is harmless: `hydrate`
 * falls back to clamping when the id isn't found. Forgotten on a full clear.
 */
const lastViewedBySession = new Map<string, string>(
  Object.entries(getSavedActivePresentBySession()),
);

function persistLastViewed(): void {
  saveActivePresentBySession(Object.fromEntries(lastViewedBySession));
}

function rememberActive(presentId: string | undefined): void {
  const sessionId = useSessionStore.getState().sessionId;
  if (sessionId && presentId && lastViewedBySession.get(sessionId) !== presentId) {
    lastViewedBySession.set(sessionId, presentId);
    persistLastViewed();
  }
}

export interface Presentation {
  presentId: string;
  mimeType: string;
  title?: string;
  /** Path the agent presented — shown in the Present tab header. */
  filePath: string;
  createdAt: string;
  /**
   * Lazily-fetched artifact bytes (a `data:` URI for binary images, raw text
   * for HTML/SVG/markdown). `undefined` until the pane fetches it; cached here
   * so re-selecting the entry doesn't refetch.
   */
  content?: string;
}

/** The metadata carried by a `present_content` / `present_state` message. */
interface PresentationMeta {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
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
  /** True while the thumbnail gallery (all artifacts) is shown instead of one. */
  galleryOpen: boolean;

  /** Apply a `present_content` WS message (metadata). */
  addOrReplace: (p: PresentationMeta) => void;
  /**
   * Apply a `present_state` WS message — a full metadata snapshot replayed on
   * viewer attach. Replaces the list wholesale WITHOUT bumping the unseen badge
   * or auto-switching the panel (it's a silent sync). Already-fetched `content`
   * is preserved for ids that survive, so a reconnect doesn't refetch.
   */
  hydrate: (presentations: PresentationMeta[]) => void;
  /** Cache fetched bytes onto an entry (no-op if the id is gone). */
  setContent: (presentId: string, content: string) => void;
  /** Apply a `present_cleared` WS message. `presentId` undefined → wipe all. */
  clear: (presentId?: string) => void;
  /** Switch the visible entry (carousel navigation, click handler). */
  setActiveIndex: (index: number) => void;
  /** Open/close the thumbnail gallery (the "view all" grid). */
  setGalleryOpen: (open: boolean) => void;
  /** Focus a specific presentation by id. Returns false when it is not loaded. */
  focusById: (presentId: string) => boolean;
  /** Mark the user as having seen current presentations (clears the badge). */
  markSeen: () => void;
  /** Drop everything — used on session switch by `resetSessionState`. */
  reset: () => void;
}

const initialState = {
  presentations: [] as Presentation[],
  activePresentIndex: 0,
  unseenCount: 0,
  galleryOpen: false,
};

/** Build a metadata entry (no content yet). */
function toEntry(p: PresentationMeta, content?: string): Presentation {
  return {
    presentId: p.presentId,
    mimeType: p.mimeType,
    filePath: p.filePath,
    createdAt: p.createdAt,
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

export const usePresentStore = create<PresentState>((set) => ({
  ...initialState,

  addOrReplace: (p) =>
    set((s) => {
      // Known id → the same file (presentId is content-addressed by path).
      // Refresh in place, keeping its carousel slot. Drop cached bytes so the
      // pane refetches the edited file — UNLESS this is a true re-delivery of the
      // same event (identical createdAt, e.g. a WS reconnect replay), where the
      // bytes are unchanged and worth preserving to avoid a needless refetch.
      const idx = s.presentations.findIndex((q) => q.presentId === p.presentId);
      if (idx >= 0) {
        const prior = s.presentations[idx];
        const isReplay = prior.createdAt === p.createdAt;
        const next = [...s.presentations];
        next[idx] = toEntry(p, isReplay ? prior.content : undefined);
        rememberActive(p.presentId);
        return {
          presentations: next,
          activePresentIndex: idx,
          unseenCount: s.unseenCount + 1,
        };
      }

      // Brand-new entry — append + activate so the user sees the latest.
      const presentations = [...s.presentations, toEntry(p)];
      rememberActive(p.presentId);
      return {
        presentations,
        activePresentIndex: presentations.length - 1,
        unseenCount: s.unseenCount + 1,
      };
    }),

  hydrate: (presentations) =>
    set((s) => {
      // Preserve already-fetched bytes for ids that survive the snapshot, so a
      // WS reconnect (browser still holds content) doesn't trigger a refetch.
      const priorContent = new Map(
        s.presentations.filter((p) => p.content !== undefined).map((p) => [p.presentId, p.content]),
      );
      const entries = presentations.map((p) => toEntry(p, priorContent.get(p.presentId)));
      // Restore the artifact the user was last viewing in THIS session (keyed by
      // the stable presentId) so a session switch / late tab open lands them
      // where they left off instead of snapping back to the first artifact.
      // Fall back to the clamped current index when nothing is remembered or the
      // remembered entry is gone.
      let activePresentIndex: number;
      if (entries.length === 0) {
        activePresentIndex = 0;
      } else {
        const sessionId = useSessionStore.getState().sessionId;
        const remembered = sessionId ? lastViewedBySession.get(sessionId) : undefined;
        const rememberedIdx = remembered
          ? entries.findIndex((e) => e.presentId === remembered)
          : -1;
        activePresentIndex =
          rememberedIdx >= 0
            ? rememberedIdx
            : Math.max(0, Math.min(s.activePresentIndex, entries.length - 1));
      }
      return { presentations: entries, activePresentIndex };
    }),

  setContent: (presentId, content) =>
    set((s) => {
      const idx = s.presentations.findIndex((p) => p.presentId === presentId);
      if (idx < 0) return s;
      const next = [...s.presentations];
      next[idx] = { ...next[idx], content };
      return { presentations: next };
    }),

  clear: (presentId) =>
    set((s) => {
      if (presentId === undefined) {
        const sessionId = useSessionStore.getState().sessionId;
        if (sessionId && lastViewedBySession.delete(sessionId)) persistLastViewed();
        return { presentations: [], activePresentIndex: 0, unseenCount: 0, galleryOpen: false };
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
      rememberActive(s.presentations[clamped]?.presentId);
      return { activePresentIndex: clamped };
    }),

  setGalleryOpen: (open) => set({ galleryOpen: open }),

  focusById: (presentId) => {
    const idx = usePresentStore.getState().presentations.findIndex((p) => p.presentId === presentId);
    if (idx < 0) return false;
    rememberActive(presentId);
    set({ activePresentIndex: idx, unseenCount: 0 });
    return true;
  },

  markSeen: () => set({ unseenCount: 0 }),

  reset: () => set({ ...initialState }),
}));
