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

/**
 * Map the dialog's `FilePreviewType` (+ path) into a `ContentKind`. The key
 * behavior change: `.svg` splits out of `image` and `.html`/`.htm` out of
 * `code`, so committed mockups render rather than showing as raw source.
 */
export function kindFromPreviewType(type: FilePreviewType, filePath: string): ContentKind {
  const ext = extOf(filePath);
  if (type === "markdown") return "markdown";
  if (type === "binary") return "binary";
  if (type === "image") return ext === "svg" ? "svg" : "image";
  // type === "code"
  if (ext === "html" || ext === "htm") return "html";
  return "code";
}

/** Map a Present artifact's MIME type (+ path fallback) into a `ContentKind`. */
export function kindFromMimeType(mimeType: string, filePath: string): ContentKind {
  const lower = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (lower === "text/html") return "html";
  if (lower === "image/svg+xml") return "svg";
  if (lower === "text/markdown") return "markdown";
  if (lower.startsWith("image/")) return "image";
  // Odd or missing MIME — fall back to the extension.
  const ext = extOf(filePath);
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  return "code";
}

/** HTML/SVG are the only kinds that render *and* have a meaningful source view. */
export function supportsSourceToggle(kind: ContentKind): boolean {
  return kind === "html" || kind === "svg";
}

/** Kinds that can carry review comments (markdown selection, or code/html/svg line comments). */
export function supportsKindReview(kind: ContentKind): boolean {
  return kind === "markdown" || kind === "code" || kind === "html" || kind === "svg";
}

/**
 * True only for a **workspace-relative** path. The file-review endpoints resolve
 * against the session workspace, so absolute paths (Present's `/persist`
 * throwaways since docs/217, or any other absolute artifact) and `..` traversal
 * are not addressable — those render read-only with no review footer.
 */
export function isRepoReviewablePath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.startsWith("/")) return false; // POSIX absolute (incl. /persist, /tmp)
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return false; // Windows absolute (defensive)
  if (filePath.split(/[\\/]/).some((seg) => seg === "..")) return false; // traversal
  return true;
}
