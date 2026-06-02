# Image & Screenshot Input

Users can attach images to chat messages via drag-and-drop, clipboard paste, or file picker.

## How it works

1. **Client**: `MessageInput` supports drag-and-drop (with drop zone overlay), Ctrl+V paste, and file picker button. Images are converted to base64 and shown as inline thumbnails with remove buttons.
2. **Send**: `send_message` includes optional `images` array with `{ base64, mediaType, filename }` entries.
3. **Server validation**: MIME whitelist (PNG, JPEG, GIF, WebP), max 5MB per image, max 5 images per message, max 20MB total. Rejects with `{ type: "error" }` on violation.
4. **Claude CLI**: Images passed as base64 content blocks via stdin to the CLI process.
5. **Display**: `MessageList` renders image thumbnails in user messages. Clicking opens a lightbox with full-size preview.
6. **Persistence**: Images are persisted in chat history for reload survival.

## Key files

- `src/server/types.ts` — `ImageAttachment` type, extended `WsSendMessage`
- `src/server/index.ts` — Image validation, relay to ClaudeProcess
- `src/server/claude.ts` — Accepts images in `run()`, passes to CLI via stdin
- `src/client/components/MessageInput.tsx` — Drag-and-drop, paste, file picker, thumbnails
- `src/client/components/MessageList.tsx` — Image rendering, `ImageLightbox` component
