// ---- Attachment and permission types ----

export interface ImageAttachment {
  data: string;       // base64-encoded image data
  mediaType: string;  // "image/png", "image/jpeg", etc.
  filename?: string;  // optional original filename
  /**
   * Container path of an existing on-disk copy of this image (e.g.
   * `/uploads/screenshot.png`). Set for images that came from `uploads:`
   * refs, where the file is already in `/uploads/` at a known path. When
   * set, the orchestrator references this path in the agent prompt instead
   * of re-saving the image under a new randomized name — keeping the
   * on-disk path in sync with `uploadPaths` in chat history so
   * `hydrateUploads` can correctly identify the upload as sent.
   */
  existingPath?: string;
}

export interface FileAttachment {
  /** Relative path within the workspace (e.g., "src/utils/format.ts"). */
  path: string;
  /** Full file content at the time of attachment. */
  content: string;
  /** Optional line range — if the user selected specific lines. */
  startLine?: number;
  endLine?: number;
}

/**
 * Agent permission mode. `auto` = autonomous (write tools allowed); `plan` =
 * read-only research/planning. (A classifier-gated `guarded` mode is planned —
 * see docs/138.)
 */
export type PermissionMode = "auto" | "plan";

export interface FileContextRef {
  /** Relative path within the workspace. */
  path: string;
}

/** Reference to an uploaded file in /uploads/. */
export interface UploadRef {
  /** Absolute container path, e.g. "/uploads/data.csv". */
  path: string;
  type: "upload";
}

/** Metadata for a file that has been uploaded to the session. */
export interface UploadedFile {
  /** Original filename. */
  name: string;
  /** Absolute container path, e.g. "/uploads/data.csv". */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Discriminator for upload files vs workspace file refs. */
  type: "upload";
}

/** Client-side upload tracking item — used for input chips and the Uploads file tree section. */
export type UploadStatus = "uploading" | "ready" | "error";

export interface UploadItem {
  /** Client-side ID for tracking. */
  id: string;
  /** Original filename. */
  name: string;
  /** Upload status. */
  status: UploadStatus;
  /** File size in bytes (set once upload completes). */
  size?: number;
  /** Container path (set once upload completes). */
  path?: string;
  /** Error message if upload failed. */
  error?: string;
  /** Upload progress 0-100. */
  progress: number;
  /** Object URL for image thumbnail preview (set for image files). */
  previewUrl?: string;
  /** Stable data: URL for image uploads (survives blob URL revocation). */
  dataUrl?: string;
  /** MIME type of the uploaded file (set for image files). */
  mimeType?: string;
  /** Whether this upload is pending (not yet sent in a message). */
  pending?: boolean;
}
