import { FileIcon, CircleNotchIcon, WarningCircleIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { UploadItem } from "../hooks/useFileUpload.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FileUploadChipsProps {
  uploads: UploadItem[];
  onRemove: (index: number) => void;
  onRetry: (index: number) => void;
}

export function FileUploadChips({ uploads, onRemove, onRetry }: FileUploadChipsProps) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap" data-testid="file-upload-chips">
      {uploads.map((u, i) => (
        <span
          key={u.id}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs max-w-[220px] border ${
            u.status === "error"
              ? "bg-red-950/30 border-red-800/40 text-red-300"
              : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-primary)"
          }`}
          title={u.status === "error" ? u.error : u.name}
        >
          {/* Icon based on status */}
          {u.status === "uploading" && (
            <CircleNotchIcon size={ICON_SIZE.XS} className="shrink-0 animate-spin text-(--color-text-secondary)" />
          )}
          {u.status === "ready" && (
            <FileIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-secondary)" />
          )}
          {u.status === "error" && (
            <WarningCircleIcon size={ICON_SIZE.XS} className="shrink-0 text-red-400" />
          )}

          {/* Filename — clickable to preview for ready uploads */}
          {u.status === "ready" && u.path ? (
            <button
              className="truncate hover:underline cursor-pointer"
              data-testid="upload-chip-name"
              onClick={() => {
                const sid = useSessionStore.getState().sessionId;
                if (sid && u.path) void useFileStore.getState().openPreview(sid, u.path);
              }}
              title={`Preview ${u.name}`}
            >
              {u.name}
            </button>
          ) : (
            <span className="truncate" data-testid="upload-chip-name">{u.name}</span>
          )}

          {/* Size (ready state) */}
          {u.status === "ready" && u.size !== undefined && (
            <span className="text-(--color-text-tertiary) shrink-0">{formatSize(u.size)}</span>
          )}

          {/* Progress (uploading state) */}
          {u.status === "uploading" && (
            <span className="text-(--color-text-tertiary) shrink-0">{u.progress}%</span>
          )}

          {/* Retry button (error state) */}
          {u.status === "error" && (
            <button
              onClick={() => onRetry(i)}
              className="ml-0.5 text-red-400 hover:text-red-300 shrink-0"
              aria-label={`Retry ${u.name}`}
              title="Retry"
            >
              <ArrowClockwiseIcon size={ICON_SIZE.XS} />
            </button>
          )}

          {/* Remove button (ready and error states) */}
          {u.status !== "uploading" && (
            <button
              onClick={() => onRemove(i)}
              className="ml-0.5 text-(--color-text-tertiary) hover:text-(--color-text-primary) shrink-0"
              aria-label={`Remove ${u.name}`}
              title={`Remove ${u.name}`}
            >
              &times;
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
