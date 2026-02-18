---
status: in-progress
---
# File Browser

The Files tab shows the workspace directory structure as an expandable tree with a read-only file content viewer.

## File tree

### Scanning

`scanFileTree(dir)` recursively scans the workspace, returns `FileTreeNode[]` (name, path, type, children). Sorted: directories first, then files, alphabetically.

### Filtered directories

Skipped: `node_modules`, `.git`, `.vibe-chat-history`, `dist`, `.next`, `.cache`, `.vite`, hidden files (except `.env`, `.env.local`).

### UI behavior

- Root-level directories auto-expanded on first render
- Click directory → toggle expand/collapse
- Click file → opens content viewer
- Empty state: placeholder suggesting to ask Claude to create a project
- Auto-refresh: on `git_committed` event (if Files tab active) and on `files_changed` events

## File content viewer

### Flow

1. Click file in tree → `App.tsx` sends `{ type: "get_file_content", path }`
2. Server resolves path relative to workspace, validates against path traversal
3. Server reads file, responds with `{ type: "file_content", path, content }`
4. `FileContentViewer` renders with syntax highlighting via `hljs.highlight()` or `hljs.highlightAuto()`

### Safety guards

- **Path traversal**: `path.resolve()` + `startsWith()` check
- **Large files**: Over 1MB rejected with size info
- **Binary detection**: Checks for null bytes, shows "Binary file — cannot display"

### Auto-refresh

On `git_committed` or `files_changed` while viewer is open, re-requests the file content.

## File watcher

`FileWatcher` class uses `fs.watch` with `recursive: true`. Debounces (300ms default) and deduplicates change events. Emits `"changes"` event, server broadcasts `files_changed` to clients.

### Ignore patterns

`node_modules`, `.git`, `.vite`, `.next`, `.cache`, `dist`, `.shipit-usage.json`, `.vibe-sessions.json`, `.vibe-chat-history`

### Change badge

When Files tab is not active, a badge shows count of changes since tab was last viewed. Resets on tab switch.

## Key files

- `src/server/file-tree.ts` — `scanFileTree(dir)` recursive scanner
- `src/server/file-watcher.ts` — `FileWatcher` class
- `src/server/index.ts` — `get_file_tree`, `get_file_content` handlers, file watcher wiring
- `src/server/types.ts` — `FileTreeNode`, file-related WS messages
- `src/client/components/FileTree.tsx` — Tree component, expand/collapse, file click
- `src/client/components/FileContentViewer.tsx` — Read-only viewer with syntax highlighting
- `src/client/App.tsx` — File tree state, viewer state, auto-refresh logic
