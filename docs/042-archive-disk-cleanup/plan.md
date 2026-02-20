---
status: planned
---
# 042 — Archive Disk Cleanup

## Problem

Archiving a standalone session sets `archived: true` in metadata but **never deletes the workspace directory**. Over time, archived sessions accumulate and consume disk indefinitely. The only way to reclaim space today is `full_reset`, which destroys everything.

Worktree sessions are better — `git worktree remove` cleans up the checkout on archive — but even they leave heavy artifacts in the shared repo clone.

A single session with a Node.js project can easily consume 500 MB+ from `node_modules` alone. A user with 10 archived sessions could be sitting on 5+ GB of dead weight.

### What gets left behind today

| Artifact | Typical size | Cleaned on archive? |
|----------|-------------|---------------------|
| `node_modules/` | 200 MB – 2 GB | No |
| `.git/` (standalone) | 50 – 500 MB | No |
| `.next/` | 50 – 500 MB | No |
| `dist/`, `build/` | 10 – 100 MB | No |
| `.cache/`, `.vite/` | 10 – 50 MB | No |
| Project source files | 1 – 50 MB | No (standalone), Yes (worktree) |
| Chat history JSON | < 1 MB | No |
| Thread data JSON | < 1 MB | No |

---

## Design

Two-tier cleanup: **aggressive on archive** (delete heavy artifacts immediately) and **full delete option** for users who want to reclaim all space.

### Tier 1: Heavy artifact cleanup on archive (automatic)

When a session is archived, immediately delete known-heavy generated directories from the workspace. These are always regenerable — `npm install` recreates `node_modules`, builds recreate `dist`, etc.

**Directories to delete**:

```typescript
const HEAVY_ARTIFACTS = [
  "node_modules",
  ".next",
  "dist",
  "build",
  ".cache",
  ".vite",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
  "target",        // Rust
  "vendor",        // Go (when not using modules)
];
```

This list aligns with what `file-tree.ts` already skips in `SKIP_DIRS` (plus common equivalents from other ecosystems). These are all generated/cacheable — deleting them loses nothing that can't be recreated.

**Implementation**: In `handleArchiveSession`, after marking `archived: true`, walk the session's workspace directory one level deep and `fs.rm()` any directory matching `HEAVY_ARTIFACTS`.

```typescript
// In session-handlers.ts, after ctx.sessionManager.archive(msg.sessionId):
if (sessionToArchive?.workspaceDir) {
  await cleanHeavyArtifacts(sessionToArchive.workspaceDir);
}

async function cleanHeavyArtifacts(workspaceDir: string): Promise<void> {
  for (const name of HEAVY_ARTIFACTS) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch {
      // Best-effort — directory may not exist or may be locked
    }
  }
}
```

**Scope**: Only cleans the top-level workspace directory. Doesn't recurse into subdirectories looking for nested `node_modules` — that would be slow and the top-level is where 90%+ of the size lives.

### Tier 2: Full workspace deletion (optional, user-triggered)

Add a "Delete session" option (distinct from archive) that removes the workspace directory entirely. This is for users who want to reclaim all space and don't need the source files.

**When available**: Only on already-archived sessions. Archive is the soft delete; full delete is the hard delete.

**What it deletes**:
- The entire `/workspace/sessions/{uuid}/` directory
- Chat history file (`.vibe-chat-history/{sessionId}.json` and any thread variants)
- Thread data file (`.vibe-threads/{sessionId}.json`)
- Usage records for the session (from `.shipit-usage.json`)
- Session metadata entry from `.vibe-sessions.json`

After full delete, the session disappears completely — it's no longer visible anywhere.

**Implementation**: New WS message `delete_session { sessionId }`.

---

## Changes

### Server

**`src/server/ws-handlers/session-handlers.ts`**:
- Add `cleanHeavyArtifacts()` call in `handleArchiveSession` after marking archived
- Add new `handleDeleteSession()` handler for full deletion

**`src/server/types.ts`**:
- Add `delete_session` to `WsClientMessage` union
- Add `session_deleted` to `WsServerMessage` union (confirms deletion, triggers session list refresh)

**`src/server/index.ts`**:
- Add `case "delete_session"` to switch dispatcher

**`src/server/sessions.ts`**:
- Add `SessionManager.remove(sessionId)` method that fully removes the entry (not just archive flag)

**`src/server/chat-history.ts`**:
- Add `ChatHistoryManager.delete(sessionId)` to remove all chat history files for a session

### Client

**Sidebar**: Add "Delete permanently" option in the context menu for archived sessions (not for active ones — must archive first).

### Constants

Extract `HEAVY_ARTIFACTS` to a shared constant (e.g., in `src/server/constants.ts` or at the top of `session-handlers.ts`). Could unify with `SKIP_DIRS` in `file-tree.ts` to keep the lists in sync, though the overlap isn't exact (`.git` and `.vibe-chat-history` are in `SKIP_DIRS` but should not be cleaned as "heavy artifacts" on archive).

---

## Edge Cases

### 1. Archive while agent is running (post-041)

After doc 041 lands, archiving a session with a running agent disposes the SessionRunner first (kills agent), then cleans artifacts. The agent may have created files in `node_modules` etc. that are still being written — `fs.rm` with `force: true` handles this.

### 2. Archive a worktree session

Worktree cleanup already removes the checkout directory via `git worktree remove`. Heavy artifact cleanup runs **before** worktree removal (since the directory still exists). If worktree removal also deletes the directory, the artifact cleanup is a no-op (already gone). Order: clean artifacts → remove worktree → delete branch.

### 3. Shared repo cleanup

When the last session for a shared repo is archived, the entire `/workspace/repos/{hash}/` directory is already deleted. Heavy artifact cleanup of the individual session directory happens first, reducing the size before the full rm. No special handling needed.

### 4. Full delete of a session that's currently viewed

If another tab is viewing a session that gets fully deleted, the viewer should detach and show an error/redirect to home. The `session_deleted` broadcast message triggers this on all connected clients.

### 5. Disk permissions / locked files

On some systems, files in `node_modules/.cache` or build output may have restricted permissions. `fs.rm` with `force: true` handles most cases. If deletion fails, log a warning and continue — best-effort cleanup is better than no cleanup.

---

## Testing

### Unit tests
- `cleanHeavyArtifacts()` deletes matching directories, ignores missing ones
- `cleanHeavyArtifacts()` doesn't delete non-matching directories (source files safe)
- `SessionManager.remove()` fully removes entry

### Integration tests
- Archive session triggers artifact cleanup (verify `node_modules` deleted)
- Archive session preserves source files
- `delete_session` removes workspace directory, chat history, threads
- `delete_session` on non-archived session returns error
- `delete_session` broadcasts updated session list
- Worktree session archive: artifacts cleaned before worktree removal

---

## Key Files

| File | Role |
|------|------|
| `src/server/ws-handlers/session-handlers.ts` | Archive cleanup + delete handler |
| `src/server/sessions.ts` | `remove()` method |
| `src/server/chat-history.ts` | `delete()` method |
| `src/server/types.ts` | New message types |
| `src/server/index.ts` | Wire `delete_session` |
| `src/client/components/Sidebar.tsx` | "Delete permanently" UI |
