

import { create } from "zustand";
import { useSessionStore } from "./session-store.js";
import {
  getSavedActivePresentBySession,
  saveActivePresentBySession,
} from "../utils/local-storage.js";

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

  filePath: string;
  createdAt: string;

  inline?: boolean;

  content?: string;
}

interface PresentationMeta {
  presentId: string;
  mimeType: string;
  title?: string;
  filePath: string;
  createdAt: string;
  inline?: boolean;
}

/**
 * A place inside a presented artifact that a `shipit-present:` pointer asked to
 * be shown (docs/258 req 9). Held in the store rather than passed as a prop
 * because `PresentPane` is only mounted while its tab is selected — the click
 * reveals the tab and the pane picks this up on mount.
 */
export interface PresentLinkTarget {
  presentId: string;

  fragment?: string;

  clickId: number;
}

interface PresentState {
  presentations: Presentation[];
  activePresentIndex: number;

  unseenCount: number;

  galleryOpen: boolean;

  linkTarget: PresentLinkTarget | null;

  addOrReplace: (p: PresentationMeta) => void;

  hydrate: (presentations: PresentationMeta[]) => void;

  setContent: (presentId: string, content: string) => void;

  clear: (presentId?: string) => void;

  setActiveIndex: (index: number) => void;

  setGalleryOpen: (open: boolean) => void;

  focusById: (presentId: string) => boolean;

  focusByPath: (filePath: string) => Presentation | null;

  setLinkTarget: (target: PresentLinkTarget) => void;

  clearLinkTarget: (clickId?: number) => void;

  markSeen: () => void;

  reset: () => void;
}

const initialState = {
  presentations: [] as Presentation[],
  activePresentIndex: 0,
  unseenCount: 0,
  galleryOpen: false,
  linkTarget: null as PresentLinkTarget | null,
};

function normalizeArtifactPath(filePath: string): string {
  return filePath.startsWith("./") ? filePath.slice(2) : filePath;
}

function toEntry(p: PresentationMeta, content?: string): Presentation {
  return {
    presentId: p.presentId,
    mimeType: p.mimeType,
    filePath: p.filePath,
    createdAt: p.createdAt,
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.inline ? { inline: true } : {}),
    ...(content !== undefined ? { content } : {}),
  };
}

export const usePresentStore = create<PresentState>((set) => ({
  ...initialState,

  addOrReplace: (p) =>
    set((s) => {

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

      const priorContent = new Map(
        s.presentations.filter((p) => p.content !== undefined).map((p) => [p.presentId, p.content]),
      );
      const entries = presentations.map((p) => toEntry(p, priorContent.get(p.presentId)));

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
        return { presentations: [], activePresentIndex: 0, unseenCount: 0, galleryOpen: false, linkTarget: null };
      }
      const idx = s.presentations.findIndex((p) => p.presentId === presentId);
      if (idx < 0) return s;
      const next = s.presentations.filter((p) => p.presentId !== presentId);

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

  focusByPath: (filePath): Presentation | null => {
    const presentations: Presentation[] = usePresentStore.getState().presentations;
    const idx = presentations.findIndex((p) => normalizeArtifactPath(p.filePath) === filePath);
    if (idx < 0) return null;
    rememberActive(presentations[idx].presentId);
    set({ activePresentIndex: idx, unseenCount: 0, galleryOpen: false });
    return presentations[idx];
  },

  setLinkTarget: (linkTarget) => set({ linkTarget }),

  clearLinkTarget: (clickId) =>
    set((s) => (
      clickId === undefined || s.linkTarget?.clickId === clickId ? { linkTarget: null } : s
    )),

  markSeen: () => set({ unseenCount: 0 }),

  reset: () => set({ ...initialState }),
}));
