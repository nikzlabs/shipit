---
status: planned
---

# File Upload — Browser-to-Container File Transfer

Allow users to upload files from their local machine into a session container so the agent can reference and operate on them. Uploaded files land in `/uploads/`, a top-level directory outside the git repo, and are passed to the agent as file context.

## Motivation

Users often have local assets they want the agent to work with — design mockups, CSVs, ZIP archives with starter code, PDFs, config files, etc. Today the only way to get non-image files into a session is to have them in the cloned repo or ask Claude to create them via terminal commands. This is friction-heavy and impossible for binary files.

## Design

### Directory layout inside the container

```
/user/                          # Git repo / session workspace (existing, unchanged)
  src/
  package.json
  ...
/uploads/                       # Uploaded files — outside the repo entirely
  screenshot.png
  data.csv
  starter-kit.zip
```

**Why `/uploads/` at the container root (not inside `/user/`)?**
- `/user/` is the git repo root. Putting uploads inside it means they're in the worktree — even with `.gitignore`, the agent could `git add -f` them, they'd show up in `find`, and they'd clutter the workspace.
- A top-level `/uploads/` is completely outside git. No `.gitignore` hacks needed, no risk of accidental commits, clean separation.
- The container already has a bind mount for `/user`. Adding a second host bind mount for `/uploads` is straightforward (see "Storage" below).
- Gives the agent a predictable, well-known path to reference.
- Only mounted in the **session container** (where the agent runs), not the preview container (which only serves the dev server).

**Scratch space**: The agent can use `/tmp` for temporary work (unpacking ZIPs, intermediate processing). `/tmp` is already available in every container and is ephemeral by nature — no need for a custom scratch directory. Note that `/tmp` is cleared on container restart, so scratch work there is not durable. The agent instructions should mention that `/tmp` is available for scratch work and that uploaded files are at `/uploads/`.

**Storage**: `/uploads/` is a host bind mount from the session's directory on the orchestrator host:

```
Host:       /workspace/sessions/{uuid}/uploads/
Container:  /uploads/
```

This ties upload lifecycle to the session — uploads persist across container restarts but are cleaned up when the session is deleted. No Docker volumes needed.

### Upload flow

```
Browser                    Orchestrator
  │                            │
  │  POST /api/sessions/:id/   │
  │       files/upload         │
  │  (multipart/form-data)     │
  │ ─────────────────────────> │
  │                            │ write to host:
  │                            │ /workspace/sessions/{uuid}/uploads/
  │                            │ (bind-mounted as /uploads/ in container)
  │                            │ ─────┐
  │       200 { files }        │ <────┘
  │ <───────────────────────── │
  │                            │
  │  send_message              │
  │  { files: [uploaded paths] }
  │ ─────────────────────────> │
```

1. **Browser** sends a `multipart/form-data` POST with one or more files.
2. **Orchestrator** validates the request (auth, session exists, file count/size limits), then writes files directly to the session's upload directory on the host filesystem (`/workspace/sessions/{uuid}/uploads/`). Since this directory is bind-mounted as `/uploads/` in the session container, the files are immediately visible to the agent. No worker endpoint needed — the orchestrator owns the host filesystem.
3. **Browser** receives the written paths and automatically attaches them to the next `send_message` as file context refs.

**Why not forward to the worker?** Forwarding multipart to the worker would require the orchestrator to either buffer the entire file in memory or stream-pipe the request body. Since the orchestrator already has direct access to the host directory that's bind-mounted into the container, writing there is simpler, faster, and avoids double-transfer overhead.

### API design

