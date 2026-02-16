# Design Doc 005: Image & Screenshot Input (Multimodal Chat)

## Status: Proposed

## Problem

The single most requested vibe coding workflow is: *"Make it look like this"* with a screenshot. Currently, users must describe visual designs in words. Claude Code CLI already supports image inputs — ShipIt just doesn't expose them to the browser.

This is the highest-impact gap because it blocks the core promise of vibe coding: show, don't tell.

Specific pain points:
1. **No visual reference** — users cannot share Figma mockups, wireframes, or screenshots of bugs.
2. **Verbose descriptions** — describing layouts, colors, and spacing in text is slow and error-prone.
3. **Bug reporting friction** — when the preview breaks, users must describe what they see instead of screenshotting it.

## Goals

1. Support drag-and-drop, paste, and file-picker image upload into chat.
2. Show image thumbnails inline in input and message history.
3. Relay images to Claude CLI via base64 content blocks.
4. Persist images in chat history so they survive page reloads.

## Non-Goals

- Non-image file uploads (PDFs, code files) — follow-up feature.
- Client-side image compression/resize — follow-up optimization.
- Camera capture on mobile.

## Design

### UI Changes

#### MessageInput enhancements

- Paperclip/image button next to the send button.
- Drag-and-drop onto the chat input area (full left panel acts as drop zone).
- Ctrl+V / Cmd+V paste of clipboard images.
- Image thumbnails inline in the input area before sending, with × to remove.
- Multiple images per message (up to 5).
- Accepted formats: PNG, JPEG, GIF, WebP (same as Claude's vision support).
- Max size: 5 MB per image (reject larger with a toast message).

#### MessageList enhancements

- User messages with images render thumbnails inline (clickable to expand).
- Lightbox overlay for full-size image viewing.

#### Drop zone UX

- When dragging a file over the chat panel, show a blue overlay border with "Drop image here".
- Only accept image MIME types — ignore non-image files with a brief toast.

### Protocol Changes

Extend the existing `send_message` WebSocket message:

```typescript
// Client → Server
interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: Array<{
    data: string;      // base64-encoded image data
    mediaType: string; // "image/png", "image/jpeg", etc.
    filename?: string; // optional original filename
  }>;
}
```

The `images` field is optional and backward-compatible.

### Server Changes

#### `index.ts` — `send_message` handler

1. Validate each image: check base64 is valid, mediaType is allowed, size ≤ 5 MB decoded.
2. Write images to `/workspace/.vibe-images/{sessionId}/{timestamp}-{index}.{ext}`.
3. Construct the Claude CLI invocation with image content blocks.

#### `claude.ts` — image support

Claude Code CLI supports images via stdin when using `--input-format stream-json`. The server sends a user message with image content blocks:

```json
{
  "type": "user",
  "message": {
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
      { "type": "text", "text": "Make it look like this" }
    ]
  }
}
```

#### Validation

- Image count: max 5 per message.
- Image size: max 5 MB per image (base64 decoded).
- MIME type whitelist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- Total payload: max 20 MB per WebSocket message (reject with `{ type: "error" }`).

### Chat History Persistence

Extend `WsChatHistoryMessage`:

```typescript
interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: Array<ToolUseBlock>;
  images?: Array<{
    path: string;       // server-side path to saved image
    mediaType: string;
  }>;
  isError?: boolean;
}
```

Images are saved to disk alongside chat history. On history reload, the client requests images via a new `get_image` message (or the server inlines base64 for small images).

### File Layout

| File | Change |
|------|--------|
| `src/server/types.ts` | Extend `WsSendMessage` with `images` field |
| `src/server/index.ts` | Validate images, write to disk, pass to Claude CLI |
| `src/server/claude.ts` | Accept image content blocks in `run()` |
| `src/client/App.tsx` | Handle image state, pass images in `send_message` |
| `src/client/components/MessageInput.tsx` | Drag-and-drop, paste, file picker, thumbnails |
| `src/client/components/MessageInput.test.tsx` | Tests for drag-and-drop, paste, thumbnail rendering, remove |
| `src/client/components/MessageList.tsx` | Render image thumbnails in user messages |
| `src/client/components/MessageList.test.tsx` | Tests for image display |
| `src/server/integration.test.ts` | Send `send_message` with images, verify Claude receives them; reject invalid MIME/oversized |

### Quality Checklist

- [ ] Input validation: Validate base64, MIME type whitelist, size limits, image count. Return `{ type: "error" }` on invalid input.
- [ ] Component tests: `MessageInput` — drag-and-drop, paste, thumbnail rendering, remove button. `MessageList` — image display in user messages.
- [ ] Integration tests: `send_message` with `images` happy path; error on invalid MIME type; error on oversized payload.
- [ ] Edge cases: Handle 0 images gracefully, handle paste of non-image clipboard data, handle concurrent image uploads.
