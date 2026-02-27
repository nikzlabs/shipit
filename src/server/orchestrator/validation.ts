import path from "node:path";
import fs from "node:fs/promises";
import type { ImageAttachment, FileAttachment, FileContextRef } from "../shared/types.js";

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Image validation constants ----
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per image (decoded)
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_PAYLOAD_BYTES = 20 * 1024 * 1024; // 20 MB total

/**
 * Validate an array of image attachments. Returns an error message string
 * if validation fails, or null if all images are valid.
 */
export function validateImages(images: ImageAttachment[]): string | null {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return `Too many images (max ${MAX_IMAGES_PER_MESSAGE}, got ${images.length})`;
  }

  let totalBytes = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    if (!img.data || typeof img.data !== "string") {
      return `Image ${i + 1}: missing or invalid base64 data`;
    }

    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      return `Image ${i + 1}: unsupported type "${img.mediaType}" (allowed: PNG, JPEG, GIF, WebP)`;
    }

    // Validate base64 and check decoded size
    let decodedSize: number;
    try {
      const buf = Buffer.from(img.data, "base64");
      decodedSize = buf.byteLength;
      // Verify the base64 round-trips (catches invalid base64)
      if (buf.toString("base64") !== img.data.replace(/\s/g, "")) {
        return `Image ${i + 1}: invalid base64 encoding`;
      }
    } catch {
      return `Image ${i + 1}: invalid base64 encoding`;
    }

    if (decodedSize > MAX_IMAGE_SIZE_BYTES) {
      return `Image ${i + 1}: too large (${(decodedSize / 1024 / 1024).toFixed(1)} MB, max 5 MB)`;
    }

    totalBytes += decodedSize;
  }

  if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
    return `Total image size too large (${(totalBytes / 1024 / 1024).toFixed(1)} MB, max 20 MB)`;
  }

  return null;
}

// ---- File attachment validation constants ----
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB per file
const MAX_TOTAL_FILE_SIZE_BYTES = 500 * 1024; // 500 KB total
const MAX_FILES_PER_MESSAGE = 10;

/**
 * Format file attachments as <file> tags for Claude's prompt context.
 */
export function formatFileContext(files: FileAttachment[]): string {
  return files.map(f => {
    const lineRange = f.startLine && f.endLine
      ? ` lines="${f.startLine}-${f.endLine}"`
      : "";
    const header = `<file path="${f.path}"${lineRange}>`;
    return `${header}\n${f.content}\n</file>`;
  }).join("\n\n");
}

/**
 * Validate and read file attachments from disk. The client sends only paths;
 * the server reads the content and validates sizes.
 */
export async function resolveFileAttachments(
  refs: FileContextRef[],
  sessionDir: string,
): Promise<{ files: FileAttachment[]; error: string | null }> {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { files: [], error: null };
  }

  if (refs.length > MAX_FILES_PER_MESSAGE) {
    return { files: [], error: `Maximum ${MAX_FILES_PER_MESSAGE} file attachments per message` };
  }

  const validated: FileAttachment[] = [];
  let totalSize = 0;

  for (const ref of refs) {
    const filePath = typeof ref.path === "string" ? ref.path.trim() : "";
    if (!filePath) {
      return { files: [], error: "File path is required" };
    }

    // Path traversal check
    const resolved = path.resolve(sessionDir, filePath);
    if (!resolved.startsWith(sessionDir + "/") && resolved !== sessionDir) {
      return { files: [], error: `Invalid file path: ${filePath}` };
    }

    let content: string;
    try {
      content = await fs.readFile(resolved, "utf-8");
    } catch {
      return { files: [], error: `File not found: ${filePath}` };
    }

    const size = Buffer.byteLength(content, "utf-8");

    if (size > MAX_FILE_SIZE_BYTES) {
      return { files: [], error: `File too large: ${filePath} (max 100KB per file)` };
    }

    totalSize += size;
    if (totalSize > MAX_TOTAL_FILE_SIZE_BYTES) {
      return { files: [], error: "Total file attachments exceed 500KB" };
    }

    validated.push({
      path: filePath,
      content,
    });
  }

  return { files: validated, error: null };
}
