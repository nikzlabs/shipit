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
