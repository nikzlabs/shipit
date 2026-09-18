export interface ImageAttachment {
  /** Base64-encoded image data. */
  data: string;
  mediaType: string;
  filename?: string;
  /** Reuse this container path instead of saving another copy of the upload. */
  existingPath?: string;
}

export interface FileAttachment {
  /** Workspace-relative path. */
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
}

// ShipIt "guarded" maps to Claude CLI "auto"; ShipIt "auto" bypasses its classifier.
export type PermissionMode = "auto" | "plan" | "guarded";

export interface FileContextRef {
  /** Workspace-relative path. */
  path: string;
}

export interface UploadRef {
  /** Absolute path under /uploads/. */
  path: string;
  type: "upload";
}

export interface UploadedFile {
  name: string;
  path: string;
  /** Bytes. */
  size: number;
  type: "upload";
}

export type UploadStatus = "uploading" | "ready" | "error";

export interface UploadItem {
  id: string;
  name: string;
  status: UploadStatus;
  size?: number;
  path?: string;
  error?: string;
  /** Percent, 0–100. */
  progress: number;
  previewUrl?: string;
  /** Survives blob URL revocation. */
  dataUrl?: string;
  mimeType?: string;
  pending?: boolean;
}
