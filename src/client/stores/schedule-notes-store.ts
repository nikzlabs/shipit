import { create } from "zustand";
import type { ScheduleNoteContent, ScheduleRunNotes } from "../../server/shared/types.js";

export interface ScheduleNotesTarget {
  scheduleId: string;
  runId: string;
}

export type ScheduleNotesLoad<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

interface ScheduleNotesState {
  /** The run whose notes the viewer shows; null while it is closed. */
  target: ScheduleNotesTarget | null;
  notes: ScheduleNotesLoad<ScheduleRunNotes> | null;
  selectedPath: string | null;
  file: ScheduleNotesLoad<ScheduleNoteContent> | null;
  open: (target: ScheduleNotesTarget) => void;
  close: () => void;
  selectFile: (path: string) => void;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // No JSON body: the status text stands.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function notesPath({ scheduleId, runId }: ScheduleNotesTarget): string {
  return `/api/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/notes`;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * docs/324-scheduled-sessions req 27 — the read-only notes viewer's state. Every response is
 * dropped unless the viewer still shows the run (and file) it was asked for, so a slow answer
 * cannot overwrite a newer choice.
 */
export const useScheduleNotesStore = create<ScheduleNotesState>((set, get) => {
  const loadFile = async (target: ScheduleNotesTarget, path: string) => {
    set({ selectedPath: path, file: { status: "loading" } });
    const current = () => get().target === target && get().selectedPath === path;
    try {
      const { file } = await getJson<{ file: ScheduleNoteContent }>(
        `${notesPath(target)}/file?path=${encodeURIComponent(path)}`,
      );
      if (current()) set({ file: { status: "ready", value: file } });
    } catch (err) {
      if (current()) set({ file: { status: "error", message: messageOf(err) } });
    }
  };

  return {
    target: null,
    notes: null,
    selectedPath: null,
    file: null,

    open: (requested) => {
      const target = { ...requested };
      set({ target, notes: { status: "loading" }, selectedPath: null, file: null });
      void (async () => {
        let notes: ScheduleRunNotes;
        try {
          ({ notes } = await getJson<{ notes: ScheduleRunNotes }>(notesPath(target)));
        } catch (err) {
          if (get().target === target) set({ notes: { status: "error", message: messageOf(err) } });
          return;
        }
        if (get().target !== target) return;
        set({ notes: { status: "ready", value: notes } });
        const first = notes.files[0];
        if (first) await loadFile(target, first.path);
      })();
    },

    // The rest stays so the closing dialog does not blank out; the next open replaces it.
    close: () => set({ target: null }),

    selectFile: (path) => {
      const { target, selectedPath, file } = get();
      if (!target || (path === selectedPath && file?.status !== "error")) return;
      void loadFile(target, path);
    },
  };
});

/** Opens the notes viewer on one run, from anywhere in the client. */
export function openScheduleNotes(scheduleId: string, runId: string): void {
  useScheduleNotesStore.getState().open({ scheduleId, runId });
}
