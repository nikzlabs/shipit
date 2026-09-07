/**
 * What a send does with the composer's attachments — as one decision, in one
 * place, testable without rendering `App`.
 *
 * docs/294. Three separate silent-loss bugs have come out of this logic being
 * spread across `App.handleSend`'s branches, each branch answering the question
 * for itself and one of them forgetting: `/review` dispatched its composed
 * prompt without the uploads (docs/293 req 4), then without the `@`-mentioned
 * files, and `/compact` discarded both. `App.tsx` has no test harness, so none
 * of that could be caught by a test — which is why the decision lives here and
 * the caller only carries it out.
 *
 * Deliberately pure: it reads no store and performs no effect, so a test states
 * the composer's state and reads back exactly what would go on the wire.
 */

import type { FileContextRef, UploadItem, UploadRef } from "../../server/shared/types.js";
import { isCompactCommand } from "../../server/shared/compact-command.js";

/** The attachment-bearing fields of a `send_message` frame. */
export interface FrameAttachments {
  uploads?: UploadRef[];
  files?: FileContextRef[];
}

/** The attachment-bearing fields of the optimistic user bubble. */
export interface BubbleAttachments {
  files?: { path: string; contentPreview: string }[];
  images?: { data: string; mediaType: string; src: string }[];
  uploadPaths?: string[];
}

export interface AttachmentPlan {
  frame: FrameAttachments;
  bubble: BubbleAttachments;
  /**
   * Whether the composer should drop its chips. False only for a command that
   * carried nothing, so the attachments are still there for the next message.
   */
  clearAttachments: boolean;
}

export function buildAttachmentPlan(input: {
  /** The trimmed composer text — decides whether this is a command. */
  text: string;
  /** Ready upload refs from the composer. */
  uploadRefs: UploadRef[];
  /** Full upload items at send time, for the bubble's image thumbnails. */
  uploads: UploadItem[];
  /** `@`-mentioned workspace files, which live in the settings store. */
  pendingFiles: FileContextRef[];
}): AttachmentPlan {
  // docs/294 reqs 5-6 — `/compact` asks the agent to summarise the conversation.
  // It is a control command with no use for a file, so it carries nothing and
  // takes nothing away: the chips stay for the user's next real message.
  if (isCompactCommand(input.text)) {
    return { frame: {}, bubble: {}, clearAttachments: false };
  }

  // An image upload is shown in the bubble as a thumbnail; everything else is
  // shown as a file row. `previewUrl` is what distinguishes them, and only a
  // `ready` upload with a path can be referenced at all.
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
