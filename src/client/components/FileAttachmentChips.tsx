import { FileIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";

export interface FileChipItem {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FileAttachmentChipsProps {
  files: FileChipItem[];
  onRemove: (index: number) => void;
}

export function FileAttachmentChips({ files, onRemove }: FileAttachmentChipsProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap" data-testid="file-attachment-chips">
      {files.map((f, i) => {
        const fileName = f.path.split("/").pop() ?? f.path;
        const lineRange = f.startLine && f.endLine ? `L${f.startLine}-${f.endLine}` : null;
        const displayPath = f.path.length > 40 ? `...${  f.path.slice(-37)}` : f.path;

        return (
          <span
            key={`${f.path}-${f.startLine ?? 0}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded text-xs text-(--color-text-primary) max-w-[200px]"
            title={f.path}
          >
            <FileIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-secondary)" />
            <span className="truncate" data-testid="file-chip-name">{displayPath}</span>
            {lineRange && (
              <span className="text-(--color-text-tertiary) shrink-0" data-testid="file-chip-range">{lineRange}</span>
            )}
            <button
              onClick={() => onRemove(i)}
              className="ml-0.5 text-(--color-text-tertiary) hover:text-(--color-text-primary) shrink-0"
              aria-label={`Remove ${fileName}`}
              title={`Remove ${fileName}`}
            >
              &times;
            </button>
          </span>
        );
      })}
    </div>
  );
}
