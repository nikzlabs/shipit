/**
 * DiffBlock — renders a compact inline file change summary in the chat.
 *
 * Shows a one-line summary with the file path and a colored diff stat
 * like "+40 -12" (green for additions, red for removals).
 * The stats are clickable and open a modal showing the full diff.
 */

import { useState, useMemo } from "react";
import { XIcon } from "@phosphor-icons/react";
import hljs from "highlight.js";
import { Modal } from "./ui/modal.js";
import { sessionRelativePath } from "../path-utils.js";

export interface DiffBlockProps {
  filePath: string;
  oldString?: string;
  newString?: string;
  /** When true, the entire content is a new file write (no old content). */
  isWrite?: boolean;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function DiffBlock({ filePath, oldString, newString, isWrite }: DiffBlockProps) {
  const [showModal, setShowModal] = useState(false);
  const removed = countLines(oldString ?? "");
  const added = countLines(newString ?? "");
  const hasContent = added > 0 || removed > 0;

  return (
    <>
      <div className="mt-1 flex items-center gap-2 text-xs font-mono text-(--color-text-tertiary) pl-[1em] opacity-70 border-l-2 border-(--color-text-tertiary)/40">
        <span className="text-(--color-text-secondary)">{isWrite ? "Write" : "Edit"}</span>
        <span className="text-(--color-text-primary) truncate">{sessionRelativePath(filePath)}</span>
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
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function DiffModal({ filePath, oldString, newString, isWrite, onClose }: {
  filePath: string;
  oldString?: string;
  newString?: string;
  isWrite?: boolean;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} className="w-[min(90vw,56rem)] max-h-[80vh] flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border-primary)">
        <span className="text-xs font-semibold text-(--color-text-primary) shrink-0">Tool Call</span>
        <button
          onClick={onClose}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors shrink-0 cursor-pointer"
          aria-label="Close"
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap break-all mb-4 pb-4 border-b border-(--color-border-secondary)">{isWrite ? "Write" : "Edit"} {sessionRelativePath(filePath)}</pre>
        {isWrite ? (
          <WriteContent content={newString ?? ""} />
        ) : (
          <EditDiff oldString={oldString} newString={newString} />
        )}
      </div>
    </Modal>
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
