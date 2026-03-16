/**
 * File and documentation read services — file tree, file content, docs, uploads.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { scanFileTree } from "../../shared/file-tree.js";
import { findMarkdownFiles } from "../markdown.js";
import type { DocEntry } from "../../shared/types.js";
import { ServiceError } from "./types.js";
import type { UploadedFile } from "../../shared/types.js";

/** Get file tree for a directory. */
export async function getFileTree(dir: string) {
  return scanFileTree(dir);
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MAX_IMAGE_SIZE = 10 * 1_048_576; // 10 MB
const MAX_TEXT_SIZE = 1_048_576; // 1 MB

function getMimeType(ext: string): string {
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  return `image/${ext}`;
}

/** Resolve a file path safely and return the absolute path + filename for downloads. */
export function getRawFilePath(
  dir: string,
  filePath: string,
): { safePath: string; filename: string } {
  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(`${dir}/`)) {
    throw new ServiceError(400, "Invalid path");
  }
  return { safePath, filename: path.basename(safePath) };
}

/** Get file content with safety checks (path traversal, binary, size). */
export async function getFileContent(
  dir: string,
  filePath: string,
): Promise<{ content: string; isBinary?: boolean; isImage?: boolean }> {
  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(`${dir  }/`)) {
    throw new ServiceError(400, "Invalid path");
  }
  const stat = await fs.stat(safePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();

  // Image files: return base64 data URI
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (stat.size > MAX_IMAGE_SIZE) {
      return {
        content: `Image is too large to preview (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 10 MB.`,
        isBinary: true,
      };
    }
    const buf = await fs.readFile(safePath);
    const mime = getMimeType(ext);
    return {
      content: `data:${mime};base64,${buf.toString("base64")}`,
      isImage: true,
    };
  }

  // Text files
  if (stat.size > MAX_TEXT_SIZE) {
    return {
      content: `File is too large to display (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`,
      isBinary: true,
    };
  }
  const buf = await fs.readFile(safePath);
  if (buf.includes(0)) {
    return { content: "Binary file — cannot display.", isBinary: true };
  }
  return { content: buf.toString("utf-8") };
}

/** List markdown documentation files with optional status metadata. */
export async function listDocs(dir: string): Promise<DocEntry[]> {
  return findMarkdownFiles(dir);
}

/** Get a single doc file's content. */
export async function getDocContent(
  dir: string,
  docPath: string,
): Promise<string> {
  const safePath = path.resolve(dir, docPath);
  if (!safePath.startsWith(`${dir  }/`)) {
    throw new ServiceError(400, "Invalid path");
  }
  return fs.readFile(safePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Upload service functions
// ---------------------------------------------------------------------------

/** Maximum file size per upload: 50 MB. */
export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
/** Maximum files per upload request. */
export const MAX_UPLOAD_FILES_PER_REQUEST = 20;
/** Maximum total upload storage per session: 500 MB. */
export const MAX_UPLOAD_SESSION_QUOTA = 500 * 1024 * 1024;

/**
 * Sanitize a filename for safe storage. Strips path traversal, null bytes,
 * and control characters. Returns a flat filename (no subdirectories).
 */
export function sanitizeFilename(raw: string): string {
  // Take only the basename (strip any path components)
  let name = path.basename(raw);
  // Remove null bytes and control characters (eslint-disable-next-line no-control-regex)
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\0\u0001-\u001f\u007f]/g, "");
  // Remove leading dots to prevent hidden files from traversal
  name = name.replace(/^\.+/, "");
  // Fallback for empty names
  if (!name) name = "upload";
  return name;
}

/**
 * Generate a collision-free filename by appending a numeric suffix.
 * e.g. "data.csv" → "data-1.csv" → "data-2.csv"
 */
export async function deduplicateFilename(
  uploadsDir: string,
  filename: string,
): Promise<string> {
  let candidate = filename;
  let counter = 0;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  while (true) {
    try {
      await fs.access(path.join(uploadsDir, candidate));
      // File exists — try next suffix
      counter++;
      candidate = `${base}-${counter}${ext}`;
    } catch {
      // File doesn't exist — this name is available
      return candidate;
    }
  }
}

/**
 * Calculate the total size of existing uploads in a directory.
 */
export async function getUploadsDirSize(uploadsDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(uploadsDir);
    let total = 0;
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(uploadsDir, entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // Skip files we can't stat
      }
    }
    return total;
  } catch {
    // Directory doesn't exist yet — 0 usage
    return 0;
  }
}

/**
 * Save an uploaded file to the session's uploads directory.
 * Validates per-file size and session quota. Sanitizes filename.
 */
export async function saveUploadedFile(
  uploadsDir: string,
  rawFilename: string,
  data: Buffer,
): Promise<UploadedFile> {
  if (data.byteLength > MAX_UPLOAD_FILE_SIZE) {
    throw new ServiceError(413, `File "${rawFilename}" exceeds ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024} MB limit`);
  }

  // Check session quota
  const currentUsage = await getUploadsDirSize(uploadsDir);
  if (currentUsage + data.byteLength > MAX_UPLOAD_SESSION_QUOTA) {
    throw new ServiceError(413, `Upload would exceed session quota of ${MAX_UPLOAD_SESSION_QUOTA / 1024 / 1024} MB`);
  }

  // Sanitize and deduplicate
  const sanitized = sanitizeFilename(rawFilename);
  const finalName = await deduplicateFilename(uploadsDir, sanitized);

  // Ensure uploads directory exists
  await fs.mkdir(uploadsDir, { recursive: true });

  // Write the file
  const filePath = path.join(uploadsDir, finalName);
  await fs.writeFile(filePath, data);

  return {
    name: finalName,
    path: `/uploads/${finalName}`,
    size: data.byteLength,
    type: "upload",
  };
}

/**
 * Delete an uploaded file from the session's uploads directory.
 * Returns true if the file was deleted, false if it didn't exist.
 * Throws on path traversal attempts.
 */
export async function deleteUpload(uploadsDir: string, filename: string): Promise<boolean> {
  const safePath = path.resolve(uploadsDir, filename);
  if (!safePath.startsWith(`${path.resolve(uploadsDir)}/`)) {
    throw new ServiceError(400, "Invalid filename");
  }

  try {
    await fs.unlink(safePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * List all uploaded files in a session's uploads directory.
 */
export async function listUploads(uploadsDir: string): Promise<UploadedFile[]> {
  try {
    const entries = await fs.readdir(uploadsDir);
    const files: UploadedFile[] = [];
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(uploadsDir, entry));
        if (stat.isFile()) {
          files.push({
            name: entry,
            path: `/uploads/${entry}`,
            size: stat.size,
            type: "upload",
          });
        }
      } catch {
        // Skip files we can't stat
      }
    }
    return files;
  } catch {
    // Directory doesn't exist — no uploads
    return [];
  }
}
