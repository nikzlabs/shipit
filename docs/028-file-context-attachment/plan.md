# 028 — File & Code Context Attachment

## Summary

Let users attach files from the workspace to their chat messages, so Claude sees specific file content as context alongside the prompt. Currently the only attachment type is images (doc 008). This adds file/code context — the most-requested missing feature for effective vibe coding.

## Motivation

Today, when a user wants Claude to modify a specific file or understand existing code, they have two options:
1. **Hope Claude reads it**: Claude's tools include file reading, but the user can't guarantee Claude will read the right files before making changes
2. **Paste code into the message**: Copy code from the file viewer and paste it into the chat input — lossy (no file path context), tedious, and doesn't scale to multiple files

This is the biggest productivity gap vs. Cursor, Windsurf, and Claude Code Desktop, all of which let you `@`-mention files or drag files into the prompt. With explicit file context, users can say "refactor this function in @src/utils/format.ts" and Claude sees the full file without needing a tool call first.

## How It Works

### User Interactions

Three ways to attach files:

1. **@ mention in chat input**: Type `@` to trigger a file picker autocomplete
2. **Drag from file tree**: Drag a file from the FileTree panel into the chat input area
3. **"Add to Chat" button**: Right-click or button on a file in the file tree / file editor

All three result in the same outcome: a `FileAttachment` added to the message before sending.

### Data Model

```typescript
// src/server/types.ts — additions

export interface FileAttachment {
  /** Relative path within the workspace (e.g., "src/utils/format.ts"). */
  path: string;
  /** Full file content at the time of attachment. */
  content: string;
  /** Optional line range — if the user selected specific lines. */
  startLine?: number;
  endLine?: number;
}

// Extend the existing WsSendMessage:
export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];  // ← NEW
}
```

### Server-Side

#### File Content Resolution

When the server receives a `send_message` with `files`, it:

1. **Validates each file attachment**:
   - Path must be non-empty and within the session workspace (prevent path traversal)
   - Content must be a string (no binary)
   - Individual file size limit: 100KB (prevent accidentally attaching node_modules files)
   - Total attachment size limit: 500KB across all files
   - Maximum 10 files per message

2. **Formats the context** for Claude's prompt:

```typescript
function formatFileContext(files: FileAttachment[]): string {
  return files.map(f => {
    const lineRange = f.startLine && f.endLine
      ? ` (lines ${f.startLine}-${f.endLine})`
      : "";
    const header = `<file path="${f.path}"${lineRange}>`;
    return `${header}\n${f.content}\n</file>`;
  }).join("\n\n");
}
```

3. **Prepends the context** to the user's message before sending to Claude CLI:

```typescript
// In the send_message handler:
let prompt = msg.text;

if (msg.files && msg.files.length > 0) {
  const validated = validateFileAttachments(msg.files, activeSessionDir);
  if (validated.error) {
    send({ type: "error", message: validated.error });
    return;
  }

  const context = formatFileContext(validated.files);
  prompt = `${context}\n\n${prompt}`;
}

// Then pass `prompt` to claudeProcess.run(...)
```

This approach is simple and robust: the file content becomes part of the prompt text. Claude sees the files in `<file>` tags with the path, making it easy to reference and edit them. No changes to the Claude CLI interface are needed.

#### Validation Function

```typescript
function validateFileAttachments(
  files: FileAttachment[],
  sessionDir: string,
): { files: FileAttachment[]; error: string | null } {
  if (!Array.isArray(files) || files.length === 0) {
    return { files: [], error: null };
  }

  if (files.length > 10) {
    return { files: [], error: "Maximum 10 file attachments per message" };
  }

  const validated: FileAttachment[] = [];
  let totalSize = 0;

  for (const file of files) {
    const filePath = typeof file.path === "string" ? file.path.trim() : "";
    if (!filePath) {
      return { files: [], error: "File path is required" };
    }

    // Path traversal check
    const resolved = path.resolve(sessionDir, filePath);
    if (!resolved.startsWith(sessionDir)) {
      return { files: [], error: `Invalid file path: ${filePath}` };
    }

    const content = typeof file.content === "string" ? file.content : "";
    const size = Buffer.byteLength(content, "utf-8");

    if (size > 100 * 1024) {
      return { files: [], error: `File too large: ${filePath} (max 100KB per file)` };
    }

    totalSize += size;
    if (totalSize > 500 * 1024) {
      return { files: [], error: "Total file attachments exceed 500KB" };
    }

    validated.push({
      path: filePath,
      content,
      startLine: file.startLine,
      endLine: file.endLine,
    });
  }

  return { files: validated, error: null };
}
```

#### Chat History Persistence

