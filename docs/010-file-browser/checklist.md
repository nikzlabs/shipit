# File Browser — Remaining Work

- Inline file editing — replace read-only viewer with CodeMirror 6 editor
  - Add CodeMirror 6 dependencies (`codemirror`, `@codemirror/lang-*`, `@codemirror/theme-one-dark`)
  - Toggle between read-only and edit mode (pencil icon)
  - Save via Ctrl+S / Cmd+S → `save_file` WS message → server writes + auto-commits
  - Unsaved indicator (dot on filename), auto-save on tab/file switch
  - Conflict dialog when Claude edits the same file user has open
  - Server `save_file` handler with path traversal guard, 1MB limit, file-must-exist check
