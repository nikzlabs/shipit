# 028 — File & Code Context Attachment: Checklist

## Server

- [ ] Add `FileAttachment` interface to `src/server/types.ts`
- [ ] Extend `WsSendMessage` with `files?: FileAttachment[]` in `src/server/types.ts`
- [ ] Add `validateFileAttachments()` function in `src/server/index.ts` (path traversal, 100KB/file, 500KB total, max 10 files)
- [ ] Add `formatFileContext()` function — format files as `<file path="">` tags
- [ ] Prepend file context to prompt in `send_message` handler
- [ ] Extend `WsChatHistoryMessage` with `files` metadata (path + content preview)

## Client

- [ ] Create `FileAutoComplete.tsx` — @ mention autocomplete panel (triggered by `@` in chat input)
- [ ] Create `FileAttachmentChips.tsx` — removable file attachment pills below chat input
- [ ] Add @ trigger detection in `MessageInput.tsx` (keyboard navigation, Enter/Tab to select, Escape to dismiss)
- [ ] Add drag-and-drop support in `FileTree.tsx` (`draggable`, `onDragStart` with `application/x-shipit-file`)
- [ ] Add drop handler in `MessageInput.tsx` for file drag-and-drop
- [ ] Add "Add to Chat" button on files in `FileTree.tsx`
- [ ] Add `pendingFiles` state to `App.tsx`
- [ ] Add `addFileAttachment` / `removeFileAttachment` handlers in `App.tsx`
- [ ] Include `pendingFiles` in `send_message` call, clear after send
- [ ] Display file attachment chips on user messages in `MessageList.tsx`
- [ ] Line range selection support (attach specific lines from editor)

## Tests

- [ ] Integration tests: `src/server/integration_tests/file-context.test.ts`
  - [ ] Happy path: message with files → prompt includes `<file>` tags
  - [ ] Path traversal → error
  - [ ] File too large (>100KB) → error
  - [ ] Total size limit (>500KB) → error
  - [ ] Too many files (>10) → error
  - [ ] Empty path → error
  - [ ] Line range → `<file>` tag includes lines attribute
  - [ ] Chat history persists file metadata
- [ ] Component tests: `src/client/components/FileAutoComplete.test.tsx`
  - [ ] Shows matching files when @ is typed
  - [ ] Arrow key navigation
  - [ ] Enter selects file
  - [ ] Escape dismisses
  - [ ] Filters update as user types
  - [ ] Doesn't trigger on email addresses
- [ ] Component tests: `src/client/components/FileAttachmentChips.test.tsx`
  - [ ] Renders chips for each attached file
  - [ ] Remove button calls handler
  - [ ] Line range badge shows correctly
  - [ ] Long paths are truncated
