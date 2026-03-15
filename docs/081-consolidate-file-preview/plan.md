---
status: done
---

# Consolidate File Preview

## Problem

File previews are inconsistent across ShipIt:

| Context | Current behavior | Issues |
|---------|-----------------|--------|
| **Docs tab** | Opens `DocModal` — full-screen modal with rendered markdown | Works well; becomes the reference pattern |
| **File tree** | Inline `FileContentViewer` replaces the file tree panel | Cramped, no escape-to-close, different UX from docs |
| **Uploaded files** | Chip badges only — no preview at all | Users can't verify what they uploaded |
| **Message file attachments** | Chip badges — no click-to-preview | Dead end; users see a path but can't view content |
| **Image files** | `ImageLightbox` for message images; file tree says "Binary file — cannot display." | Two separate systems, and file tree can't show images at all |

## Goal

One unified `FilePreviewModal` that opens from any context. Clicking a file — whether in the file tree, an upload chip, a message attachment, or a doc link — opens the same modal with content appropriate to the file type.

## Design

### Unified modal: `FilePreviewModal`

Replaces `DocModal`, `FileContentViewer`, and `ImageLightbox` with a single modal component that renders content based on file type:

```
FilePreviewModal
├── Header: file path + close button (X) + optional action buttons
├── Content area (one of):
│   ├── Markdown renderer   — .md files (existing marked.parse flow)
│   ├── Code viewer         — text/code files (existing highlight.js flow)
│   ├── Image viewer        — image files (png, jpg, gif, webp, svg)
│   └── Binary placeholder  — unsupported binary files
└── Keyboard: Escape to close
```

**Props:**

```ts
interface FilePreviewModalProps {
  filePath: string;
  content: string | null;       // text content or base64 data URI for images
  fileType: "markdown" | "code" | "image" | "binary";
  isLoading?: boolean;
  actions?: Array<{             // optional header action buttons
    label: string;
    onClick: () => void;
    variant?: "primary" | "default";
  }>;
  onClose: () => void;
}
```

The modal uses the existing `<Modal>` primitive with the same dimensions as `DocModal` (`w-[90vw] max-w-4xl h-[85vh]`).

### File type detection

A shared utility determines the preview mode from the file path:

```ts
function detectFilePreviewType(filePath: string): "markdown" | "code" | "image" | "binary";
```

- **Markdown**: `.md` extension
- **Image**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`
- **Code**: all other text files (determined after content fetch — if server says `isBinary`, fall back to binary)
- **Binary**: server returns `isBinary: true` for non-image files

### Store changes: `file-store.ts`

Add a single `openPreview` action that any UI context calls:

```ts
interface FileState {
  // ... existing state ...

  // New unified preview state
  previewFile: string | null;
  previewContent: string | null;
  previewType: "markdown" | "code" | "image" | "binary" | null;
  previewLoading: boolean;
  previewActions: Array<{ label: string; onClick: () => void; variant?: string }>;

  // New unified actions
  openPreview: (sessionId: string, filePath: string, opts?: {
    actions?: Array<{ label: string; onClick: () => void; variant?: string }>;
  }) => Promise<void>;
  openPreviewWithContent: (filePath: string, content: string, type: "markdown" | "code" | "image") => void;
  closePreview: () => void;
}
```

- `openPreview(sessionId, filePath)` — fetches content from the server, detects type, opens modal. Used by file tree and message attachment clicks.
- `openPreviewWithContent(filePath, content, type)` — opens modal with already-available content. Used by message images (base64 data already in memory) and docs (content already fetched).
- `closePreview()` — resets preview state.

### Server changes: image file support

Update `getFileContent()` in `services/files.ts` to return base64-encoded content for known image extensions instead of "Binary file — cannot display.":

```ts
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export async function getFileContent(dir: string, filePath: string) {
  // ... existing path safety and size checks ...

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    const buf = await fs.readFile(safePath);
    const mimeType = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    return {
      content: `data:${mimeType};base64,${buf.toString("base64")}`,
      isImage: true,
    };
  }

  // ... existing text/binary detection ...
}
```

Size limit for images: keep the existing 1 MB cap for text files, raise to 10 MB for images (reasonable for preview).

### Integration points — what opens the modal

| Trigger | How it works |
|---------|-------------|
| **File tree click** | `onFileClick` calls `openPreview(sessionId, filePath)` instead of `fetchFile()` |
| **Doc click** | `fetchDoc` then `openPreviewWithContent(path, content, "markdown")` with "Start Session" action |
| **Message image click** | `openPreviewWithContent(name, dataUri, "image")` instead of per-component `ImageLightbox` state |
| **Message file attachment click** | `onFileClick` calls `openPreview(sessionId, filePath)` — chips become clickable |
| **Upload chip click** | `openPreview(sessionId, uploadPath)` — upload chips become clickable |

### Components removed after migration

- `DocModal.tsx` — logic moves into `FilePreviewModal`
- `ImageLightbox` in `message-media.tsx` — replaced by modal
- `FileContentViewer.tsx` — logic moves into `FilePreviewModal`

The `MessageImages` component keeps its thumbnail grid but opens `FilePreviewModal` on click instead of inline `ImageLightbox`.

### Syntax highlighting

Reuse the existing `languageFromPath()` and `hljs` logic from `FileContentViewer.tsx`, extracted to a shared utility (`src/client/utils/syntax-highlight.ts`) so both the modal code view and any future inline uses can share it.

## Key files

| File | Change |
|------|--------|
| `src/client/components/FilePreviewModal.tsx` | **New** — unified modal component |
| `src/client/utils/file-preview-type.ts` | **New** — `detectFilePreviewType()` utility |
| `src/client/utils/syntax-highlight.ts` | **New** — extracted highlight.js logic |
| `src/client/stores/file-store.ts` | Add preview state + `openPreview`/`closePreview` actions |
| `src/server/orchestrator/services/files.ts` | Return base64 for image files |
| `src/client/App.tsx` | Mount `FilePreviewModal`, remove `DocModal` + `FileContentViewer` usage |
| `src/client/components/message-media.tsx` | Remove `ImageLightbox`, wire clicks to store |
| `src/client/components/FileTree.tsx` | No changes needed (already uses `onFileClick` callback) |
| `src/client/components/FileUploadChips.tsx` | Add click handler to open preview |
| `src/client/components/DocModal.tsx` | **Delete** after migration |
| `src/client/components/FileContentViewer.tsx` | **Delete** after migration |

## Migration plan

1. Create `FilePreviewModal`, `detectFilePreviewType`, and `syntax-highlight` utility
2. Add preview state and actions to `file-store.ts`
3. Update server `getFileContent()` for image support
4. Wire file tree clicks to `openPreview`
5. Wire doc clicks to `openPreviewWithContent`
6. Wire message image clicks to `openPreviewWithContent`
7. Make message file attachment chips clickable
8. Make upload chips clickable
9. Remove `DocModal`, `FileContentViewer`, `ImageLightbox`
10. Update tests
