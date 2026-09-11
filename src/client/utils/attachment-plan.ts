

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

export function buildAttachmentPlan(input: {

  text: string;

  uploadRefs: UploadRef[];

  uploads: UploadItem[];

  pendingFiles: FileContextRef[];
}): AttachmentPlan {

  if (isCompactCommand(input.text)) {
    return { frame: {}, bubble: {}, clearAttachments: false };
  }

  const readyUploads = input.uploads.filter((u) => u.status === "ready" && u.path);
  const imageUploads = readyUploads.filter((u) => u.previewUrl);
  const nonImageUploadRefs = input.uploadRefs.filter(
    (ref) => !imageUploads.some((u) => u.path === ref.path),
  );

  const bubbleFiles = [
    ...input.pendingFiles.map((f) => ({ path: f.path, contentPreview: "" })),
    ...nonImageUploadRefs.map((u) => ({ path: u.path, contentPreview: "" })),
  ];

  return {
    frame: {
      ...(input.uploadRefs.length > 0 ? { uploads: input.uploadRefs } : {}),
      ...(input.pendingFiles.length > 0 ? { files: input.pendingFiles } : {}),
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
      ...(input.uploadRefs.length > 0
        ? { uploadPaths: input.uploadRefs.map((u) => u.path) }
        : {}),
    },
    clearAttachments: true,
  };
}
