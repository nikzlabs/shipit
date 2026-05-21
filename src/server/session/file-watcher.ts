import { EventEmitter } from "node:events";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { WORKSPACE_SKIP_DIRS } from "../shared/fs-constants.js";

/** File-level ignores (specific data files in the workspace root, not directories). */
const IGNORE_FILES = new Set([".shipit-usage.json", ".vibe-sessions.json"]);

/**
 * Watches a directory recursively for file changes and emits debounced
 * "changes" events with the list of changed file paths.
 *
 * Events:
 *   - "changes" (paths: string[]) — emitted after the debounce window
 *     closes, with a deduplicated list of changed file paths (relative
 *     to the watched directory).
 *
 * Design decisions:
 *   - Uses chokidar instead of `fs.watch(dir, { recursive: true })`. On
 *     Linux there's no native recursive inotify, so Node's recursive
 *     mode walks the tree and registers one inotify watch per directory
 *     — including everything under `node_modules`, `.git`, `dist`, etc.
 *     The kernel's inotify watch limit is per-host-UID (not per-container),
 *     so a handful of sessions could exhaust the host-wide budget.
 *     Chokidar walks the tree itself and consults the `ignored` matcher
 *     before registering a watch on each directory, so ignored subtrees
 *     never consume inotify watches at all.
 *   - 300ms debounce window by default — collapses bulk operations
 *     (e.g. npm install, template application) into a single event.
 *   - Set-based deduplication merges multiple events for the same file.
 *   - The `ignored` matcher is a function (not just a glob) so it can
 *     apply the same per-segment logic as the shared file-tree scanner:
 *     any segment whose name appears in WORKSPACE_SKIP_DIRS or
 *     IGNORE_FILES is skipped, no matter how deeply it's nested.
 */
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

  /**
   * Start watching the given directory recursively.
   * Emits "changes" events when files are created, modified, or deleted.
   */
  start(dir: string): void {
    if (this.watcher) return; // already watching

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

      // Handle watcher errors gracefully — log and continue
      this.watcher.on("error", (err) => {
        console.error("[file-watcher] watch error:", (err as Error).message);
      });
    } catch (err) {
      console.error("[file-watcher] failed to start:", (err as Error).message);
    }
  }

  /**
   * Stop watching and clean up timers.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
    // chokidar.close() returns a Promise; we don't await — callers don't
    // need to block on filesystem-watch teardown, and tests rely on stop()
    // being synchronous.
    void this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
  }

  /**
   * Check whether a path should be ignored. Splits the path into segments
   * relative to the watched root and rejects any path containing a
   * segment listed in WORKSPACE_SKIP_DIRS or IGNORE_FILES.
   *
   * Chokidar calls this matcher BEFORE registering a watcher on a
   * directory, so ignored subtrees (e.g. `node_modules`) never get
   * an inotify watch.
   */
  private shouldIgnore(filePath: string): boolean {
    // The watched root itself must never be ignored — chokidar consults
    // the matcher with the root path during setup.
    if (this.watchedDir && filePath === this.watchedDir) return false;

    // Strip the watched-root prefix so we only inspect path segments
    // *inside* the workspace. If we can't determine a relative path
    // (e.g. matcher invoked before start() captured the root, or path
    // is outside the root), fall back to inspecting all segments — both
    // WORKSPACE_SKIP_DIRS and IGNORE_FILES are leaf names so spurious
    // matches on parent directories are vanishingly unlikely.
    const rel = this.watchedDir ? path.relative(this.watchedDir, filePath) : filePath;
    if (!rel || rel.startsWith("..")) return false;

    const parts = rel.split(path.sep);
    return parts.some((part) => WORKSPACE_SKIP_DIRS.has(part) || IGNORE_FILES.has(part));
  }

  /** Convert an absolute path emitted by chokidar to a workspace-relative one. */
  private toRelative(filePath: string): string | null {
    if (!this.watchedDir) return null;
    if (filePath === this.watchedDir) return null;
    const rel = path.relative(this.watchedDir, filePath);
    if (!rel || rel.startsWith("..")) return null;
    return rel;
  }

  /**
   * Schedule (or reschedule) a debounced broadcast of pending changes.
   * Each new change resets the timer, collapsing rapid-fire events.
   */
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
