// ---- Attachment and permission types ----

export interface ImageAttachment {
  data: string;       // base64-encoded image data
  mediaType: string;  // "image/png", "image/jpeg", etc.
  filename?: string;  // optional original filename
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

export type PermissionMode = "auto" | "plan" | "normal";

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
