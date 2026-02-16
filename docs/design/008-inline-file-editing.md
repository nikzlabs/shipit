# Design Doc 008: Inline File Editing

## Status: Proposed

## Problem

"Pure vibe coding" — where users never edit code directly — sounds clean in theory. In practice, users regularly want to make trivial changes: tweak a color value, fix a typo, adjust a margin. Asking Claude to do these takes 10-30 seconds. Typing it directly takes 2 seconds.

Specific pain points:
1. **Trivial edits are slow** — asking Claude to change `color: blue` to `color: red` is a full round-trip.
2. **Read-only frustration** — users can see the file content but can't touch it.
3. **Context switching** — users must switch to an external editor to make small fixes.

## Goals

1. Add inline editing to the file content viewer using CodeMirror 6.
2. Save edits via Ctrl+S, with auto-commit to maintain git-as-undo guarantees.
3. Handle conflicts when Claude edits the same file the user has open.

## Non-Goals

- Creating new files via the editor (that's Claude's job).
- Multi-file editing / tabs.
- Full IDE features (autocomplete, go-to-definition, etc.).
- Directory creation.

## Design

### Approach: CodeMirror 6 in FileContentViewer

Replace the read-only `<pre><code>` in `FileContentViewer` with a CodeMirror 6 editor instance. CodeMirror 6 is:
- Small (tree-shakeable, ~50KB gzipped for basic setup).
- Fast (handles large files well).
- Extensible (syntax highlighting, keymaps, themes).

### UI Changes

#### FileContentViewer → FileEditor

- Toggle between read-only and edit mode (pencil icon in the header bar).
- Edit mode: CodeMirror 6 with the file's language mode.
- Save: Ctrl+S / Cmd+S sends the modified content to the server.
- Unsaved indicator: dot on the tab or filename when modified.
- Auto-save on tab switch or file switch (with confirmation if unsaved changes exist).
- Discard: Escape or "Discard" button reverts to the last saved version.

### Protocol Changes

```typescript
// Client → Server
interface WsSaveFile {
  type: "save_file";
  path: string;
  content: string;
}

// Server → Client
interface WsFileSaved {
  type: "file_saved";
  path: string;
  commitHash: string;  // auto-committed
}
```

### Server Changes

#### `index.ts` — `save_file` handler

1. Validate path (same traversal guard as `get_file_content`).
2. Write the file content to disk.
3. Auto-commit via `GitManager.autoCommit("Manual edit: {filename}")`.
4. Broadcast `file_saved` to all clients.
5. Trigger preview refresh if Vite is running (HMR handles this automatically).

#### Validation

- Path must be within `/workspace`.
- Content must be a string (not binary).
- File must already exist (no creating new files via the editor).
- Max file size: 1 MB (same as viewer limit).

### Conflict Resolution

If Claude edits a file while the user has unsaved changes in the editor, the user's changes would be overwritten. When a `git_committed` event arrives and the user has unsaved changes to the same file, show a conflict dialog: "Claude modified this file. Keep your changes or load Claude's version?"

### Dependencies

New dependency: `codemirror` and language packages.

```json
{
  "codemirror": "^6.0.0",
  "@codemirror/lang-javascript": "^6.0.0",
  "@codemirror/lang-html": "^6.0.0",
  "@codemirror/lang-css": "^6.0.0",
  "@codemirror/lang-json": "^6.0.0",
  "@codemirror/lang-python": "^6.0.0",
  "@codemirror/lang-markdown": "^6.0.0",
  "@codemirror/theme-one-dark": "^6.0.0"
}
```

Bundle impact: ~80KB gzipped (acceptable for the value delivered).

### File Layout

| File | Change |
|------|--------|
| `src/server/types.ts` | Add `WsSaveFile` and `WsFileSaved` message types |
| `src/server/index.ts` | `save_file` handler — validate, write, auto-commit, broadcast |
| `src/server/integration.test.ts` | Test `save_file` writes to disk, auto-commits, returns `file_saved`; test path traversal rejected |
| `src/client/components/FileContentViewer.tsx` | Replace `<pre><code>` with CodeMirror 6, add edit toggle |
| `src/client/components/FileContentViewer.test.tsx` | Tests for CodeMirror render, Ctrl+S save, unsaved indicator, mode toggle, conflict dialog |
| `package.json` | Add `codemirror` and `@codemirror/lang-*` dependencies |

### Quality Checklist

- [ ] Input validation: Validate `path` (traversal guard), `content` (string type, max 1 MB), file must exist. Return `{ type: "error" }` on invalid input.
- [ ] Component tests: FileEditor renders CodeMirror, Ctrl+S triggers save, unsaved indicator, mode toggle, conflict dialog.
- [ ] Integration tests: `save_file` writes to disk, auto-commits, returns `file_saved` with commit hash; path traversal rejected.
- [ ] Edge cases: Handle concurrent saves, handle file deleted while editing, handle Claude editing the same file (conflict dialog).
