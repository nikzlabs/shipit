---
status: paused
---
# 025 — In-Browser Code Editor

## Design Concern: Scope Creep Risk

**Status: on hold — needs design rethink**

Adding a code editor creates an expectation treadmill. Once users see a CodeMirror editor, they immediately ask for formatter integration (Prettier), autocomplete/IntelliSense, go-to-definition, multi-cursor, vim keybindings, git diff gutters, etc. ShipIt would be competing with VS Code on its home turf — and would always lose.

The current read-only file viewer is actually a defensible design choice: it communicates that **Claude writes the code, you review it here**. This is ShipIt's differentiator — it's an AI-first IDE where the agent is the primary author, not a traditional editor with AI bolted on.

**If we do implement an editor, it must be deliberately minimal:**
- Save (Cmd+S) and basic editing only — no formatter, no autocomplete, no LSP
- Position it as "quick fix" capability, not a full editor
- Keep the UI nearly identical to the current viewer (don't add toolbars, panels, etc.)
- Explicitly document what we will NOT add to prevent scope creep
- Consider whether the effort is better spent on features that play to ShipIt's strengths (context display, terminal, GitHub workflow)

**Alternative approaches to consider:**
- Keep the viewer read-only and improve the chat-based editing UX instead (better file context attachment, inline diffs, one-click "fix this line")
- Add only a "quick edit" mode — contenteditable on a single line/block, not a full editor component

## Summary

Replace the read-only `FileContentViewer` with an editable code editor powered by CodeMirror 6. Users can directly edit files, save changes (auto-committed to git), and work alongside Claude rather than delegating every keystroke to the agent.

## Motivation

The current `FileContentViewer` (`src/client/components/FileContentViewer.tsx`) uses highlight.js for syntax highlighting but is completely read-only — it renders content in a `<pre><code>` block with `dangerouslySetInnerHTML`. Users can view files but cannot:

- Fix a typo without asking Claude
- Make a small tweak while Claude works on something else
- Manually resolve a merge conflict or lint error
- Edit configuration files (tsconfig, package.json) directly

Note: while these are real gaps, the risk of scope creep (see above) may outweigh the benefit. The primary question is whether adding editing encourages users to work *around* Claude rather than *with* Claude, which undermines ShipIt's core value proposition.

## How It Works

### Editor Library: CodeMirror 6

**Why CodeMirror 6 over Monaco:**
- **Bundle size**: CodeMirror 6 is ~150KB min+gzip (tree-shakeable). Monaco is ~2-5MB (it's VS Code's editor).
- **Architecture**: CodeMirror 6 is designed as composable extensions, so we include only what's needed (syntax highlighting, line numbers, bracket matching, keymaps). Monaco ships everything.
- **Mobile support**: CodeMirror 6 works well on mobile. Monaco does not.
- **Tailwind integration**: CodeMirror 6 themes are CSS-based, easy to match ShipIt's dark mode.

**Extensions to include:**
- `@codemirror/lang-javascript` (JS/TS/JSX/TSX)
- `@codemirror/lang-html`
- `@codemirror/lang-css`
- `@codemirror/lang-json`
- `@codemirror/lang-markdown`
- `@codemirror/lang-python`
- Basic setup: line numbers, bracket matching, active line highlight, indent guides, search (Ctrl+F)
- Dark theme matching ShipIt's color scheme

### Client-Side

#### FileEditor Component (`src/client/components/FileEditor.tsx`)

Replaces `FileContentViewer` when a file is selected:

```typescript
export interface FileEditorProps {
  filePath: string;
  content: string | null;
  isBinary?: boolean;
  onClose: () => void;
  onSave: (filePath: string, content: string) => void;
  readOnly?: boolean;
}
```

**Layout** (same slot as FileContentViewer — right panel, Files tab):

```
┌──────────────────────────────────────────────┐
│ src/components/App.tsx        [Save] [Close]  │
├──────────────────────────────────────────────┤
│  1 │ import { useState } from "react";       │
│  2 │                                         │
│  3 │ export function App() {                 │
│  4 │   const [count, setCount] = useState(0);│
│  5 │                                         │
│  6 │   return (                              │
│  7 │     <div>                               │
│  8 │       <h1>Hello</h1>                    │
│  9 │       <button onClick={() =>            │
│ 10 │         setCount(c => c + 1)}>          │
│ 11 │         Count: {count}                  │
│ 12 │       </button>                         │
│ 13 │     </div>                              │
│ 14 │   );                                    │
│ 15 │ }                                       │
├──────────────────────────────────────────────┤
│ Modified · Ln 9, Col 24 · TypeScript         │
└──────────────────────────────────────────────┘
```

**Features:**
- **Syntax highlighting**: Language detected from file extension (reuse the `languageFromPath` logic from `FileContentViewer`)
- **Save**: Ctrl+S / Cmd+S triggers save. Also available via button. Sends content to server.
- **Dirty indicator**: "Modified" badge in status bar when content differs from saved version. Unsaved changes prompt confirmation on close.
- **Status bar**: Line/column position, language name, modified indicator
- **Read-only mode**: Binary files and optionally locked files show read-only view
- **Auto-resize**: Editor fills available height in the right panel

#### Language Detection

Reuse and extend the existing `languageFromPath` from `FileContentViewer.tsx`:

```typescript
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

function languageExtension(filePath: string): Extension | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return javascript({ jsx: true, typescript: true });
    case "js": case "jsx": return javascript({ jsx: true });
    case "html": return html();
    case "css": return css();
    case "json": return json();
    case "md": case "mdx": return markdown();
    case "py": return python();
    default: return null;
  }
}
```

#### Integration with App.tsx

Replace `FileContentViewer` rendering in the right panel:

```typescript
// In rightPanel (App.tsx), change:
<FileContentViewer filePath={viewingFile} content={viewingFileContent} ... />
// To:
<FileEditor
  filePath={viewingFile}
  content={viewingFileContent}
  isBinary={viewingFileBinary}
  onClose={handleFileViewerClose}
  onSave={handleFileSave}
/>
```

### Server-Side

#### New Message Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsSaveFile {
  type: "save_file";
  path: string;
  content: string;
}

