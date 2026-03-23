import path from "node:path";
import fs from "node:fs/promises";
import type { ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../shared/types.js";

// Re-exported from shared for backward compatibility — prefer importing from "../shared/utils.js" directly.
export { getErrorMessage } from "../shared/utils.js";

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
    if (!resolved.startsWith(`${sessionDir  }/`) && resolved !== sessionDir) {
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

// ---- Upload ref resolution ----

/** Extensions for binary file detection based on extension. */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".sqlite", ".db",
]);

/** Image extensions that can be viewed natively via the Read tool. */
export const IMAGE_UPLOAD_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/** Check if a file path refers to a likely binary file based on its extension. */
function isBinaryUpload(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Extension → MIME type mapping for image uploads. */
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Resolve upload refs into FileAttachment entries (for text files) or
 * reference-only entries (for binary files). Image uploads (PNG, JPEG, GIF,
 * WebP) are returned separately as ImageAttachment objects with base64 data
 * so they can be shown as inline thumbnails in chat history.
 */
export async function resolveUploadRefs(
  uploads: UploadRef[],
  workspaceDir: string,
): Promise<{ files: FileAttachment[]; images: ImageAttachment[]; imageHostPaths: string[]; error: string | null }> {
  // Uploads live as a sibling of the workspace dir inside the session dir:
  // {sessionDir}/workspace/ (workspaceDir) and {sessionDir}/uploads/
  const uploadsDir = path.join(path.dirname(workspaceDir), "uploads");
  const fileResult: FileAttachment[] = [];
  const imageResult: ImageAttachment[] = [];
  const imageHostPaths: string[] = [];

  for (const ref of uploads) {
    // Validate path format
    if (!ref.path.startsWith("/uploads/")) {
      return { files: [], images: [], imageHostPaths: [], error: `Invalid upload path: ${ref.path}` };
    }
    const filename = path.basename(ref.path);
    const hostPath = path.join(uploadsDir, filename);

    // Path traversal check
    if (!hostPath.startsWith(`${uploadsDir}/`)) {
      return { files: [], images: [], imageHostPaths: [], error: `Invalid upload path: ${ref.path}` };
    }

    const ext = path.extname(ref.path).toLowerCase();
    const imageMime = IMAGE_EXT_TO_MIME[ext];

    if (imageMime) {
      // Image upload — read binary data and return as ImageAttachment
      try {
        const buf = await fs.readFile(hostPath);
        imageResult.push({
          data: buf.toString("base64"),
          mediaType: imageMime,
          filename,
        });
        imageHostPaths.push(hostPath);
      } catch {
        return { files: [], images: [], imageHostPaths: [], error: `Upload not found: ${ref.path}` };
      }
    } else if (isBinaryUpload(ref.path)) {
      // Non-image binary files — include a reference the agent can use
      fileResult.push({
        path: ref.path,
        content: `[Binary file uploaded at ${ref.path} — use Bash tool to read/process this file inside the container]`,
      });
    } else {
      // For text files, read and include content
      try {
        const content = await fs.readFile(hostPath, "utf-8");
        // Cap at 100KB per file (same as workspace file refs)
        if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
          fileResult.push({
            path: ref.path,
            content: `[File ${ref.path} is too large to include inline (>100KB). Use Bash tool to read it at ${ref.path}]`,
          });
        } else {
          fileResult.push({ path: ref.path, content });
        }
      } catch {
        return { files: [], images: [], imageHostPaths: [], error: `Upload not found: ${ref.path}` };
      }
    }
  }

  return { files: fileResult, images: imageResult, imageHostPaths, error: null };
}
