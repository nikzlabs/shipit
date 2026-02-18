# 025 — In-Browser Code Editor: Checklist

## Dependencies

- [ ] Add CodeMirror 6 packages to `package.json` (`codemirror`, `@codemirror/lang-javascript`, `@codemirror/lang-html`, `@codemirror/lang-css`, `@codemirror/lang-json`, `@codemirror/lang-markdown`, `@codemirror/lang-python`)

## Server

- [ ] Add `WsSaveFile` and `WsFileSaved` message types to `src/server/types.ts`
- [ ] Add `save_file` handler in `src/server/index.ts` (path traversal guard, 1MB limit, auto-commit)

## Client

- [ ] Create `FileEditor.tsx` — CodeMirror 6 editor with syntax highlighting, line numbers, dark theme
- [ ] Language detection from file extension (`languageExtension()` helper)
- [ ] Save via Ctrl+S / Cmd+S → `save_file` WS message
- [ ] Dirty indicator ("Modified" badge in status bar)
- [ ] Status bar with line/column position and language name
- [ ] Read-only mode for binary files
- [ ] Auto-resize to fill available panel space
- [ ] Unsaved changes prompt on close (Escape key)
- [ ] Replace `FileContentViewer` with `FileEditor` in `App.tsx` right panel
- [ ] Add `handleFileSave` callback in `App.tsx`
- [ ] Handle `file_saved` message in `App.tsx`
- [ ] File conflict detection — when Claude edits a file the user has open (unsaved: show dialog, saved: silent reload)

## Tests

- [ ] Integration tests: `src/server/integration_tests/code-editor.test.ts`
  - [ ] Save file → file written to disk → `file_saved` response with commit hash
  - [ ] Path traversal → error
  - [ ] Empty path → error
  - [ ] Auto-commit created on save
  - [ ] Save to non-existent path → file and directories created
- [ ] Component tests: `src/client/components/FileEditor.test.tsx`
  - [ ] Renders editor with correct content
  - [ ] Language detection for .tsx, .css, .json, etc.
  - [ ] Ctrl+S triggers onSave callback
  - [ ] Modified indicator appears after editing
  - [ ] Close with unsaved changes shows confirmation
  - [ ] Read-only mode for binary files
  - [ ] Status bar shows line/column on cursor move
