---
status: planned
---

# File Upload — Browser-to-Container File Transfer

Allow users to upload files from their local machine into a session's workspace so the agent can reference and operate on them. Uploaded files land in a dedicated `/user/uploads/` directory and are passed to the agent as file context.

## Motivation

Users often have local assets they want the agent to work with — design mockups, CSVs, ZIP archives with starter code, PDFs, config files, etc. Today the only way to get non-image files into a session is to have them in the cloned repo or ask Claude to create them via terminal commands. This is friction-heavy and impossible for binary files.

## Design

### Directory layout inside the container

```
/user/                          # Session workspace (existing)
  uploads/                      # Uploaded files land here
    screenshot.png
    data.csv
    starter-kit.zip
```

**Why a dedicated `uploads/` dir?**
- Keeps uploaded files separate from repo-tracked files — avoids polluting `git status` with user uploads (the dir can be `.gitignore`d by default).
- Gives the agent a predictable, well-known path to reference.
- Easy to clean up or list.

**Scratch space**: The agent can use `/tmp` for temporary work (unpacking ZIPs, intermediate processing). `/tmp` is already available in every container and is ephemeral by nature — no need for a custom scratch directory. The agent instructions should mention that `/tmp` is available for scratch work and that uploaded files are in `/user/uploads/`.

### Upload flow

```
Browser                    Orchestrator                   Session Worker
  │                            │                              │
  │  POST /api/sessions/:id/   │                              │
  │       files/upload         │                              │
  │  (multipart/form-data)     │                              │
  │ ─────────────────────────> │                              │
  │                            │  POST /files/upload          │
  │                            │  (multipart/form-data)       │
  │                            │ ──────────────────────────>  │
  │                            │                              │ write to /user/uploads/
  │                            │                              │ ─────┐
  │                            │          200 { paths }       │ <────┘
  │                            │ <────────────────────────── │
  │       200 { paths }        │                              │
  │ <───────────────────────── │                              │
  │                            │                              │
  │  send_message              │                              │
  │  { files: [uploaded paths] }                              │
  │ ─────────────────────────> │                              │
```

1. **Browser** sends a `multipart/form-data` POST with one or more files.
2. **Orchestrator** validates the request (auth, session exists, file count/size limits) and forwards the multipart payload to the session worker.
3. **Session worker** writes files to `/user/uploads/`, creating the directory if needed. Returns the written paths.
4. **Browser** receives the paths and can automatically attach them to the next `send_message` as file context refs, or the user can reference them via `@uploads/filename`.

### API design

#### Orchestrator endpoint

```
POST /api/sessions/:id/files/upload
Content-Type: multipart/form-data

Parts:
  file[]  — one or more files (standard multipart file fields)
```

Response:

```json
{
  "files": [
    { "name": "data.csv", "path": "uploads/data.csv", "size": 4096 },
    { "name": "starter.zip", "path": "uploads/starter.zip", "size": 102400 }
  ]
}
```

#### Session worker endpoint

```
POST /files/upload
Content-Type: multipart/form-data

Parts:
  file[]  — one or more files
```

Same response shape. The worker writes to `${CONTAINER_WORKSPACE_DIR}/uploads/`.

### Limits

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Max file size | 50 MB | Generous for ZIPs/datasets, prevents abuse |
| Max files per request | 20 | Batch uploads without overwhelming |
| Max total upload per session | 500 MB | Prevents disk exhaustion |
| Allowed types | All except executables | Block `.exe`, `.sh`, `.bat`, `.cmd`, `.msi`, `.app` |

Limits are enforced at both the orchestrator (fast rejection) and worker (defense in depth). The orchestrator checks `Content-Length` early to reject oversized requests before buffering.

### Filename handling

- Preserve original filenames where possible.
- Sanitize: strip path traversal (`../`), null bytes, and control characters.
- On collision: append a numeric suffix (`data.csv` → `data-1.csv`).
- Maintain a flat structure in `uploads/` — no subdirectories from user input. If a ZIP needs unpacking, the agent does that into `/tmp` or a subfolder it creates.

### Client UI

#### Upload trigger points

