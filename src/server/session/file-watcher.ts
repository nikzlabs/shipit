import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";

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
 *   - Uses Node.js `fs.watch` with `recursive: true` (requires Node 19+
 *     on Linux; works natively on macOS and Windows).
 *   - 300ms debounce window by default — collapses bulk operations
 *     (e.g. npm install, template application) into a single event.
 *   - Set-based deduplication merges multiple events for the same file.
 *   - Ignore patterns filter out noise directories at the watcher level.
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private debounceMs: number;

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

    try {
      // On macOS, FSEvents fires a spurious initial event where filename equals
      // the basename of the watched directory itself. Filter it out.
      const dirBasename = path.basename(dir);
      this.watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (filename === dirBasename) return;
        if (this.shouldIgnore(filename)) return;

        this.pendingChanges.add(filename);
        this.scheduleBroadcast();
      });

      // Handle watcher errors gracefully — log and continue
      this.watcher.on("error", (err) => {
        console.error("[file-watcher] watch error:", err.message);
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
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Check whether a file path should be ignored based on IGNORE_PATTERNS.
   * Splits the path into segments and checks if any segment matches.
   */
  private shouldIgnore(filePath: string): boolean {
    const parts = filePath.split(path.sep);
    return parts.some((part) => WORKSPACE_SKIP_DIRS.has(part) || IGNORE_FILES.has(part));
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
