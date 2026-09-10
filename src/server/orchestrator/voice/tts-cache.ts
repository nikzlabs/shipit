import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getErrorMessage } from "../../shared/utils.js";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

interface Entry {
  size: number;
  atime: number;
}

export function ttsCacheKey(text: string, voice: string, speed: number, provider: string): string {
  return crypto.createHash("sha256").update(`${provider}\n${voice}\n${speed}\n${text}`).digest("hex");
}

export class TtsCache {
  private dir: string;
  private maxBytes: number;
  private entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(cacheDir: string, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.dir = cacheDir;
    this.maxBytes = maxBytes;
    this.rebuildIndex();
  }

  private filePath(key: string): string {
    return path.join(this.dir, `${key}.bin`);
  }

  private rebuildIndex(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith(".bin")) continue;
        const key = name.slice(0, -4);
        try {
          const stat = fs.statSync(path.join(this.dir, name));
          this.entries.set(key, { size: stat.size, atime: stat.mtimeMs });
          this.totalBytes += stat.size;
        } catch {
          // Skip files we can't stat.
        }
      }
    } catch (err) {
      console.warn("[tts-cache] index rebuild failed:", getErrorMessage(err));
    }
  }

  get(key: string): Buffer | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    try {
      const buf = fs.readFileSync(this.filePath(key));
      entry.atime = Date.now();
      return buf;
    } catch {
      this.entries.delete(key);
      this.totalBytes -= entry.size;
      return null;
    }
  }

  set(key: string, data: Buffer): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.filePath(key), data);
    } catch (err) {
      console.warn("[tts-cache] write failed:", getErrorMessage(err));
      return;
    }
    const prev = this.entries.get(key);
    if (prev) this.totalBytes -= prev.size;
    this.entries.set(key, { size: data.length, atime: Date.now() });
    this.totalBytes += data.length;
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.totalBytes <= this.maxBytes) return;
    const byAtime = [...this.entries.entries()].sort((a, b) => a[1].atime - b[1].atime);
    for (const [key, entry] of byAtime) {
      if (this.totalBytes <= this.maxBytes) break;
      try {
        fs.unlinkSync(this.filePath(key));
      } catch {
        // Drop the index entry even if deletion fails.
      }
      this.entries.delete(key);
      this.totalBytes -= entry.size;
    }
  }

  get sizeBytes(): number {
    return this.totalBytes;
  }
}
