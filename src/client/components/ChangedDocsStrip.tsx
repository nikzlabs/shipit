import { FileTextIcon, GearSixIcon, ImageIcon, CircleDashedIcon } from "@phosphor-icons/react";
import type { NotableFileChange } from "../../server/shared/types/github-types.js";
import type { IssueChipRef, IssueIntent } from "../utils/pr-card-issue-refs.js";
import { useFileStore } from "../stores/file-store.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { ICON_SIZE } from "../design-tokens.js";

const STATUS_WORD: Record<NotableFileChange["status"], string> = {
  M: "Modified",
  A: "New",
  D: "Deleted",
};

const STATUS_DOT_CLASS: Record<NotableFileChange["status"], string> = {
  M: "bg-(--color-warning)",
  A: "bg-(--color-success)",
  D: "bg-(--color-error)",
};

const INTENT_LABEL: Record<IssueIntent, string> = {
  closes: "Closes",
  refs: "Refs",
  origin: "From session",
};
const INTENT_VERB_CLASS: Record<IssueIntent, string> = {
  closes: "text-(--color-success)",
  refs: "text-(--color-text-tertiary)",
  origin: "text-(--color-pr)",
};

const KIND_ICON: Record<NotableFileChange["kind"], typeof FileTextIcon> = {
  doc: FileTextIcon,
  config: GearSixIcon,
  image: ImageIcon,
};
const KIND_ICON_CLASS: Record<NotableFileChange["kind"], string> = {
  doc: "text-(--color-pr)",
  config: "text-(--color-text-link)",
  image: "text-(--color-text-link)",
};

function ChangedDocChip({ sessionId, file }: { sessionId: string; file: NotableFileChange }) {
  const Icon = KIND_ICON[file.kind];
  const iconColor = KIND_ICON_CLASS[file.kind];

  return (
    <button
      type="button"
      onClick={() => void useFileStore.getState().openPreview(sessionId, file.path)}
      title={`${file.path} · ${STATUS_WORD[file.status]}`}
      className="inline-flex items-center gap-1.5 max-w-full pl-2 pr-2.5 py-1 rounded-full text-xs cursor-pointer text-(--color-text-primary) bg-(--color-bg-tertiary) border border-(--color-border-secondary) hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) transition-colors"
    >
      <Icon size={ICON_SIZE.XS} className={`shrink-0 ${iconColor}`} />
      <span className="truncate">{file.label}</span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT_CLASS[file.status]}`} />
    </button>
  );
}

function PrCardIssueChip({ chip }: { chip: IssueChipRef }) {
  const label = INTENT_LABEL[chip.intent];
  const borderClass =
    chip.intent === "closes"
      ? "border-(--color-success-border) bg-(--color-success-subtle)"
      : chip.intent === "origin"
        ? "border-dashed border-(--color-border-secondary) bg-(--color-bg-tertiary)"
        : "border-(--color-border-secondary) bg-(--color-bg-tertiary)";
  const base = `inline-flex items-center gap-1.5 max-w-full pl-2 pr-2.5 py-1 rounded-full text-xs border ${borderClass}`;
  const title = `${label} ${chip.identifier}`;

  const inner = (
    <>
      <CircleDashedIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-tertiary)" />
      <span className={`text-[10px] font-bold uppercase tracking-wide shrink-0 ${INTENT_VERB_CLASS[chip.intent]}`}>
        {label}
      </span>
      <span className="truncate font-medium tabular-nums text-(--color-text-primary)">{chip.identifier}</span>
    </>
  );

  if (chip.tracker) {
    const tracker = chip.tracker;
    return (
      <button
        type="button"
        title={`Open ${chip.identifier} in ShipIt`}
        onClick={() => {
          useUiStore.getState().setRightTab("issues");
          useUiStore.getState().setMobilePanel("preview");
          void useIssuesStore.getState().openIssue({
            tracker,
            identifier: chip.identifier,
            ...(chip.issueId ? { id: chip.issueId } : {}),
            ...(chip.url ? { url: chip.url } : {}),
          });
        }}
        className={`${base} cursor-pointer hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) transition-colors`}
      >
        {inner}
      </button>
    );
  }

  if (chip.url) {
    return (
      <a
        href={chip.url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className={`${base} cursor-pointer hover:border-(--color-text-tertiary) hover:bg-(--color-bg-hover) transition-colors`}
      >
        {inner}
      </a>
    );
  }

  return <span className={base} title={title}>{inner}</span>;
}

export function ChangedDocsStrip({
  sessionId,
  notableFiles,
  issueRefs = [],
}: {
  sessionId: string;
  notableFiles: NotableFileChange[];
  issueRefs?: IssueChipRef[];
}) {
  if (notableFiles.length === 0 && issueRefs.length === 0) return null;

  const showDivider = issueRefs.length > 0 && notableFiles.length > 0;

  return (
    <div className="shrink-0 flex flex-wrap gap-1.5 px-3 sm:px-4 pb-2 max-h-33 overflow-y-auto border-b border-(--color-border-primary)">
      {issueRefs.map((chip) => (
        <PrCardIssueChip key={`${chip.tracker}:${chip.issueId ?? chip.identifier}`} chip={chip} />
      ))}
      {showDivider && (
        <span className="self-stretch w-px bg-(--color-border-secondary) mx-0.5" aria-hidden="true" />
      )}
      {notableFiles.map((file) => (
        <ChangedDocChip key={file.path} sessionId={sessionId} file={file} />
      ))}
    </div>
  );
}
