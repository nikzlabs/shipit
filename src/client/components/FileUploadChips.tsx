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

/** Render an image upload as a thumbnail with overlay controls. */
function ImageThumbnail({ u, index, onRemove }: { u: UploadItem; index: number; onRemove: (i: number) => void }) {
  return (
    <div className="relative group" title={u.name}>
      <img
        src={u.previewUrl}
        alt={u.name}
        className="w-16 h-16 object-cover rounded-md border border-(--color-border-secondary)"
      />
      {u.status === "uploading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-md">
          <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-white" />
        </div>
      )}
      {u.status !== "uploading" && (
        <button
          onClick={() => onRemove(index)}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-(--color-error) text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label={`Remove ${u.name}`}
          title={`Remove ${u.name}`}
        >
          &times;
        </button>
      )}
    </div>
  );
}

/** Render a non-image upload as a text chip. */
function FileChip({ u, index, onRemove, onRetry }: { u: UploadItem; index: number; onRemove: (i: number) => void; onRetry: (i: number) => void }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs max-w-[220px] border ${
        u.status === "error"
          ? "bg-red-950/30 border-red-800/40 text-red-300"
          : "bg-(--color-bg-secondary) border-(--color-border-secondary) text-(--color-text-primary)"
      }`}
      title={u.status === "error" ? u.error : u.name}
    >
      {u.status === "uploading" && (
        <CircleNotchIcon size={ICON_SIZE.XS} className="shrink-0 animate-spin text-(--color-text-secondary)" />
      )}
      {u.status === "ready" && (
        <FileIcon size={ICON_SIZE.XS} className="shrink-0 text-(--color-text-secondary)" />
      )}
      {u.status === "error" && (
        <WarningCircleIcon size={ICON_SIZE.XS} className="shrink-0 text-red-400" />
      )}

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

      {u.status === "ready" && u.size !== undefined && (
        <span className="text-(--color-text-tertiary) shrink-0">{formatSize(u.size)}</span>
      )}
      {u.status === "uploading" && (
        <span className="text-(--color-text-tertiary) shrink-0">{u.progress}%</span>
      )}
      {u.status === "error" && (
        <button
          onClick={() => onRetry(index)}
          className="ml-0.5 text-red-400 hover:text-red-300 shrink-0"
          aria-label={`Retry ${u.name}`}
          title="Retry"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.XS} />
        </button>
      )}
      {u.status !== "uploading" && (
        <button
          onClick={() => onRemove(index)}
          className="ml-0.5 text-(--color-text-tertiary) hover:text-(--color-text-primary) shrink-0"
          aria-label={`Remove ${u.name}`}
          title={`Remove ${u.name}`}
        >
          &times;
        </button>
      )}
    </span>
  );
}

export function FileUploadChips({ uploads, onRemove, onRetry }: FileUploadChipsProps) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex gap-1.5 flex-wrap items-end" data-testid="file-upload-chips">
      {uploads.map((u, i) =>
        u.previewUrl
          ? <ImageThumbnail key={u.id} u={u} index={i} onRemove={onRemove} />
          : <FileChip key={u.id} u={u} index={i} onRemove={onRemove} onRetry={onRetry} />,
      )}
    </div>
  );
}
