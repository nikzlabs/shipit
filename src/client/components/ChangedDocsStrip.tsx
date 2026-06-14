/**
 * ChangedDocsStrip — the PR card's collapsible changed-docs panel (docs/205).
 *
 * Renders the PR's notable changed files (docs + allowlisted config) as compact
 * wrapping chips (Option B). Each chip opens the file inline via the file
 * preview modal — markdown renders as rich HTML, config in Monaco — so the user
 * never detours to the Docs panel or a GitHub tab. The strip drops in below the
 * PR header bar (inside the same card) only when expanded, so a collapsed card
 * keeps the header height unchanged.
 */

import { FileTextIcon, GearSixIcon } from "@phosphor-icons/react";
import type { NotableFileChange } from "../../server/shared/types/github-types.js";
import { useFileStore } from "../stores/file-store.js";
import { ICON_SIZE } from "../design-tokens.js";

const STATUS_WORD: Record<NotableFileChange["status"], string> = {
  M: "Modified",
  A: "New",
  D: "Deleted",
};

/** Status dot color — amber = modified, green = added, red = deleted. */
const STATUS_DOT_CLASS: Record<NotableFileChange["status"], string> = {
  M: "bg-(--color-warning)",
  A: "bg-(--color-success)",
  D: "bg-(--color-error)",
};

function ChangedDocChip({ sessionId, file }: { sessionId: string; file: NotableFileChange }) {
  const isDoc = file.kind === "doc";
  const Icon = isDoc ? FileTextIcon : GearSixIcon;
  const iconColor = isDoc ? "text-(--color-pr)" : "text-(--color-text-link)";

  return (
    <button
      type="button"
      onClick={() => void useFileStore.getState().openPreview(sessionId, file.path)}
      title={`${file.path} · ${STATUS_WORD[file.status]}`}
      className="inline-flex items-center gap-1.5 max-w-full pl-2 pr-2.5 py-1 rounded-full text-xs cursor-pointer text-(--color-text-primary) bg-(--color-bg-tertiary) border border-(--color-border-secondary) hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) transition-colors"
    >
      <Icon size={ICON_SIZE.XS} className={`shrink-0 ${iconColor}`} />
      <span className="truncate">{file.title}</span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT_CLASS[file.status]}`} />
    </button>
  );
}

export function ChangedDocsStrip({
  sessionId,
  notableFiles,
}: {
  sessionId: string;
  notableFiles: NotableFileChange[];
}) {
  if (notableFiles.length === 0) return null;

  return (
    <div className="shrink-0 flex flex-wrap gap-1.5 px-3 sm:px-4 py-2 max-h-33 overflow-y-auto border-b border-(--color-border-primary) bg-(--color-bg-secondary)/45">
      {notableFiles.map((file) => (
        <ChangedDocChip key={file.path} sessionId={sessionId} file={file} />
      ))}
    </div>
  );
}
