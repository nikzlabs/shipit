import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sanitizeFilename,
  deduplicateFilename,
  getUploadsDirSize,
  saveUploadedFile,
  listUploads,
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_SESSION_QUOTA,
} from "./files.js";

describe("upload service functions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("sanitizeFilename", () => {
    it("preserves normal filenames", () => {
      expect(sanitizeFilename("data.csv")).toBe("data.csv");
    });

    it("strips path traversal", () => {
      expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    });

    it("strips null bytes", () => {
      expect(sanitizeFilename("file\x00name.txt")).toBe("filename.txt");
    });

    it("strips control characters", () => {
      expect(sanitizeFilename("file\x01\x02name.txt")).toBe("filename.txt");
    });

    it("strips leading dots", () => {
      expect(sanitizeFilename("..hidden")).toBe("hidden");
    });

    it("strips path components", () => {
      expect(sanitizeFilename("some/path/file.txt")).toBe("file.txt");
    });

    it("returns 'upload' for empty names", () => {
      expect(sanitizeFilename("")).toBe("upload");
    });

    it("returns 'upload' for dots-only names", () => {
      expect(sanitizeFilename("...")).toBe("upload");
    });
  });

  describe("deduplicateFilename", () => {
    it("returns original name if no collision", async () => {
      const name = await deduplicateFilename(tmpDir, "unique.txt");
      expect(name).toBe("unique.txt");
    });

    it("appends suffix on collision", async () => {
      fs.writeFileSync(path.join(tmpDir, "data.csv"), "existing");
      const name = await deduplicateFilename(tmpDir, "data.csv");
      expect(name).toBe("data-1.csv");
    });

    it("increments suffix for multiple collisions", async () => {
      fs.writeFileSync(path.join(tmpDir, "data.csv"), "existing");
      fs.writeFileSync(path.join(tmpDir, "data-1.csv"), "existing");
      const name = await deduplicateFilename(tmpDir, "data.csv");
      expect(name).toBe("data-2.csv");
    });
  });

  describe("getUploadsDirSize", () => {
    it("returns 0 for nonexistent directory", async () => {
      const size = await getUploadsDirSize(path.join(tmpDir, "nope"));
      expect(size).toBe(0);
    });

    it("sums file sizes", async () => {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello"); // 5 bytes
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "world!"); // 6 bytes
      const size = await getUploadsDirSize(tmpDir);
      expect(size).toBe(11);
    });
  });

  describe("saveUploadedFile", () => {
    it("writes file and returns metadata", async () => {
      const data = Buffer.from("hello world");
      const result = await saveUploadedFile(tmpDir, "test.txt", data);
      expect(result.name).toBe("test.txt");
      expect(result.path).toBe("/uploads/test.txt");
      expect(result.size).toBe(11);
      expect(result.type).toBe("upload");
      // Verify file was actually written
      const written = fs.readFileSync(path.join(tmpDir, "test.txt"), "utf-8");
      expect(written).toBe("hello world");
    });

    it("sanitizes filenames with path traversal", async () => {
      const data = Buffer.from("test");
      const result = await saveUploadedFile(tmpDir, "../../etc/passwd", data);
      expect(result.name).toBe("passwd");
      expect(result.path).toBe("/uploads/passwd");
    });

    it("deduplicates on collision", async () => {
      const data = Buffer.from("test");
      await saveUploadedFile(tmpDir, "file.txt", data);
      const result = await saveUploadedFile(tmpDir, "file.txt", data);
      expect(result.name).toBe("file-1.txt");
    });

    it("rejects files exceeding per-file limit", async () => {
      const data = Buffer.alloc(MAX_UPLOAD_FILE_SIZE + 1);
      await expect(saveUploadedFile(tmpDir, "big.bin", data)).rejects.toThrow(/exceeds/);
    });

    it("rejects files exceeding session quota", async () => {
      // Write a file close to the quota
      const existingSize = MAX_UPLOAD_SESSION_QUOTA - 100;
      fs.writeFileSync(path.join(tmpDir, "existing.bin"), Buffer.alloc(existingSize));
      const data = Buffer.alloc(200); // would exceed quota
      await expect(saveUploadedFile(tmpDir, "over.bin", data)).rejects.toThrow(/quota/);
    });

    it("creates uploads directory if it doesn't exist", async () => {
      const nestedDir = path.join(tmpDir, "nested", "uploads");
      const data = Buffer.from("test");
      const result = await saveUploadedFile(nestedDir, "file.txt", data);
      expect(result.name).toBe("file.txt");
      expect(fs.existsSync(path.join(nestedDir, "file.txt"))).toBe(true);
    });
  });

  describe("listUploads", () => {
    it("returns empty array for nonexistent directory", async () => {
      const files = await listUploads(path.join(tmpDir, "nope"));
      expect(files).toEqual([]);
    });

    it("returns file metadata", async () => {
      fs.writeFileSync(path.join(tmpDir, "a.csv"), "data");
      fs.writeFileSync(path.join(tmpDir, "b.zip"), Buffer.alloc(100));

      const files = await listUploads(tmpDir);
      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name).sort()).toEqual(["a.csv", "b.zip"]);
      expect(files.every((f) => f.type === "upload")).toBe(true);
      expect(files.find((f) => f.name === "a.csv")?.path).toBe("/uploads/a.csv");
    });
  });
});
