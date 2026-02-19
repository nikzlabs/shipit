---
status: planned
---

# 037 — Preview cleanup on session change

## Problem

When a user switches sessions (via sidebar resume, back/forward navigation, or
creating a new session), preview-related state is not cleaned up:

1. **ViteManager keeps running against the old session's workspace.** The Vite
   dev server continues serving files from the previous session directory. The
   preview iframe shows stale content until something else triggers a restart
   (e.g. Claude finishing a turn).

2. **User-spawned dev servers (Next.js, Remix, etc.) keep running.** If Claude
   started `npm run dev` in session A on port 3001, that process stays alive
   when the user switches to session B. The port scanner detects port 3001 and
   presents it as if it belongs to session B.

3. **Client state leaks across sessions.** `selectedPort`, `previewErrors`,
   `autoFixEnabled`, `autoFixRetries`, `logEntries`, and `activity` all
   persist across session switches, creating cross-session contamination.

## Design

The fix has two layers: **server-side process lifecycle** and **client-side
state reset**.

### Server side

#### 1. Stop old preview, start new preview in `activateSession()`

When `activateSession()` detects a directory change, it must also cycle the
preview infrastructure — not just the file watcher.

```
activateSession(sessionId):
  ... existing logic (update activeSessionDir, restart FileWatcher) ...

  if directory changed:
+   // 1. Stop managed Vite (serves old session's files)
+   viteManager.stop()
+
+   // 2. Kill processes on previously-detected ports
+   killDetectedPortProcesses(detectedPorts)
+
+   // 3. Clear detected ports
+   detectedPorts = []
+
+   // 4. Broadcast clean "not running" preview status immediately
+   broadcastPreviewStatus()
+
+   // 5. Clear terminal logs (old session's output is irrelevant)
+   logBuffer.length = 0
+   broadcast({ type: "clear_logs" })
+
+   // 6. Start Vite for the new session's workspace (if it exists)
+   if (newDir)
+     viteManager.start(newDir)
+
+   // 7. Run a fresh port scan to discover any already-running
+   //    dev servers in the new session's workspace
+   await runPortScan()
```

**Why stop before start (not `restart()`)?** We want to broadcast an
intermediate "not running" state so the client immediately clears its preview
iframe. If we used `restart()`, the old preview stays visible until the new
Vite process emits "ready", which can take seconds.

#### 2. Kill processes on detected ports

When switching away from a session, any processes the port scanner previously
found (user-spawned dev servers like Next.js, Remix, Vite in library mode,
etc.) should be killed. These processes belong to the old session and would
otherwise leak, occupying ports and serving stale content.

New helper function in `src/server/index.ts`:

```ts
import { execFile } from "node:child_process";

/**
 * Attempt to kill processes listening on the given ports.
 * Best-effort — failures are logged but do not throw.
 * Only kills processes whose cwd is within a session workspace directory,
 * as a safety guard against killing unrelated system processes.
 */
async function killProcessesOnPorts(
  ports: number[],
  sessionsRoot: string
): Promise<void> {
  for (const port of ports) {
    try {
      // Find PID(s) listening on this port
      const { stdout } = await execFileAsync(
        "fuser", [`${port}/tcp`],
        { timeout: 3000 }
      );
      const pids = stdout.trim().split(/\s+/).map(Number).filter(Boolean);

      for (const pid of pids) {
        // Safety check: only kill if the process cwd is under sessionsRoot
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd && cwd.startsWith(sessionsRoot)) {
          process.kill(pid, "SIGTERM");
          console.log(`[session-switch] killed pid ${pid} on port ${port}`);
        } else {
          console.log(
            `[session-switch] skipped pid ${pid} on port ${port} — ` +
            `cwd "${cwd}" is not under sessions root`
          );
        }
      }
    } catch {
      // fuser returns non-zero when no process found — that's fine
    }
  }
}
```

**Safety guards:**

- Only kills processes whose working directory is under `/workspace/sessions/`.
  This prevents accidentally killing system services, databases, or ShipIt
  itself that happen to listen on a scanned port.
- Uses SIGTERM (graceful) not SIGKILL.
- Best-effort: failures are logged and silently ignored. A leaked process is
  annoying but not dangerous — the port scanner will find it in the new session
  and it can be cleaned up manually.
- `fuser` is available in the container image (part of `psmisc` package). If
  not available, the function should degrade gracefully (log a warning, skip
  kills).

#### 3. Also clean up in `new_session` handler

The `new_session` handler (line 1378) already clears `activeAppSessionId` and
the message queue, but does not touch Vite or detected ports. Apply the same
cleanup:

```
if (msg.type === "new_session"):
  ... existing logic ...
+ viteManager.stop()
+ killDetectedPortProcesses(detectedPorts)
+ detectedPorts = []
+ broadcastPreviewStatus()
+ logBuffer.length = 0
+ broadcast({ type: "clear_logs" })
```

No `viteManager.start()` here — the next `send_message` or `apply_template`
will create the session directory and start Vite as part of its normal flow.

### Client side

#### 4. Reset preview state in `resumeSessionInternal()`

Add the missing state resets in `src/client/App.tsx`:

```ts
const resumeSessionInternal = useCallback((sessionId: string) => {
  ... existing resets ...
+ setPreview(null);
+ setSelectedPort(null);
+ clearPreviewErrors();
+ setAutoFixEnabled(false);
+ autoFixRetriesRef.current = 0;
+ setAutoFixRetries(0);
+ autoFixCooldownRef.current = false;
+ autoFixErrorSignatureRef.current = null;
+ setActivity(undefined);
+ setLogEntries([]);
+ setUnreadLogCount(0);
}, [send, clearPreviewErrors]);
```

