const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);

export type FilePreviewType = "markdown" | "code" | "image" | "binary";

/** Determine preview mode from file extension. */
export function detectFilePreviewType(filePath: string): FilePreviewType {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "code";
}

/** True when the file path should expose the manual text-edit affordance. */
export function isEditableFilePath(filePath: string): boolean {
  if (filePath.startsWith("/uploads/") || filePath.startsWith("uploads/")) return false;
  const type = detectFilePreviewType(filePath);
  return type === "code" || type === "markdown";
}
