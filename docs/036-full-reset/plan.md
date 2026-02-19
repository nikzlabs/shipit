---
status: planned
---

# 036 — Full Reset (Wipe Container State)

## Problem

When ShipIt gets into a broken state — corrupted git repos, stale session data, misconfigured credentials, or any other issue — there is no way to recover without manually deleting files. Users need a single "factory reset" button that wipes all persistent state and returns the container to a clean slate.

## Design

### Scope of reset

A full reset deletes **all** persistent data in `/workspace/`:

| Category | Path(s) | Manager |
|---|---|---|
| Session metadata | `/workspace/.vibe-sessions.json` | `SessionManager` |
| Session workspaces | `/workspace/sessions/*/` | filesystem |
| Chat history | `/workspace/.vibe-chat-history/` | `ChatHistoryManager` |
| Threads & checkpoints | `/workspace/.vibe-threads/` | `ThreadManager` |
| Usage tracking | `/workspace/.shipit-usage.json` | `UsageManager` |
| System prompt | `/workspace/.shipit/system-prompt.md` | file I/O in index.ts |
| Git identity | `/workspace/.shipit/git-identity.json` | `GitIdentityStore` |
| GitHub token | `/workspace/.github-token` | `GitHubAuthManager` |
| Deployment configs | `/workspace/.shipit-deploy/` | `DeploymentStore` |

Authentication state (Claude CLI OAuth) is **not** wiped — it lives outside `/workspace/` and is managed by the CLI itself.

Browser `localStorage` keys (`shipit-theme`, `vibe-permission-mode`, `vibe-sidebar-collapsed`, `vibe-agent-id`, `vibe-panel-split`) are cleared client-side after the server confirms the reset.

### Why a single "nuke everything" level

A partial reset (e.g. "delete sessions but keep credentials") adds UI complexity for a feature that should be rare and decisive. Users reaching for a full reset are troubleshooting — they want certainty that the state is clean. One button, one confirmation, everything gone.

### WebSocket protocol

**Client → Server**

```ts
interface WsFullReset {
  type: "full_reset";
}
```

Add `WsFullReset` to the `WsClientMessage` union in `types.ts`.

**Server → Client**

```ts
interface WsFullResetComplete {
  type: "full_reset_complete";
}
```

Add `WsFullResetComplete` to the `WsServerMessage` union in `types.ts`.

On error, the server sends the existing `{ type: "error", message: string }` message.

### Server handler (`index.ts`)

Inside the `socket.on("message")` handler, add a `full_reset` case:

1. **Stop active processes** — if a Claude process or Vite dev server is running for the current connection, stop them. This prevents file-lock issues during deletion.
2. **Kill file watcher** — stop the `FileWatcher` to avoid ENOENT errors on watched directories.
3. **Delete everything** — use `fs.rm` with `{ recursive: true, force: true }` on each path listed in the scope table above. Delete in this order:
   - Session workspace directories (`/workspace/sessions/`)
   - Chat history directory (`/workspace/.vibe-chat-history/`)
   - Threads directory (`/workspace/.vibe-threads/`)
   - Usage file (`/workspace/.shipit-usage.json`)
   - ShipIt config directory (`/workspace/.shipit/`)
   - GitHub token file (`/workspace/.github-token`)
   - Deploy data directory (`/workspace/.shipit-deploy/`)
   - Session metadata file (`/workspace/.vibe-sessions.json`)
4. **Re-initialize managers** — call reload/init methods on `SessionManager`, `ChatHistoryManager`, etc. so their in-memory state reflects the now-empty disk. Alternatively, since the container is ephemeral, the server can simply respond and let the client reload the page.
5. **Send `full_reset_complete`** to the client.

The handler should wrap all deletions in a try/catch. If any deletion fails, send an `error` message with details. Partial deletion is acceptable — the goal is best-effort cleanup, not transactional semantics.

### Client handling (`App.tsx`)

When `full_reset_complete` is received:

1. Clear all `localStorage` keys (`shipit-theme`, `vibe-permission-mode`, `vibe-sidebar-collapsed`, `vibe-agent-id`, `vibe-panel-split`).
2. Call `window.location.reload()` to fully reinitialize the app. This is simpler and more reliable than resetting every piece of React state manually. The server will see a fresh WebSocket connection and the UI will land on the home/new-session screen with no sessions.

### UI: button in ProjectSettings

Add a fourth tab to the settings dialog sidebar: **"Advanced"**.

The Advanced tab contains:

- A section titled **"Reset Container"** with explanatory text:
  > "Delete all sessions, chat history, credentials, and settings. This cannot be undone."
- A red **"Reset Everything"** button.
- Clicking the button shows inline confirmation: the button text changes to **"Click again to confirm reset"** with a red background (same pattern as the GitHub disconnect button). Clicking away (blur) cancels the confirmation.
- On second click, send the `full_reset` WebSocket message and show a spinner/disabled state while waiting for `full_reset_complete`.

```
┌─────────────────────────────────────────────────────┐
│  Project Settings                              ×    │
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│  Agent   │  Reset Container                         │
│  GitHub  │                                          │
│  Instru… │  Delete all sessions, chat history,      │
│ >Advanced│  credentials, and settings. This cannot  │
│          │  be undone.                               │
│          │                                          │
│          │  ┌──────────────────────────────────┐    │
│          │  │      Reset Everything             │    │
│          │  └──────────────────────────────────┘    │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

### Props changes

`ProjectSettingsProps` gets one new callback:

```ts
onFullReset: () => void;
```

`App.tsx` wires this to `send({ type: "full_reset" })`.

### Tab type update

```ts
type Tab = "agent" | "github" | "instructions" | "advanced";
```

### Key files to modify

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsFullReset` and `WsFullResetComplete` to message unions |
| `src/server/index.ts` | Add `full_reset` handler in WebSocket message switch |
| `src/client/components/ProjectSettings.tsx` | Add "Advanced" tab with reset button |
| `src/client/App.tsx` | Wire `onFullReset` prop, handle `full_reset_complete` message |

### Testing

**Integration test** (`src/server/integration_tests/full-reset.test.ts`):

- **Happy path**: Create a session, send `full_reset`, verify `full_reset_complete` received, verify all files/directories are gone from disk.
- **Idempotent**: Send `full_reset` on an already-clean workspace — should still succeed.
- **Error path**: Mock `fs.rm` to throw on one path — verify `error` message returned.

**Component test** (`src/client/components/ProjectSettings.test.tsx`):

- Renders the Advanced tab with reset button.
- First click shows confirmation text; clicking away resets it.
- Second click calls `onFullReset`.
- Button shows disabled/loading state after confirmation click.

### Edge cases

- **Active Claude process**: The handler must stop any running Claude process before deleting the workspace. Otherwise the CLI will error when its working directory disappears. The server already tracks the active `ClaudeProcess` per connection.
- **Active Vite server**: Similarly, stop the Vite dev server before deletion. The `ViteManager` has a `stop()` method.
- **Concurrent WebSocket connections**: If multiple browser tabs are open, only the requesting connection gets `full_reset_complete`. Other connections will encounter errors on their next operation (missing session dir, etc.). This is acceptable — full reset is a destructive, intentional action. The other tabs will need to reload.
- **Race with auto-commit**: `GitManager.autoCommit()` could be mid-flight. The `force: true` flag on `fs.rm` handles this — partial git state is fine since we're deleting the whole directory.
