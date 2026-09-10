import path from "node:path";
import fs from "node:fs/promises";
import { scanFileTree } from "../../shared/file-tree.js";
import { findMarkdownFiles } from "../markdown.js";
import type { DocEntry } from "../../shared/types.js";
import { ServiceError } from "./types.js";
import type { UploadedFile } from "../../shared/types.js";
import { chownToSessionWorker } from "../session-worker-uid.js";

export async function getFileTree(dir: string) {
  return scanFileTree(dir);
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MAX_IMAGE_SIZE = 10 * 1_048_576;
export const MAX_TEXT_SIZE = 1_048_576;

function getMimeType(ext: string): string {
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  return `image/${ext}`;
}

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

export async function writeFileContent(
  dir: string,
  filePath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  if (filePath.startsWith("uploads/") || filePath.startsWith("/uploads/")) {
    throw new ServiceError(400, "Uploads cannot be edited");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_SIZE) {
    throw new ServiceError(413, `File content is too large to save (maximum ${(MAX_TEXT_SIZE / 1_048_576).toFixed(0)} MB)`);
  }

  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(`${dir}/`)) {
    throw new ServiceError(400, "Invalid path");
  }

  let stat;
  try {
    stat = await fs.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ServiceError(404, "File not found");
    throw err;
  }
  if (!stat.isFile()) {
    throw new ServiceError(400, "Path is not a file");
  }
  if (stat.size > MAX_TEXT_SIZE) {
    throw new ServiceError(413, `File is too large to edit (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`);
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    throw new ServiceError(415, "Image files cannot be edited as text");
  }

  const current = await fs.readFile(safePath);
  if (current.includes(0)) {
    throw new ServiceError(415, "Binary files cannot be edited as text");
  }

  await fs.writeFile(safePath, content, "utf-8");
  return { path: filePath, size: Buffer.byteLength(content, "utf8") };
}

export async function listDocs(dir: string): Promise<DocEntry[]> {
  return findMarkdownFiles(dir);
}

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

export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_UPLOAD_FILES_PER_REQUEST = 20;
export const MAX_UPLOAD_SESSION_QUOTA = 500 * 1024 * 1024;

export function sanitizeFilename(raw: string): string {
  let name = path.basename(raw);
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\0\u0001-\u001f\u007f]/g, "");
  name = name.replace(/^\.+/, "");
  if (!name) name = "upload";
  return name;
}

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
      counter++;
      candidate = `${base}-${counter}${ext}`;
    } catch {
      return candidate;
    }
  }
}

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
    return 0;
  }
}

export async function saveUploadedFile(
  uploadsDir: string,
  rawFilename: string,
  data: Buffer,
): Promise<UploadedFile> {
  if (data.byteLength > MAX_UPLOAD_FILE_SIZE) {
    throw new ServiceError(413, `File "${rawFilename}" exceeds ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024} MB limit`);
  }

  const currentUsage = await getUploadsDirSize(uploadsDir);
  if (currentUsage + data.byteLength > MAX_UPLOAD_SESSION_QUOTA) {
    throw new ServiceError(413, `Upload would exceed session quota of ${MAX_UPLOAD_SESSION_QUOTA / 1024 / 1024} MB`);
  }

  await fs.mkdir(uploadsDir, { recursive: true });

  // Reserve names by exclusive creation; a prior existence check races other uploads.
  const sanitized = sanitizeFilename(rawFilename);
  let finalName: string;
  let filePath: string;
  const ext = path.extname(sanitized);
  const base = path.basename(sanitized, ext);
  for (let attempt = 0; ; attempt++) {
    finalName = attempt === 0 ? sanitized : `${base}-${attempt}${ext}`;
    filePath = path.join(uploadsDir, finalName);
    try {
      await fs.writeFile(filePath, data, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      // Remove a partial file before failing; the caller has not received its name.
      await fs.unlink(filePath).catch(() => {});
      throw err;
    }
  }
  chownToSessionWorker(filePath);

  return {
    name: finalName,
    path: `/uploads/${finalName}`,
    size: data.byteLength,
    type: "upload",
  };
}

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
    return [];
  }
}
