/**
 * file-content-kind — the single content model shared by the file-viewer dialog
 * (`FilePreviewModal`) and the Present tab (`PresentPane`), per
 * docs/219-unify-file-viewer-renderer.
 *
 * The dialog keys rendering on `FilePreviewType` (markdown|code|image|binary);
 * Present keys on MIME strings. Both map into this one `ContentKind` so the
 * shared `FileContentView` never sees either vocabulary — and so HTML/SVG split
 * out of the `code`/`image` buckets and render instead of showing as source.
 */

import type { FilePreviewType } from "./file-preview-type.js";

export type ContentKind = "markdown" | "html" | "svg" | "image" | "code" | "binary";

function extOf(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() ?? "";
}

export function kindFromPreviewType(type: FilePreviewType, filePath: string): ContentKind {
  const ext = extOf(filePath);
  if (type === "markdown") return "markdown";
  if (type === "binary") return "binary";
  if (type === "image") return ext === "svg" ? "svg" : "image";

  if (ext === "html" || ext === "htm") return "html";
  return "code";
}

export function kindFromMimeType(mimeType: string, filePath: string): ContentKind {
  const lower = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (lower === "text/html") return "html";
  if (lower === "image/svg+xml") return "svg";
  if (lower === "text/markdown") return "markdown";
  if (lower.startsWith("image/")) return "image";

  const ext = extOf(filePath);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  return "code";
}

export function supportsSourceToggle(kind: ContentKind): boolean {
  return kind === "html" || kind === "svg";
}

export function supportsKindReview(kind: ContentKind): boolean {
  return kind === "markdown" || kind === "code" || kind === "html" || kind === "svg";
}

export function isRepoReviewablePath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.startsWith("/")) return false;                                         
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return false;                                
  if (filePath.split(/[\\/]/).some((seg) => seg === "..")) return false;             
  return true;
}