File attachments are persisted in chat history alongside images:

```typescript
// In chat-history.ts — extend WsChatHistoryMessage:
export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseEntry[];
  images?: Array<{ data: string; mediaType: string }>;
  files?: Array<{ path: string; contentPreview: string }>;  // ← NEW (store path + first 200 chars, not full content)
  isError?: boolean;
}
```

**Note**: We store only a preview of the file content in history (first 200 chars) to keep the history file small. The full content was already sent to Claude in the prompt — it doesn't need to be stored again.

### Client-Side

#### @ Mention Autocomplete

When the user types `@` in the `MessageInput` textarea, show a floating autocomplete panel:

```
┌─────────────────────────────────────┐
│ Tell Claude to refactor @src/u█     │
├─────────────────────────────────────┤
│ 📄 src/utils/format.ts             │
│ 📄 src/utils/validate.ts           │
│ 📁 src/utils/ (directory)          │
│ 📄 src/utils.test.ts               │
└─────────────────────────────────────┘
```

**Behavior:**
- Triggered when `@` is typed (not preceded by a word character, to avoid email addresses)
- Shows files matching the text after `@`, using the existing file tree data
- Arrow keys to navigate, Enter/Tab to select, Escape to dismiss
- On selection: replaces `@partial` with the file path (e.g., `@src/utils/format.ts`) and adds a `FileAttachment` to the pending attachments list
- The file content is fetched when attached (via existing `get_file_content` message)

#### File Attachment Chips

Below the chat input, show attached files as removable chips (similar to image previews):

```
┌─────────────────────────────────────────────────┐
│                                                 │
│ [📄 src/utils/format.ts ×] [📄 package.json ×] │
│                                                 │
│ Refactor the formatDate function to use ISO 8601│
│                                                 │
│                                          [Send] │
└─────────────────────────────────────────────────┘
```

Each chip shows:
- File icon
- File path (truncated if long)
- Remove button (×)
- Optional line range badge (e.g., "L12-45") if a specific range was selected

#### Drag and Drop from File Tree

The `FileTree` component already renders file items. Add drag support:

```typescript
// In FileTree's file item:
<div
  draggable
  onDragStart={(e) => {
    e.dataTransfer.setData("application/x-shipit-file", JSON.stringify({
      path: file.path,
    }));
    e.dataTransfer.effectAllowed = "copy";
  }}
>
  {file.name}
</div>
```

The `MessageInput` component listens for drop events:

```typescript
// In MessageInput:
const handleDrop = (e: DragEvent) => {
  e.preventDefault();
  const fileData = e.dataTransfer?.getData("application/x-shipit-file");
  if (fileData) {
    const { path } = JSON.parse(fileData);
    addFileAttachment(path);
  }
};
```

#### "Add to Chat" from File Tree / Editor

Add a context action to files in the file tree:

```typescript
// In FileTree — on file right-click or via a "+" button:
<button
  onClick={() => onAddToChat(file.path)}
  title="Add to chat context"
>
  +
</button>
```

And in the code editor (doc 025), a button in the toolbar:

```
┌──────────────────────────────────────────────┐
│ src/utils/format.ts    [Add to Chat] [Close] │
```

#### Line Range Selection

When a user selects lines in the code editor and clicks "Add to Chat", only the selected range is attached:

```typescript
// In FileEditor:
const handleAddToChat = () => {
  const selection = editorView.state.selection.main;
  const startLine = editorView.state.doc.lineAt(selection.from).number;
  const endLine = editorView.state.doc.lineAt(selection.to).number;

  onAddToChat(filePath, {
    startLine,
    endLine,
    content: editorView.state.sliceDoc(
      editorView.state.doc.line(startLine).from,
      editorView.state.doc.line(endLine).to,
    ),
  });
};
```

This allows precise context: "refactor these specific lines" instead of sending the entire file.

#### State in App.tsx

```typescript
// New state for pending file attachments
const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);

const addFileAttachment = useCallback(async (filePath: string, range?: { startLine: number; endLine: number; content: string }) => {
  // Check for duplicates
  if (pendingFiles.some(f => f.path === filePath && f.startLine === range?.startLine)) return;

  // Check limit
  if (pendingFiles.length >= 10) {
    // Show error toast
    return;
  }

  if (range) {
    setPendingFiles(prev => [...prev, {
      path: filePath,
      content: range.content,
      startLine: range.startLine,
      endLine: range.endLine,
    }]);
  } else {
    // Fetch full file content
    // Use existing get_file_content mechanism or read from cached file tree
    const content = await fetchFileContent(filePath);
    setPendingFiles(prev => [...prev, { path: filePath, content }]);
  }
}, [pendingFiles]);

const removeFileAttachment = useCallback((filePath: string) => {
  setPendingFiles(prev => prev.filter(f => f.path !== filePath));
}, []);

// When sending a message, include pending files
const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
  send({
    type: "send_message",
    text,
    sessionId: activeSessionId,
    images,
    files: pendingFiles.length > 0 ? pendingFiles : undefined,
  });
  setPendingFiles([]);  // Clear after send
}, [pendingFiles, activeSessionId]);
```

