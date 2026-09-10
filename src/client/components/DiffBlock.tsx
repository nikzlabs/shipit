import { useState, useMemo } from "react";
import { type Icon, NotePencilIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { highlightCode, languageFromPath } from "../syntax-highlight.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { ICON_SIZE } from "../design-tokens.js";
import { sessionRelativePath } from "../path-utils.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useLazyToolInput } from "../hooks/useLazyToolInput.js";

export interface DiffBlockProps {
  filePath: string;
  oldString?: string;
  newString?: string;
  isWrite?: boolean;
  unifiedDiff?: string;
  label?: string;
  /** Fetch the omitted body on open; requires stats. */
  toolUseId?: string;
  stats?: { added: number; removed: number };
}

export function countLines(text: string): number {
  if (!text) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized ? normalized.split("\n").length : 0;
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function DiffBlock({ filePath, oldString, newString, isWrite, unifiedDiff, label, toolUseId, stats }: DiffBlockProps) {
  const [showModal, setShowModal] = useState(false);
  const isUnified = unifiedDiff !== undefined;
  const sessionId = useSessionStore((s) => s.sessionId);
  const { added, removed } = stats ?? (isUnified
    ? countDiffLines(unifiedDiff)
    : { added: countLines(newString ?? ""), removed: countLines(oldString ?? "") });
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
          {...(stats && toolUseId ? { lazyToolUseId: toolUseId } : {})}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

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

function DiffModal({ filePath, oldString, newString, isWrite, unifiedDiff, verb, lazyToolUseId, onClose }: {
  filePath: string;
  oldString?: string;
  newString?: string;
  isWrite?: boolean;
  unifiedDiff?: string;
  verb: string;
  lazyToolUseId?: string;
  onClose: () => void;
}) {
  const lazy = useLazyToolInput(lazyToolUseId, !!lazyToolUseId);
  const str = (key: string): string | undefined =>
    typeof lazy.input?.[key] === "string" ? lazy.input[key] : undefined;

  const pending = lazy.loading;
  const resolvedOld = str("old_string") ?? oldString;
  const resolvedNew = str("new_string") ?? str("content") ?? newString;

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
    <DialogContent className="w-[min(90vw,56rem)] max-h-[80vh] flex flex-col" aria-label="Diff view">
      <div className="flex items-center px-4 py-3 border-b border-(--color-border-primary)">
        <span className="text-xs font-semibold text-(--color-text-primary) shrink-0">Tool Call</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap break-all mb-4 pb-4 border-b border-(--color-border-secondary)">{verb} {sessionRelativePath(filePath)}</pre>
        {pending ? (
          <div className="text-xs text-(--color-text-secondary) italic" role="status">Loading diff…</div>
        ) : lazy.error ? (
          <div className="text-xs text-(--color-error)" role="status">Couldn&apos;t load this diff.</div>
        ) : unifiedDiff !== undefined ? (
          <UnifiedDiff diff={unifiedDiff} />
        ) : isWrite ? (
          <WriteContent content={resolvedNew ?? ""} filePath={filePath} />
        ) : (
          <EditDiff oldString={resolvedOld} newString={resolvedNew} />
        )}
      </div>
    </DialogContent>
    </Dialog>
  );
}

function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
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
          <div key={i} className={`${cls} pl-[1ch] [text-indent:-1ch]`}>{line || " "}</div>
        );
      })}
    </pre>
  );
}

function EditDiff({ oldString, newString }: { oldString?: string; newString?: string }) {
  const oldLines = oldString ? oldString.split("\n") : [];
  const newLines = newString ? newString.split("\n") : [];

  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="flex bg-(--color-error)/10 text-(--color-error)">
          <span className="select-none opacity-50 mr-2 shrink-0">-</span>
          <span className="min-w-0 flex-1">{line}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="flex bg-(--color-success)/10 text-(--color-success)">
          <span className="select-none opacity-50 mr-2 shrink-0">+</span>
          <span className="min-w-0 flex-1">{line}</span>
        </div>
      ))}
    </pre>
  );
}

function WriteContent({ content, filePath }: { content: string; filePath: string }) {
  const highlighted = useMemo(
    () => (content ? highlightCode(content, languageFromPath(filePath)) : null),
    [content, filePath],
  );

  if (!content) {
    return <div className="text-xs text-(--color-text-secondary) italic">(empty file)</div>;
  }

  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
      {highlighted ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code className="text-(--color-text-primary)">{content}</code>
      )}
    </pre>
  );
}