// Server → Client
export interface WsFileSaved {
  type: "file_saved";
  path: string;
  /** Git commit hash if auto-commit was performed. */
  commitHash?: string;
}
```

Add `WsSaveFile` to `WsClientMessage` union, `WsFileSaved` to `WsServerMessage` union.

#### Handler in `src/server/index.ts`

```typescript
if (msg.type === "save_file") {
  const filePath = typeof msg.path === "string" ? msg.path.trim() : "";
  const content = typeof msg.content === "string" ? msg.content : "";

  if (!filePath) {
    send({ type: "error", message: "File path is required" });
    return;
  }

  // Prevent path traversal
  const resolved = path.resolve(activeSessionDir, filePath);
  if (!resolved.startsWith(activeSessionDir)) {
    send({ type: "error", message: "Invalid file path" });
    return;
  }

  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");

    // Auto-commit the manual edit
    const git = getActiveGitManager();
    const hash = await git.autoCommit(`Manual edit: ${filePath}`);

    send({
      type: "file_saved",
      path: filePath,
      commitHash: hash ?? undefined,
    });

    // Broadcast git commit if one was made
    if (hash) {
      send({
        type: "git_committed",
        hash,
        message: `Manual edit: ${filePath}`,
      });
    }
  } catch (err) {
    send({ type: "error", message: `Failed to save: ${getErrorMessage(err)}` });
  }
}
```

**Security**: The handler validates the path to prevent directory traversal attacks. The resolved path must be within the session's workspace directory.

### File Conflict Detection

When Claude edits a file that the user also has open in the editor, there's a potential conflict. Handle this with the existing `files_changed` event:

1. `FileWatcher` detects the change and sends `files_changed` to the client
2. The client checks if the changed file is currently open in the editor
3. If the editor has **unsaved changes** and the file was modified externally: show a conflict notification:
   ```
   "App.tsx was modified by Claude. [Reload] [Keep Mine] [Show Diff]"
   ```
4. If the editor has **no unsaved changes**: silently reload the file content

```typescript
// In App.tsx files_changed handler, extend:
if (data.type === "files_changed") {
  // ... existing logic ...

  // Check for editor conflicts
  if (viewingFile && paths.some(p => viewingFile.endsWith(p))) {
    if (editorHasUnsavedChanges) {
      setFileConflict({ path: viewingFile, type: "external_modify" });
    } else {
      // Silently reload
      send({ type: "get_file_content", path: viewingFile });
    }
  }
}
```

### File Tree Integration

Clicking a file in the `FileTree` component already calls `handleFileClick` which loads the file content. The only change is that this now opens the editor instead of the read-only viewer.

**"Open in Editor" vs. "View"**: For the initial implementation, always open in the editor. Binary files automatically use read-only mode. A future enhancement could add a "View" option for large files.

### Keyboard Shortcuts

- **Ctrl+S / Cmd+S**: Save file (within editor)
- **Escape**: Close editor (with unsaved changes prompt)
- **Ctrl+Z / Cmd+Z**: Undo (handled by CodeMirror)
- **Ctrl+Shift+Z / Cmd+Shift+Y**: Redo
- **Ctrl+F / Cmd+F**: Search within file (CodeMirror built-in, distinct from chat search)

## Testing

### Integration Tests (`src/server/integration_tests/code-editor.test.ts`)
1. **Save file**: Send `save_file` → verify file written to disk → verify `file_saved` response with commit hash
2. **Path traversal**: Send `save_file` with `../../../etc/passwd` → verify error
3. **Empty path**: Send `save_file` with empty path → verify error
4. **Auto-commit**: Save file → verify git commit was created
5. **Create new file**: Save to a path that doesn't exist → verify file and directories created
6. **Binary file rejection** (future): Attempt to save binary data → appropriate handling

### Component Tests (`src/client/components/FileEditor.test.tsx`)
1. Renders CodeMirror editor with correct content
2. Language detection applies correct extension for .tsx, .css, .json, etc.
3. Ctrl+S triggers onSave callback with current content
4. Modified indicator appears after editing
5. Close with unsaved changes shows confirmation
6. Read-only mode for binary files
7. Status bar shows correct line/column on cursor move

## Dependencies

New npm packages:
- `codemirror` (~30KB)
- `@codemirror/lang-javascript` (~30KB)
- `@codemirror/lang-html` (~15KB)
- `@codemirror/lang-css` (~10KB)
- `@codemirror/lang-json` (~5KB)
- `@codemirror/lang-markdown` (~10KB)
- `@codemirror/lang-python` (~15KB)

Total added: ~115KB min+gzip (tree-shaked). Reasonable for an IDE feature.

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsSaveFile`, `WsFileSaved` |
| `src/server/index.ts` | Add `save_file` handler with path validation + auto-commit |
| `src/client/components/FileEditor.tsx` | New component: CodeMirror 6 editor |
| `src/client/components/FileEditor.test.tsx` | Component tests |
| `src/client/components/FileContentViewer.tsx` | Kept as fallback for binary/large files, or removed entirely |
| `src/client/App.tsx` | Replace FileContentViewer with FileEditor, add save handler, conflict detection |
| `src/server/integration_tests/code-editor.test.ts` | Integration tests |
| `package.json` | Add CodeMirror dependencies |

## Migration

`FileContentViewer` can be kept as a lightweight fallback for binary files and very large files (>1MB) where loading CodeMirror isn't worth it. Or it can be replaced entirely by FileEditor with `readOnly` mode for binary files.

## Complexity

Medium. The CodeMirror integration itself is well-documented and straightforward. The main complexity is in:
- File conflict detection (Claude edits vs. user edits)
- Save flow with auto-commit and path validation
- Theme integration (matching ShipIt's dark mode)

Estimate: ~500-700 lines of new code + dependency additions.
