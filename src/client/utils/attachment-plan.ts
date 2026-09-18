

import type { FileContextRef, UploadItem, UploadRef } from "../../server/shared/types.js";
import { isCompactCommand } from "../../server/shared/compact-command.js";

export interface FrameAttachments {
  uploads?: UploadRef[];
  files?: FileContextRef[];
}

export interface BubbleAttachments {
  files?: { path: string; contentPreview: string }[];
  images?: { data: string; mediaType: string; src: string }[];
  uploadPaths?: string[];
}

export interface AttachmentPlan {
  frame: FrameAttachments;
  bubble: BubbleAttachments;

  clearAttachments: boolean;
}

function isUploadPath(filePath: string): boolean {
  return filePath.startsWith("/uploads/");
}

export function buildAttachmentPlan(input: {

  text: string;

  uploadRefs: UploadRef[];

  uploads: UploadItem[];

  pendingFiles: FileContextRef[];
}): AttachmentPlan {

  if (isCompactCommand(input.text)) {
    return { frame: {}, bubble: {}, clearAttachments: false };
  }

  // A pending file under /uploads/ is an existing upload re-attached as a file
  // reference ("Add to chat", `@`). `files` is resolved against the workspace,
  // which refuses an absolute path, so it travels as an upload instead.
  const contextFiles = input.pendingFiles.filter((f) => !isUploadPath(f.path));
  const reattachedUploads: UploadRef[] = input.pendingFiles
    .filter((f) => isUploadPath(f.path) && !input.uploadRefs.some((u) => u.path === f.path))
    .map((f) => ({ path: f.path, type: "upload" }));
  const uploadRefs = [...input.uploadRefs, ...reattachedUploads];

  const readyUploads = input.uploads.filter((u) => u.status === "ready" && u.path);
  const imageUploads = readyUploads.filter((u) => u.previewUrl);
  const nonImageUploadRefs = uploadRefs.filter(
    (ref) => !imageUploads.some((u) => u.path === ref.path),
  );

  const bubbleFiles = [
    ...contextFiles.map((f) => ({ path: f.path, contentPreview: "" })),
    ...nonImageUploadRefs.map((u) => ({ path: u.path, contentPreview: "" })),
  ];

  return {
    frame: {
      ...(uploadRefs.length > 0 ? { uploads: uploadRefs } : {}),
      ...(contextFiles.length > 0 ? { files: contextFiles } : {}),
    },
    bubble: {
      ...(bubbleFiles.length > 0 ? { files: bubbleFiles } : {}),
      ...(imageUploads.length > 0
        ? {
            images: imageUploads.map((u) => ({
              data: "",
              mediaType: u.mimeType ?? "image/png",
              src: u.dataUrl ?? u.previewUrl!,
            })),
          }
        : {}),
      ...(uploadRefs.length > 0
        ? { uploadPaths: uploadRefs.map((u) => u.path) }
        : {}),
    },
    clearAttachments: true,
  };
}