#### 5. Reset preview state in `handleSessionNew()`

Same resets in the new-session handler:

```ts
const handleSessionNew = useCallback(() => {
  ... existing resets ...
+ setPreview(null);
+ setSelectedPort(null);
+ clearPreviewErrors();
+ setAutoFixEnabled(false);
+ autoFixRetriesRef.current = 0;
+ setAutoFixRetries(0);
+ autoFixCooldownRef.current = false;
+ autoFixErrorSignatureRef.current = null;
+ setActivity(undefined);
+ setLogEntries([]);
+ setUnreadLogCount(0);
}, [send, templates.length, navigate, clearPreviewErrors]);
```

#### 6. Handle `clear_logs` message

Add a handler in the `lastMessage` processing effect if one doesn't exist:

```ts
if (data.type === "clear_logs") {
  setLogEntries([]);
  setUnreadLogCount(0);
}
```

## State reset matrix

| State | `resumeSessionInternal` | `handleSessionNew` | Server-side |
|-------|:-:|:-:|:-:|
| `preview` | reset to `null` | reset to `null` | broadcast `preview_status { running: false }` |
| `selectedPort` | reset to `null` | reset to `null` | — |
| `previewErrors` | `clearErrors()` | `clearErrors()` | — |
| `autoFixEnabled` | `false` | `false` | — |
| `autoFixRetries` | `0` | `0` | — |
| `activity` | `undefined` | `undefined` | — |
| `logEntries` | `[]` | `[]` | `clear_logs` broadcast |
| `unreadLogCount` | `0` | `0` | — |
| ViteManager | — | — | `stop()` then `start(newDir)` |
| Detected ports | — | — | Kill processes, clear array |
| `detectedPorts` | — | — | `[]`, then fresh `runPortScan()` |
| File watcher | — | — | Already handled |
| Log buffer | — | — | Cleared |

## Key files

| File | Changes |
|------|---------|
| `src/server/index.ts` | `activateSession()`: add Vite stop/start, port process cleanup, clear detected ports, broadcast clean state, clear log buffer. `new_session` handler: same cleanup. New `killProcessesOnPorts()` helper. |
| `src/client/App.tsx` | `resumeSessionInternal()`: reset preview/port/error/autofix/log state. `handleSessionNew()`: same. Add `clear_logs` handler. |
| `src/server/types.ts` | No changes needed — `WsClearLogs` and `WsPreviewStatus` already exist. |
| `src/server/vite-manager.ts` | No changes needed. |

## Edge cases

1. **Session with no workspace dir** (legacy or newly created). `activateSession()`
   sets `activeSessionDir = null`. We stop Vite and kill detected port processes
   but don't start Vite (no directory to serve). Preview shows "not running"
   until a message creates the session directory.

2. **Switching to the same session** (re-click in sidebar). `activateSession()`
   detects `dir === activeSessionDir` and skips the directory change branch.
   No Vite restart needed — it's already serving the right directory.

3. **Rapid session switching** (click A, immediately click B). Each
   `activateSession()` call stops the previous Vite. The last switch wins.
   ViteManager's `stop()` is synchronous (sends SIGTERM), so rapid calls are
   safe — `start()` checks `if (this.proc) return` and only the final
   `start()` actually spawns.

4. **Claude is running when user switches sessions.** The Claude process
   continues in the background (it's tied to the agent session, not the active
   directory). When it finishes, the `done` handler calls
   `viteManager.start(getActiveDir())` which will use the *current* active
   directory (the new session), not the old one. This is correct — the
   auto-restart after Claude finishes should always target the active session.

5. **`fuser` not available.** The `killProcessesOnPorts()` function catches
   errors and logs a warning. Detected port processes are not killed, but
   the port array is still cleared and the port scanner will rediscover any
   still-open ports in the next scan cycle. The user may see stale ports
   briefly.

6. **Process on detected port is not under sessions root.** The cwd safety
   check skips it. This could happen if a system service (e.g. a database GUI)
   happens to run on a port in the scan range. The port will still be cleared
   from `detectedPorts` and may reappear in the next scan — that's acceptable.

## Testing

### Integration tests

New file: `src/server/integration_tests/session-switch-preview.test.ts`

1. **Vite restarts on session switch.** Create two sessions (A, B). Switch to
   B via `get_chat_history`. Assert `StubViteManager.stop()` was called,
   followed by `start(sessionB.workspaceDir)`. Assert the client receives
   `preview_status { running: false }` followed by `preview_status { running: true }`.

2. **Detected ports cleared on session switch.** Inject `detectedPorts` via
   the `detectPorts` stub. Switch sessions. Assert `preview_status` is
   broadcast with no detected ports. Assert a fresh port scan runs.

3. **New session clears preview.** Send `new_session`. Assert Vite is
   stopped and `preview_status { running: false }` is sent.

4. **Same session no-op.** Switch to the already-active session. Assert
   Vite is NOT restarted.

5. **Clear logs on switch.** Switch sessions. Assert `clear_logs` message
   is sent to the client.

### Client tests

Extend existing App.tsx tests (or add to a new test file):

6. **`resumeSessionInternal` resets preview state.** Mock the WebSocket, call
   resume, assert `preview` is null, `selectedPort` is null, errors are
   cleared, autofix is disabled.

7. **`handleSessionNew` resets preview state.** Same assertions as above.

8. **`clear_logs` handler clears log entries.** Send a `clear_logs` message
   via the fake WebSocket. Assert `logEntries` is empty.