#### Message Display

In `MessageList.tsx`, show file attachments on user messages:

```tsx
{msg.files && msg.files.length > 0 && (
  <div className="flex flex-wrap gap-1.5 mt-1.5">
    {msg.files.map((f) => (
      <span
        key={`${f.path}-${f.startLine ?? 0}`}
        className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-800 rounded text-xs text-gray-300"
        title={f.startLine ? `${f.path} (lines ${f.startLine}-${f.endLine})` : f.path}
      >
        📄 {f.path.split("/").pop()}
        {f.startLine && <span className="text-gray-500">L{f.startLine}-{f.endLine}</span>}
      </span>
    ))}
  </div>
)}
```

### Prompt Engineering

The file context is prepended to the user's message using `<file>` tags:

```
<file path="src/utils/format.ts">
import { format } from "date-fns";

export function formatDate(date: Date): string {
  return format(date, "MM/dd/yyyy");
}

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
</file>

<file path="src/utils/validate.ts" lines="12-25">
export function validateEmail(email: string): boolean {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}
</file>

Refactor formatDate to use ISO 8601 format and add a new formatTime function.
```

This format is clear and unambiguous. Claude can reference the files by path and modify them accurately. The `<file>` tags are a common convention that Claude handles well.

## Testing

### Integration Tests (`src/server/integration_tests/file-context.test.ts`)
1. **Happy path**: Send message with file attachments → verify prompt includes file content in `<file>` tags
2. **Path traversal**: Attach file with `../../../etc/passwd` → error
3. **File too large**: Attach 200KB file → error (max 100KB)
4. **Total size limit**: Attach 6 files of 100KB each → error (max 500KB total)
5. **Too many files**: Attach 11 files → error (max 10)
6. **Empty path**: Attach file with empty path → error
7. **Line range**: Attach with startLine/endLine → verify `<file>` tag includes lines attribute
8. **Chat history**: Verify file attachment metadata persisted in history (path + preview only)

### Component Tests

#### `src/client/components/MessageInput.test.tsx` (extend)
1. @ trigger shows autocomplete panel
2. File selection adds attachment chip
3. Removing chip removes attachment
4. Max 10 files enforced
5. Drop event adds file attachment
6. Send includes files in message

#### `src/client/components/FileAttachmentChips.test.tsx` (new)
1. Renders chips for each attached file
2. Remove button calls handler
3. Line range badge shows correctly
4. Long paths are truncated
5. File icon renders

#### `src/client/components/FileAutoComplete.test.tsx` (new)
1. Shows matching files when @ is typed
2. Arrow key navigation works
3. Enter selects file
4. Escape dismisses
5. Filters update as user types
6. Doesn't trigger on email addresses

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `FileAttachment`, extend `WsSendMessage` with `files` |
| `src/server/index.ts` | Add file attachment validation, format context, prepend to prompt |
| `src/server/chat-history.ts` | Extend `WsChatHistoryMessage` with file metadata |
| `src/client/components/MessageInput.tsx` | Add @ autocomplete, file chips, drag-drop |
| `src/client/components/FileAttachmentChips.tsx` | New: removable file attachment pills |
| `src/client/components/FileAttachmentChips.test.tsx` | Component tests |
| `src/client/components/FileAutoComplete.tsx` | New: @ mention autocomplete panel |
| `src/client/components/FileAutoComplete.test.tsx` | Component tests |
| `src/client/components/FileTree.tsx` | Add drag support, "Add to Chat" button |
| `src/client/components/MessageList.tsx` | Display file attachments on user messages |
| `src/client/App.tsx` | Add pendingFiles state, addFileAttachment/removeFileAttachment handlers |
| `src/server/integration_tests/file-context.test.ts` | Integration tests |

## Dependencies

No new npm packages. The autocomplete panel is custom-built with existing React primitives.

## Complexity

Medium. The server-side changes are simple (validation + string formatting). The client-side has more surface area:
- @ mention autocomplete (the trickiest part — cursor position tracking, popup positioning, keyboard navigation)
- Drag and drop between components
- File content fetching and caching
- State management for pending attachments

Estimate: ~800-1100 lines of new code.
