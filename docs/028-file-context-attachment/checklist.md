# 028 — File & Code Context Attachment: Checklist

Status: done

## Server

- [x] Add `FileAttachment` interface to `src/server/types.ts`
- [x] Extend `WsSendMessage` with `files?: FileAttachment[]` in `src/server/types.ts`
- [x] Add `validateFileAttachments()` function in `src/server/index.ts` (path traversal, 100KB/file, 500KB total, max 10 files)
- [x] Add `formatFileContext()` function — format files as `<file path="">` tags
- [x] Prepend file context to prompt in `send_message` handler
- [x] Extend `WsChatHistoryMessage` with `files` metadata (path + content preview)

## Client

- [x] Create `FileAutoComplete.tsx` — @ mention autocomplete panel (triggered by `@` in chat input)
- [x] Create `FileAttachmentChips.tsx` — removable file attachment pills below chat input
- [x] Add @ trigger detection in `MessageInput.tsx` (keyboard navigation, Enter/Tab to select, Escape to dismiss)
- [x] Add drag-and-drop support in `FileTree.tsx` (`draggable`, `onDragStart` with `application/x-shipit-file`)
- [x] Add drop handler in `MessageInput.tsx` for file drag-and-drop
- [x] Add "Add to Chat" button on files in `FileTree.tsx`
- [x] Add `pendingFiles` state to `App.tsx`
- [x] Add `addFileAttachment` / `removeFileAttachment` handlers in `App.tsx`
- [x] Include `pendingFiles` in `send_message` call, clear after send
- [x] Display file attachment chips on user messages in `MessageList.tsx`
- [x] Line range selection support (attach specific lines from editor)

## Tests

- [x] Integration tests: `src/server/integration_tests/file-context.test.ts`
  - [x] Happy path: message with files → prompt includes `<file>` tags
  - [x] Path traversal → error
  - [x] File too large (>100KB) → error
  - [x] Total size limit (>500KB) → error
  - [x] Too many files (>10) → error
  - [x] Empty path → error
  - [x] Line range → `<file>` tag includes lines attribute
  - [x] Chat history persists file metadata
- [x] Component tests: `src/client/components/FileAutoComplete.test.tsx`
  - [x] Shows matching files when @ is typed
  - [x] Arrow key navigation
  - [x] Enter selects file
  - [x] Escape dismisses
  - [x] Filters update as user types
  - [x] Doesn't trigger on email addresses
- [x] Component tests: `src/client/components/FileAttachmentChips.test.tsx`
  - [x] Renders chips for each attached file
  - [x] Remove button calls handler
  - [x] Line range badge shows correctly
  - [x] Long paths are truncated
