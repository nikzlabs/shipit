import { EventEmitter } from "node:events";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { isWorkspaceSkipDir } from "../shared/fs-constants.js";

const IGNORE_FILES = new Set([".shipit-usage.json", ".vibe-sessions.json"]);

// Chokidar skips ignored subtrees before allocating watches against the host UID's limit.
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private debounceMs: number;
  private watchedDir: string | null = null;

  constructor(debounceMs = 300) {
    super();
    this.debounceMs = debounceMs;
  }

  start(dir: string): void {
    if (this.watcher) return;

    this.watchedDir = dir;

    try {
      this.watcher = chokidar.watch(dir, {
        ignored: (filePath: string) => this.shouldIgnore(filePath),
        ignoreInitial: true,
        persistent: true,
      });

      const handle = (filePath: string): void => {
        const rel = this.toRelative(filePath);
        if (!rel) return;
        this.pendingChanges.add(rel);
        this.scheduleBroadcast();
      };

      this.watcher.on("add", handle);
      this.watcher.on("change", handle);
      this.watcher.on("unlink", handle);
      this.watcher.on("addDir", handle);
      this.watcher.on("unlinkDir", handle);

      this.watcher.on("error", (err) => {
        console.error("[file-watcher] watch error:", (err as Error).message);
      });
    } catch (err) {
      console.error("[file-watcher] failed to start:", (err as Error).message);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
    void this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  private shouldIgnore(filePath: string): boolean {
    if (this.watchedDir && filePath === this.watchedDir) return false;

    const rel = this.watchedDir ? path.relative(this.watchedDir, filePath) : filePath;
    if (!rel || rel.startsWith("..")) return false;

    const parts = rel.split(path.sep);
    return parts.some((part) => isWorkspaceSkipDir(part) || IGNORE_FILES.has(part));
  }

  private toRelative(filePath: string): string | null {
    if (!this.watchedDir) return null;
    if (filePath === this.watchedDir) return null;
    const rel = path.relative(this.watchedDir, filePath);
    if (!rel || rel.startsWith("..")) return null;
    return rel;
  }

  private scheduleBroadcast(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      if (changes.length > 0) {
        this.emit("changes", changes);
      }
    }, this.debounceMs);
  }
}
