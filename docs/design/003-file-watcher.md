# Design Doc 003: File Watcher with Live Updates

## Status: Proposed

## Problem

ShipIt's file tree and file viewer are entirely request-response: the client must manually refresh or wait for a `git_committed` event to see changes. When Claude edits files (or when external processes like Vite's HMR rewrite files), the UI shows stale data until the user clicks refresh or switches tabs. This makes the tool feel disconnected from the actual workspace state.

Specific pain points:
1. **File tree staleness** — new files created by Claude don't appear until manual refresh.
2. **File viewer staleness** — a file open in the viewer may have been edited by Claude, but the viewer shows the old version.
3. **Preview blindness** — the preview iframe doesn't know when to reload (Vite HMR handles this for Vite projects, but non-Vite projects need manual reload).
4. **No change awareness** — there's no indication that files have changed since the user last looked.

## Goals

1. Detect file changes in the workspace directory in real time.
2. Push file change notifications to connected clients.
3. Auto-refresh the file tree when files are created, deleted, or renamed.
4. Auto-refresh the file viewer when the viewed file changes.
5. Debounce events to avoid flooding the client during bulk operations (e.g., `npm install`, template application).

## Non-Goals

- Full filesystem event details (we don't need to distinguish "modify" from "chmod").
- Watching files outside `/workspace`.
- Collaborative editing / conflict resolution.
- Watching inside `node_modules` or `.git`.

## Design

### Server: `FileWatcher` class (`src/server/file-watcher.ts`)

Uses Node.js `fs.watch` (recursive mode) to monitor `/workspace`:

```typescript
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";

const IGNORE_PATTERNS = [
  "node_modules", ".git", ".vite", ".next", ".cache",
  "dist", ".shipit-usage.json", ".vibe-sessions.json",
  ".vibe-chat-history",
];

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private debounceMs: number;

  constructor(debounceMs = 300) {
    super();
    this.debounceMs = debounceMs;
  }

  start(dir: string): void {
    this.watcher = watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (this.shouldIgnore(filename)) return;

      this.pendingChanges.add(filename);
      this.scheduleBroadcast();
    });
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private shouldIgnore(filePath: string): boolean {
    const parts = filePath.split(path.sep);
    return parts.some(part => IGNORE_PATTERNS.includes(part));
  }

  private scheduleBroadcast(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      this.emit("changes", changes);
    }, this.debounceMs);
  }
}
```

Key design decisions:
- **Recursive `fs.watch`**: Works on Linux (inotify), macOS (FSEvents), and Windows (ReadDirectoryChangesW). The `recursive` option is supported on macOS and Windows natively; on Linux it requires Node.js 19+ (we target Node 18+, so we fall back to a flat watch + manual recursion on older versions, or simply document the requirement).
- **Debouncing at 300ms**: Prevents event storms during bulk file operations. Claude's Write/Edit tools trigger multiple fs events per operation. 300ms collapses these into a single notification.
- **Set-based deduplication**: Multiple events for the same file within the debounce window are merged.
- **Ignore patterns**: Same patterns used by `scanFileTree()` in `file-tree.ts` for consistency.

### Server: Integration in `index.ts`

```typescript
const fileWatcher = deps.fileWatcher ?? new FileWatcher();

// Start watching when the app is built
fileWatcher.start(workspaceDir);

// On file changes, notify clients
fileWatcher.on("changes", (changedFiles: string[]) => {
  broadcast({
    type: "files_changed",
    paths: changedFiles,
  });
});

// Stop on shutdown
app.addHook("onClose", async () => {
  fileWatcher.stop();
  // ...existing cleanup
});
```

### New WebSocket message

| Direction | Type | Payload |
|-----------|------|---------|
| Server → Client | `files_changed` | `{ paths: string[] }` — list of relative paths that changed |

This is a server-initiated push message. No client request is needed.

### Client Changes

#### `App.tsx` — handle `files_changed`

```typescript
if (data.type === "files_changed") {
  const paths: string[] = data.paths;

  // 1. Auto-refresh file tree if the Files tab is active
  if (rightTab === "files") {
    send({ type: "get_file_tree" });
  }

  // 2. Auto-refresh the viewed file if it was modified
  if (viewingFile && paths.some(p => viewingFile.endsWith(p))) {
    send({ type: "get_file_content", path: viewingFile });
  }

  // 3. Set a "files changed" indicator for the Files tab when not active
  if (rightTab !== "files") {
    setFileChangeCount(prev => prev + paths.length);
  }
}
```

#### Files tab badge

Similar to the terminal's unread badge, add a change indicator to the Files tab when changes occur while the user is on another tab:

```tsx
<button onClick={() => handleTabChange("files")}>
  Files
  {fileChangeCount > 0 && rightTab !== "files" && (
    <span className="ml-1.5 ... bg-blue-600 text-white">
      {fileChangeCount > 99 ? "99+" : fileChangeCount}
    </span>
  )}
</button>
```

The count resets when the user switches to the Files tab (same pattern as terminal unread count).

### Dependency Injection

```typescript
export interface AppDeps {
  // ... existing fields
  fileWatcher?: FileWatcher;
}
```

Tests inject a `FileWatcher` stub that doesn't actually watch the filesystem but can be manually triggered:

```typescript
class StubFileWatcher extends EventEmitter {
  start() {}
  stop() {}
  simulateChanges(paths: string[]) {
    this.emit("changes", paths);
  }
}
```

### Performance Considerations

1. **Debounce window**: 300ms is short enough to feel responsive but long enough to batch `npm install` (which touches thousands of files — all filtered by `node_modules` ignore).
2. **No file content in events**: The server only sends paths. The client decides whether to fetch content. This avoids sending large file contents on every save.
3. **Ignore list**: Filtering `node_modules`, `.git`, etc. at the watcher level prevents unnecessary event processing.
4. **Client-side throttle**: The client should not send more than one `get_file_tree` request per second, even if multiple `files_changed` events arrive rapidly.

### File Layout

| File | Change |
|------|--------|
| `src/server/file-watcher.ts` | New — `FileWatcher` class |
| `src/server/file-watcher.test.ts` | New — unit tests (debounce, ignore patterns, start/stop) |
| `src/server/types.ts` | Add `WsFilesChanged` message type |
| `src/server/index.ts` | Wire up `FileWatcher`, handle events, add to `AppDeps` |
| `src/server/integration.test.ts` | Test that file changes trigger `files_changed` broadcast |
| `src/client/App.tsx` | Handle `files_changed`, add file change badge counter |

### Quality Checklist

- [x] Input validation: No client input — this is a server-push message. Changed paths are sanitized to relative paths.
- [ ] Integration tests: Simulate file changes via `StubFileWatcher`, verify `files_changed` is received by client.
- [ ] Unit tests: Debounce behavior, ignore patterns, start/stop lifecycle.
- [ ] Edge cases: Handle watcher errors gracefully (log and continue), handle rapid file changes during template application.
- [ ] Performance: Verify no event storms during `npm install` or large git operations.
