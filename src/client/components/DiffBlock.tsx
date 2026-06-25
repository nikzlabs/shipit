/**
 * DiffBlock — renders a compact inline file change summary in the chat.
 *
 * Shows a one-line summary with the file path and a colored diff stat
 * like "+40 -12" (green for additions, red for removals).
 * The stats are clickable and open a modal showing the full diff.
 */

import { useState, useMemo } from "react";
import { type Icon, NotePencilIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import hljs from "highlight.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { ICON_SIZE } from "../design-tokens.js";
import { sessionRelativePath } from "../path-utils.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";

export interface DiffBlockProps {
  filePath: string;
  oldString?: string;
  newString?: string;
  /** When true, the entire content is a new file write (no old content). */
  isWrite?: boolean;
  /**
   * A unified-diff string (e.g. Codex's apply_patch). When set, line stats and
   * the modal body are derived from the diff rather than old/new strings.
   */
  unifiedDiff?: string;
  /** Override the leading verb ("Edit"/"Write"); used for Codex change kinds. */
  label?: string;
}

function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n").length : 0;
}

/** Count added/removed lines in a unified diff, ignoring file/hunk headers. */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function DiffBlock({ filePath, oldString, newString, isWrite, unifiedDiff, label }: DiffBlockProps) {
  const [showModal, setShowModal] = useState(false);
  const isUnified = unifiedDiff !== undefined;
  const sessionId = useSessionStore((s) => s.sessionId);
  const { added, removed } = isUnified
    ? countDiffLines(unifiedDiff)
    : { added: countLines(newString ?? ""), removed: countLines(oldString ?? "") };
  const hasContent = added > 0 || removed > 0;
  const verb = label ?? (isWrite ? "Write" : "Edit");
  const relativePath = sessionRelativePath(filePath);
  const openFile = () => {
    if (!sessionId || !relativePath || relativePath === "unknown") return;
    void useFileStore.getState().openPreview(sessionId, relativePath);
  };

  return (
    <>
      <div className="py-1 flex items-center gap-2 text-xs font-mono text-(--color-text-tertiary) pl-[1em] opacity-70 border-l-2 border-(--color-text-tertiary)/40">
        <VerbBadge verb={verb} />
        <button
          type="button"
          onClick={openFile}
          disabled={!sessionId || !relativePath || relativePath === "unknown"}
          className="min-w-0 truncate text-left text-(--color-text-primary) enabled:cursor-pointer enabled:hover:underline disabled:cursor-default"
          aria-label={`Open ${relativePath}`}
        >
          {relativePath}
        </button>
        {hasContent ? (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 shrink-0 hover:underline cursor-pointer"
            aria-label="Show diff"
          >
            {added > 0 && <span className="text-(--color-success)">+{added}</span>}
            {removed > 0 && <span className="text-(--color-error)">-{removed}</span>}
          </button>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-(--color-text-secondary) italic">no changes</span>
          </span>
        )}
      </div>
      {showModal && (
        <DiffModal
          filePath={filePath}
          oldString={oldString}
          newString={newString}
          isWrite={isWrite}
          unifiedDiff={unifiedDiff}
          verb={verb}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

/**
 * The diff-block verb ("Edit"/"Write"/"Delete", or a Codex apply_patch kind) as
 * a glyph rather than a word — the verb moves to the icon's accessible
 * label/tooltip. Verbs we don't have a glyph for fall back to plain text.
 *
 * Deliberately icon-only (no visible word), unlike the inline tool line which
 * shows icon + verb: here the file path and colored +/- stats already anchor
 * the meaning, so the glyph is enough. The verb stays in `aria-label` for
 * screen readers.
 */
const VERB_ICONS: Record<string, Icon> = {
  Edit: PencilSimpleIcon,
  Write: NotePencilIcon,
  Delete: TrashIcon,
};

function VerbBadge({ verb }: { verb: string }) {
  const Glyph = VERB_ICONS[verb];
  if (!Glyph) return <span className="text-(--color-text-secondary)">{verb}</span>;
  return (
    <span
      role="img"
      aria-label={verb}
      title={verb}
      className="inline-flex shrink-0 items-center text-(--color-text-secondary)"
    >
      <Glyph size={ICON_SIZE.SM} />
    </span>
  );
}

function DiffModal({ filePath, oldString, newString, isWrite, unifiedDiff, verb, onClose }: {
  filePath: string;
  oldString?: string;
  newString?: string;
  isWrite?: boolean;
  unifiedDiff?: string;
  verb: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
    <DialogContent className="w-[min(90vw,56rem)] max-h-[80vh] flex flex-col" aria-label="Diff view">
      <div className="flex items-center px-4 py-3 border-b border-(--color-border-primary)">
        <span className="text-xs font-semibold text-(--color-text-primary) shrink-0">Tool Call</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap break-all mb-4 pb-4 border-b border-(--color-border-secondary)">{verb} {sessionRelativePath(filePath)}</pre>
        {unifiedDiff !== undefined ? (
          <UnifiedDiff diff={unifiedDiff} />
        ) : isWrite ? (
          <WriteContent content={newString ?? ""} />
        ) : (
          <EditDiff oldString={oldString} newString={newString} />
        )}
      </div>
    </DialogContent>
    </Dialog>
  );
}

/** Renders a unified diff with per-line coloring (additions, removals, hunks). */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="text-xs font-mono leading-relaxed overflow-x-auto">
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+") && !line.startsWith("+++");
        const isDel = line.startsWith("-") && !line.startsWith("---");
        const isHunk = line.startsWith("@@");
        const cls = isAdd
          ? "bg-(--color-success)/10 text-(--color-success)"
          : isDel
            ? "bg-(--color-error)/10 text-(--color-error)"
            : isHunk
              ? "text-(--color-text-tertiary)"
              : "text-(--color-text-secondary)";
        return (
          <div key={i} className={cls}>{line || " "}</div>
        );
      })}
    </pre>
  );
}

function EditDiff({ oldString, newString }: { oldString?: string; newString?: string }) {
  const oldLines = oldString ? oldString.split("\n") : [];
  const newLines = newString ? newString.split("\n") : [];

  return (
    <pre className="text-xs font-mono leading-relaxed overflow-x-auto">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="bg-(--color-error)/10 text-(--color-error)">
          <span className="select-none opacity-50 mr-2">-</span>{line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="bg-(--color-success)/10 text-(--color-success)">
          <span className="select-none opacity-50 mr-2">+</span>{line}
        </div>
      ))}
    </pre>
  );
}

function WriteContent({ content }: { content: string }) {
  const highlighted = useMemo(() => {
    if (!content) return null;
    try {
      return hljs.highlightAuto(content).value;
    } catch {
      return null;
    }
  }, [content]);

  if (!content) {
    return <div className="text-xs text-(--color-text-secondary) italic">(empty file)</div>;
  }

  return (
    <pre className="text-xs font-mono leading-relaxed overflow-x-auto">
      {highlighted ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code className="text-(--color-text-primary)">{content}</code>
      )}
    </pre>
  );
}