1. **Drag-and-drop** onto the chat input area (extend existing image drop zone to accept all file types).
2. **File picker button** — a paperclip/attach icon next to the existing image upload button in `MessageInput.tsx`, or unify both into a single attach button.
3. **Paste** — for image files (already works), extend to detect non-image files if the browser supports it.

#### Upload UX flow

1. User drops/selects files → show upload chips in the message input area (similar to `FileAttachmentChips` for `@`-referenced files, but with an upload progress indicator).
2. Files upload immediately in the background (don't wait for message send).
3. Once uploaded, chips transition from "uploading" to "ready" state showing the filename and size.
4. When the user sends the message, the uploaded file paths are included as `FileContextRef` entries in `send_message.files[]`.
5. If the user removes a chip before sending, the uploaded file remains in `uploads/` (no cleanup — it's cheap and the agent might still find it useful).

#### Upload chip states

| State | Visual |
|-------|--------|
| Uploading | Filename + spinner + progress % |
| Ready | Filename + file size + remove button |
| Error | Filename + error icon + retry button |

#### Icons

- Attach button: `Paperclip` (MD size)
- Upload progress: `CircleNotch` with `animate-spin`
- Upload complete: `File` icon
- Upload error: `WarningCircle` with `--color-error`

### Agent integration

#### System prompt additions

Add to the agent instructions (in `agent-instructions.ts`) when uploads exist:

```
Uploaded files are available at /user/uploads/. Use /tmp for temporary
scratch work (e.g., unpacking archives). The uploads directory is not
git-tracked.
```

#### Auto-attachment

When files are uploaded alongside a message, they're attached as `FileContextRef` entries so Claude sees their content. For binary files (ZIP, images, PDFs), only the path is provided — the agent reads them with tools as needed.

### File watcher integration

The existing `FileWatcher` already watches `/user`. Uploaded files will trigger `file_changes` events, which updates the file tree in the UI automatically. No additional work needed — just ensure `uploads/` isn't in the ignore list.

### .gitignore handling

On session creation (or first upload), ensure `uploads/` is in `.gitignore`:

```
# ShipIt uploads (not tracked)
uploads/
```

This prevents uploaded files from appearing in `git status` and being auto-committed. The agent can explicitly `git add -f uploads/somefile` if the user wants a file tracked.

## Key files

| Area | File | Changes |
|------|------|---------|
| Worker endpoint | `src/server/session/session-worker.ts` | Add `POST /files/upload` route |
| Orchestrator route | `src/server/orchestrator/api-routes-files.ts` | Add `POST /sessions/:id/files/upload` |
| Worker HTTP client | `src/server/orchestrator/worker-http.ts` | Add `workerUpload()` for multipart forwarding |
| Container runner | `src/server/orchestrator/container-session-runner.ts` | Add `uploadFiles()` method |
| Agent instructions | `src/server/orchestrator/agent-instructions.ts` | Add uploads/scratch context |
| Validation | `src/server/orchestrator/validation.ts` | Add upload validation (size, type, count) |
| Client input | `src/client/components/MessageInput.tsx` | Add file attach button, extend drop zone |
| Upload chips | `src/client/components/FileUploadChips.tsx` | New — upload progress/status chips |
| Upload hook | `src/client/hooks/useFileUpload.ts` | New — upload state management, API calls |
| Types | `src/server/shared/types/attachment-types.ts` | Add upload-related types |

## Non-goals (for now)

- **Folder upload** — browsers support it but adds complexity. Users can ZIP folders.
- **Resumable uploads** — overkill for 50 MB limit. Standard multipart is fine.
- **Upload persistence across sessions** — uploads live in the session's workspace. Cloning a session could copy them, but that's a separate feature.
- **Server-side ZIP unpacking** — the agent can do this. We just deliver the file.

## Open questions

1. **Unified attach button vs separate?** — Should image upload and file upload share one button (with a type filter toggle), or remain separate? Recommendation: unify into one `Paperclip` button that opens a file picker with no type filter, and keep the image paste/drop behavior as-is.
2. **Upload before session start?** — Should users be able to upload files to a session that hasn't started yet (e.g., "start from uploaded ZIP")? Could queue uploads and flush on session start.
3. **Per-session upload quota tracking** — Do we need persistent tracking of total upload bytes, or is checking disk usage at upload time sufficient?
