/**
 * MessageAttachmentRow — pending file references and uploads shown above the
 * MessageInput, between the agent thinking block and the PR lifecycle card.
 *
 * Lives outside of MessageInput so adding attachments doesn't grow the input
 * box (which would shrink the message list above it and visibly bump the
 * empty-state rocket animation upward). Sits inside the chat-content wrapper
 * so the rocket overlay's bounds stay stable when chips appear.
 */

import { FileAttachmentChips } from "./FileAttachmentChips.js";
import { FileUploadChips } from "./FileUploadChips.js";
import type { FileContextRef } from "../../server/shared/types.js";
import type { UploadItem } from "../hooks/useFileUpload.js";

export function MessageAttachmentRow({
  pendingFiles,
  onRemoveFile,
  uploads,
  onRemoveUpload,
  onRetryUpload,
}: {
  pendingFiles: FileContextRef[];
  onRemoveFile: (index: number) => void;
  uploads: UploadItem[];
  onRemoveUpload: (index: number) => void;
  onRetryUpload: (index: number) => void;
}) {
  if (pendingFiles.length === 0 && uploads.length === 0) return null;
  return (
    <div className="px-4 pb-2 space-y-2">
      {pendingFiles.length > 0 && (
        <FileAttachmentChips files={pendingFiles} onRemove={onRemoveFile} />
      )}
      {uploads.length > 0 && (
        <FileUploadChips uploads={uploads} onRemove={onRemoveUpload} onRetry={onRetryUpload} />
      )}
    </div>
  );
}
