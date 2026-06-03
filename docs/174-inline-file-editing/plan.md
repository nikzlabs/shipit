---
description: Add a restrained in-app file editor launched from the Files tab and file preview dialog, using Monaco for text files without turning ShipIt into a full IDE.
---

# Inline file editing

## Why this exists

ShipIt's primary editing model is still conversational: the user asks, the agent
edits, verifies, and explains. But there are moments where direct file editing is
the right escape hatch: copy tweaks, small config changes, pasted snippets, or
cases where the user already knows the exact text they want.

The product constraint is that this must stay inside ShipIt and stay secondary.
Direct editing should not become a central workspace mode, a shell-shaped action
surface, or a replacement for the agent. It is a precise manual edit path in the
existing file surfaces.

## Goals

- Add an edit icon beside the existing per-file actions in the Files tab.
- Add an Edit action to the existing file preview dialog header, alongside
  Download when a text file is open.
- Open editing in a separate dialog that closes the preview dialog if one is
  open.
- Use Monaco for syntax highlighting and basic text editing.
- Save changes through an explicit session file-write API so the existing file
  watcher, diff, auto-commit, auto-push, and PR flow see the edit like any other
  workspace change.
- Keep the surface intentionally minimal: no multi-tab editor, no command
  palette, no format button, no terminal-like quick actions.

## Non-goals

- A full IDE editor with tabs, project-wide search, split panes, or rich command
  shortcuts.
- Preview-DOM-to-source editing.
- Editing binary files, images, generated large files, or uploads outside the
  session workspace.
- Collaborative real-time editing.
- Auto-running tests or formatters from buttons after save. The agent can run
  those when the user asks or when the current task calls for it.

## User experience

### Files tab

Each file row already supports hover actions such as Download and Add to chat.
Add an Edit icon in the same row-action cluster for editable text files.

The file name click keeps its current behavior: open the preview dialog. The
Edit icon is a secondary affordance and should appear on hover/focus with the
same visual weight as Download.

When the user clicks Edit:

1. Any open file preview dialog closes.
2. ShipIt loads the current file content.
3. A file edit dialog opens with Monaco focused.

### Preview dialog

When a text/code file is open in `FilePreviewModal`, add an Edit action to the
existing `actions` array before or beside Download. Clicking it closes the
preview dialog and opens the edit dialog for the same file.

Markdown preview should also be editable as source. The edit dialog uses Monaco's
markdown language mode rather than the rendered markdown preview.

Image and binary previews do not show Edit.

### Edit dialog

The dialog is a focused text-edit surface:

- Header: file path, dirty indicator, close button.
- Body: Monaco editor with language inferred from the path.
- Footer: Cancel and Save.

No extra affordances are required for the first version beyond syntax
highlighting, undo/redo from Monaco, and a disabled Save button when unchanged or
currently saving.

Closing with unsaved changes should ask for confirmation before discarding. A
small in-dialog confirmation is enough; do not navigate the user to another
surface.

## Design

### Client state

Extend `useFileStore` with edit-dialog state parallel to preview state:

- `editFile: string | null`
- `editContent: string`
- `editOriginalContent: string`
- `editType: FilePreviewType | null`
- `editLoading: boolean`
- `editSaving: boolean`
- `editError: string | null`
- `openEditor(sessionId, filePath)`
- `closeEditor(opts?: { force?: boolean })`
- `setEditContent(content)`
- `saveEditor(sessionId)`

`openEditor` should call `closePreview()` before setting edit state. This keeps
the preview and edit dialogs mutually exclusive and avoids stacked modals.

The edit dialog should not reuse `FilePreviewModal`'s `CodeEditor` directly.
That editor is read-only and wired to line/selection comments. Create a small
editing-specific Monaco component, for example `FileEditModal` with an internal
`EditableCodeEditor`, so review-comment behavior and save behavior do not share
state accidentally.

### API

Add a file write endpoint beside the existing file read/download routes:

`PUT /api/sessions/:id/files/*`

Request body:

```json
{ "content": "new file contents" }
```

Response body:

```json
{ "path": "src/App.tsx", "size": 1234 }
```

Server behavior:

- Resolve paths with the same workspace-boundary checks as `getFileContent`.
- Refuse upload paths (`uploads/`), path traversal, directories, binary targets,
  and files over the existing text preview size limit unless a separate edit
  limit is deliberately chosen.
- Validate `content` is a string.
- Write UTF-8 content with `fs.writeFile`.
- Return a typed `ServiceError` for invalid paths, oversized payloads, binary
  files, and missing files.

This endpoint belongs in `services/files.ts` as a service function consumed by
`api-routes-files.ts`, matching the existing route-service pattern.

### File freshness

For the first implementation, saving can be last-write-wins. That matches the
scope of a small manual escape hatch and avoids adding a conflict model before
there is evidence it is needed.

However, the save API should be easy to extend later with an optimistic
concurrency field such as `baseHash` or `mtimeMs`. The client should keep
`editOriginalContent` locally so a later conflict UI can diff the user's draft
against the current file.

### File tree and preview actions

Update `FileTree` props with `onEdit?: (filePath: string) => void` and render an
edit icon in the same row-action cluster as Download. Use the existing icon
library and tooltip/title pattern.

Update `handleOpenFilePreview` in `App.tsx` so the preview actions for editable
text files include Edit and Download. The Edit action should call the store's
`openEditor` for the current session and file path.

Editable detection should be conservative:

- Allow file types that `detectFilePreviewType(path)` classifies as `code` or
  `markdown`.
- Hide Edit for `image` and `binary`.
- If a server read still returns binary or too-large content, open the edit
  dialog as an error state rather than showing an editable buffer.

### Agent and history interaction

Manual saves are workspace mutations, not chat transcript content. They should
not add a chat card by default and should not send an automatic message to the
agent. The user can ask the agent to review or test the change after saving.

Because file writes happen in the session workspace, the existing file watcher
should refresh the file tree/diff state. The normal post-turn auto-commit path
does not run immediately because no agent turn ended; the implementation should
verify whether user-driven file writes need an explicit commit trigger or can be
covered by the existing ShipIt auto-commit/PR lifecycle after the next agent
turn. If immediate PR updates are desired, add that as a follow-up design rather
than hiding it inside the editor.

## Key files

- `src/client/components/FileTree.tsx` — add the per-file Edit icon.
- `src/client/components/FileEditModal.tsx` — new focused Monaco edit dialog.
- `src/client/stores/file-store.ts` — editor state, load, dirty tracking, save.
- `src/client/App.tsx` — wire Files tab edit action, preview-header Edit action,
  and render the edit dialog.
- `src/client/utils/file-preview-type.ts` — conservative editable-file detection.
- `src/server/orchestrator/services/files.ts` — safe UTF-8 file write service.
- `src/server/orchestrator/api-routes-files.ts` — `PUT /api/sessions/:id/files/*`.

## Verification

- Unit-test editable-file detection and `FileTree` edit action rendering.
- Component-test `FileEditModal` dirty state, disabled Save, discard
  confirmation, and save error state.
- Integration-test the write endpoint for success, path traversal rejection,
  directory rejection, missing file, binary file, and oversized payload.
- Browser-check the live UI:
  - Files tab Edit opens the editor.
  - Preview Edit closes preview and opens editor.
  - Save changes the file, closes or clears dirty state as designed, and the
    file tree/diff surfaces update.
  - Image and binary files do not expose Edit.
