import type { ReactNode } from "react";
import { FileIcon, FileTextIcon } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { MarkdownContent } from "./message-markdown.js";
import { ICON_SIZE } from "../design-tokens.js";
import { formatBytes } from "../utils/format-bytes.js";
import { useScheduleNotesStore, type ScheduleNotesLoad } from "../stores/schedule-notes-store.js";
import type { ScheduleNoteContent, ScheduleRunNotes } from "../../server/shared/types.js";

const MARKDOWN_PATH = /\.(md|markdown)$/i;

function formatRunAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="p-5 text-sm text-(--color-text-tertiary)">{children}</p>;
}

function FileBody({ file }: { file: ScheduleNotesLoad<ScheduleNoteContent> | null }) {
  if (!file || file.status === "loading") return <Muted>Loading…</Muted>;
  if (file.status === "error") {
    return <p role="alert" className="p-5 text-sm text-(--color-error)">{file.message}</p>;
  }
  const { path, size, text, truncated } = file.value;
  return (
    <div className="p-5" data-testid="schedule-notes-file">
      {text === undefined ? (
        <div className="flex items-start gap-2 text-sm">
          <FileIcon size={ICON_SIZE.MD} className="shrink-0 text-(--color-text-tertiary)" aria-hidden />
          <div className="min-w-0">
            <div className="break-all text-(--color-text-primary)">{path}</div>
            <div className="text-(--color-text-secondary)">{formatBytes(size)} · Not a text file</div>
          </div>
        </div>
      ) : MARKDOWN_PATH.test(path) ? (
        <MarkdownContent text={text} />
      ) : (
        <pre className="font-mono text-(--font-size-code) whitespace-pre-wrap break-words text-(--color-text-primary)">
          {text}
        </pre>
      )}
      {truncated && (
        <p className="mt-4 border-t border-(--color-border-secondary) pt-2 text-xs text-(--color-text-tertiary)">
          Only the start of this file is shown.
        </p>
      )}
    </div>
  );
}

function NotesBody({ notes }: { notes: ScheduleRunNotes }) {
  const selectedPath = useScheduleNotesStore((s) => s.selectedPath);
  const file = useScheduleNotesStore((s) => s.file);
  const selectFile = useScheduleNotesStore((s) => s.selectFile);

  if (notes.files.length === 0) {
    return <Muted>{notes.truncated ? "This run's files lie deeper in its folder than this view lists." : "This run wrote no notes."}</Muted>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="Notes files"
        className="max-h-48 shrink-0 overflow-y-auto border-b border-(--color-border-secondary) md:max-h-none md:w-64 md:border-r md:border-b-0"
      >
        <ul className="py-1">
          {notes.files.map((f) => {
            const selected = f.path === selectedPath;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  title={f.path}
                  onClick={() => selectFile(f.path)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-[color,background-color] duration-(--duration-fast) ${
                    selected
                      ? "bg-(--color-bg-active) text-(--color-text-primary)"
                      : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
                  }`}
                >
                  <FileTextIcon size={ICON_SIZE.SM} className="shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="shrink-0 text-xs text-(--color-text-tertiary)">{formatBytes(f.size)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {notes.truncated && (
          <p className="px-3 pb-2 text-xs text-(--color-text-tertiary)">The folder holds more files than are listed.</p>
        )}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <FileBody file={file} />
      </div>
    </div>
  );
}

/** docs/324-scheduled-sessions req 27 — a run's notes, read-only. Opened with `openScheduleNotes`. */
export function ScheduleNotesViewer() {
  const open = useScheduleNotesStore((s) => s.target !== null);
  const notes = useScheduleNotesStore((s) => s.notes);
  const close = useScheduleNotesStore((s) => s.close);
  const ready = notes?.status === "ready" ? notes.value : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent
        data-testid="schedule-notes-viewer"
        className="flex h-[80vh] w-[min(960px,95vw)] max-w-none flex-col overflow-hidden! p-0"
      >
        <DialogHeader className="flex-col items-start gap-0.5 pr-14">
          <DialogTitle className="text-base">{ready ? ready.scheduleName : "Schedule notes"}</DialogTitle>
          <DialogDescription>{ready ? `Notes of the run at ${formatRunAt(ready.runAt)}` : null}</DialogDescription>
        </DialogHeader>
        {!notes || notes.status === "loading" ? (
          <Muted>Loading…</Muted>
        ) : notes.status === "error" ? (
          <p role="alert" className="p-5 text-sm text-(--color-error)">{notes.message}</p>
        ) : (
          <NotesBody notes={notes.value} />
        )}
      </DialogContent>
    </Dialog>
  );
}