#### Upload endpoint

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
    { "name": "data.csv", "path": "/uploads/data.csv", "size": 4096, "type": "upload" },
    { "name": "starter.zip", "path": "/uploads/starter.zip", "size": 102400, "type": "upload" }
  ]
}
```

The `type: "upload"` field distinguishes these from workspace file references, so the client knows to treat them as uploaded files (not `@`-referenced repo files) when constructing `FileContextRef` entries.

Orchestrator-only — no session worker endpoint needed (see "Upload flow" above).

#### List uploads endpoint

```
GET /api/sessions/:id/files/uploads
```

Response:

```json
{
  "files": [
    { "name": "data.csv", "path": "/uploads/data.csv", "size": 4096, "type": "upload" },
    { "name": "starter.zip", "path": "/uploads/starter.zip", "size": 102400, "type": "upload" }
  ]
}
```

This endpoint is needed for **state recovery** — when the user refreshes the browser or reconnects, client-side upload state is lost. The client calls this on session connect to reconstruct upload chips and populate the file tree's uploads section.

### Limits

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Max file size | 50 MB | Generous for ZIPs/datasets, prevents abuse |
| Max files per request | 20 | Batch uploads without overwhelming |
| Max total upload per session | 500 MB | Prevents disk exhaustion |
| Allowed types | All | No type filtering (see below) |

**No file type restrictions.** The agent can already create and execute arbitrary files via terminal commands, so blocking `.exe` or `.sh` uploads provides no real security benefit. It would also be trivially bypassed (rename extension) and overly restrictive (`.sh` scripts are common legitimate uploads). The size limits are the meaningful guardrail.

The orchestrator checks `Content-Length` early to reject oversized requests before buffering. The 500 MB session quota is checked by summing existing files in the uploads directory before writing — removed files free up quota.

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
5. If the user removes a chip before sending, the uploaded file remains in `/uploads/` (no cleanup — it's cheap and the agent might still find it useful). Remaining files count against the 500 MB session quota.

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
Uploaded files are available at /uploads/. This directory is outside the
git repo (/user/) so files there are never committed. Use /tmp for
temporary scratch work (e.g., unpacking archives).
```

#### Auto-attachment

When files are uploaded alongside a message, they're attached as `FileContextRef` entries so Claude sees their content. For binary files (ZIP, images, PDFs), only the path is provided — the agent reads them with tools as needed.

### File tree and `@`-reference integration

The existing `FileWatcher` watches `/user` (the repo). Since `/uploads/` is outside `/user`, uploaded files won't appear in the file tree or `@`-autocomplete automatically.

**Approach**: The client tracks uploads locally (from upload responses + `GET /files/uploads` on reconnect) and renders them as a virtual "Uploads" section in the file tree panel. The `@`-autocomplete is extended to search this local upload list in addition to the workspace file tree, matching on `@/uploads/filename`.

No second file watcher needed — the client is the source of truth for upload state, hydrated from the list endpoint on reconnect.

### No .gitignore needed

Since `/uploads/` is outside the repo root (`/user/`), there's no git interaction at all — no `.gitignore` entry needed, no risk of auto-commits, no `git status` noise.

## Key files

| Area | File | Changes |
|------|------|---------|
| Orchestrator route | `src/server/orchestrator/api-routes-files.ts` | Add `POST /sessions/:id/files/upload` and `GET /sessions/:id/files/uploads` |
| Upload service | `src/server/orchestrator/services/files.ts` | Upload logic: validate, write to host uploads dir, list uploads |
| Container setup | `src/server/orchestrator/session-container.ts` | Add `/uploads` bind mount to session container creation |
| Agent instructions | `src/server/orchestrator/agent-instructions.ts` | Add uploads/scratch context |
| Validation | `src/server/orchestrator/validation.ts` | Add upload validation (size, count, quota) |
| Client input | `src/client/components/MessageInput.tsx` | Add file attach button, extend drop zone |
| Upload chips | `src/client/components/FileUploadChips.tsx` | New — upload progress/status chips |
| Upload hook | `src/client/hooks/useFileUpload.ts` | New — upload state, API calls, reconnect hydration |
| File autocomplete | `src/client/components/FileAutoComplete.tsx` | Extend to search uploads list |
| Types | `src/server/shared/types/attachment-types.ts` | Add upload-related types |

## Non-goals (for now)

- **Folder upload** — browsers support it but adds complexity. Users can ZIP folders.
- **Resumable uploads** — overkill for 50 MB limit. Standard multipart is fine.
- **Upload persistence across sessions** — uploads live in the session's workspace. Cloning a session could copy them, but that's a separate feature.
- **Server-side ZIP unpacking** — the agent can do this. We just deliver the file.

## Open questions

1. **Unified attach button vs separate?** — Should image upload and file upload share one button (with a type filter toggle), or remain separate? Recommendation: unify into one `Paperclip` button that opens a file picker with no type filter, and keep the image paste/drop behavior as-is.
2. **Upload before session start?** — Should users be able to upload files to a session that hasn't started yet (e.g., "start from uploaded ZIP")? Could queue uploads and flush on session start. The host uploads directory could be created eagerly at session creation time, before the container starts.
