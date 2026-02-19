---
status: planned
---

# 037 — Config-driven preview & session change cleanup

## Problem

### 1. Blind Vite: no framework awareness

Today ViteManager unconditionally spawns ShipIt's bundled Vite binary against
every session's workspace directory. This works for Vite-based projects but is
wrong for everything else:

- **Next.js / Remix / Astro** — Vite starts but serves nothing useful. The
  actual preview only appears if Claude happens to run `npm run dev`, which the
  port scanner detects as a side effect.
- **Static HTML** — Vite happens to work as a static file server, but there's
  no explicit intent.
- **Backend-only projects** — Vite starts pointlessly.

There is no way for a project to declare *what* preview command to run.

### 2. Session switch leaks

When a user switches sessions, preview-related state is not cleaned up:

- ViteManager keeps serving the old session's files.
- User-spawned dev servers (Next.js on port 3001, etc.) keep running and get
  detected as belonging to the new session.
- Client state (`selectedPort`, `previewErrors`, `logEntries`, etc.) persists
  across switches.

## Design overview

1. Introduce **`shipit.yaml`** — a per-project config file that declares the
   preview command and port.
2. Replace **ViteManager** with a general-purpose **PreviewManager** that reads
   config, spawns the right command, and tracks the process.
3. Fall back to **`package.json` `dev` script** when `shipit.yaml` is absent.
4. When neither exists, **prompt the user** with a button to generate
   `shipit.yaml` via Claude.
5. Update all **templates** to ship with `shipit.yaml`.
6. On **session change**, stop the old preview process, kill detected-port
   processes, reset client state, and start the new session's preview.

---

## 1. `shipit.yaml` format

Lives at the workspace root (e.g. `/workspace/sessions/{id}/shipit.yaml`).

```yaml
preview:
  command: npm run dev    # Shell command to start the dev server
  port: 3001              # Port the server listens on
```

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `preview.command` | yes | — | Shell command to run. Executed with `cwd` set to the workspace root. |
| `preview.port` | no | auto-detect | Expected port. If omitted, PreviewManager polls the scan-port list until one opens. |
| `preview.directory` | no | `.` | Working directory relative to workspace root. For monorepos where the dev server lives in a subdirectory. |

Minimal example (static HTML project using ShipIt's built-in Vite):

```yaml
preview:
  command: vite
  port: 5173
```

**Parsing:** Use a small YAML parser (`yaml` npm package, already available in
Node). Validate with a type guard. Malformed files produce a
`preview_config_error` WS message with a human-readable description.

---

## 2. Config resolution

New module: **`src/server/preview-config.ts`**

```ts
interface PreviewConfig {
  command: string;
  port?: number;
  directory?: string;
  source: "shipit.yaml" | "package.json" | "none";
}

async function resolvePreviewConfig(workspaceDir: string): Promise<PreviewConfig>
```

**Resolution order:**

```
1. Read <workspaceDir>/shipit.yaml
   → if present and has `preview.command`: return config (source: "shipit.yaml")

2. Read <workspaceDir>/package.json
   → if present and has `scripts.dev`: return { command: "npm run dev", source: "package.json" }
     - Attempt to extract port from the dev script string (e.g. "--port 3001")
     - If no port found, leave port undefined (auto-detect)

3. Return { command: "", source: "none" }
```

When source is `"none"`, the server sends a `preview_config_missing` message
to the client so the UI can prompt the user.

---

## 3. PreviewManager (replaces ViteManager)

New file: **`src/server/preview-manager.ts`**

```ts
class PreviewManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _running = false;
  private _port: number | null = null;
  private _config: PreviewConfig | null = null;

  get running(): boolean;
  get port(): number | null;
  get config(): PreviewConfig | null;

  /**
   * Resolve config and start the preview server.
   * If the resolved command is "vite" (bare), use ShipIt's bundled Vite
   * binary with the wrapper config (error-capture plugin).
   */
  async start(workspaceDir: string): Promise<void>;

  /** Stop the running preview process. */
  stop(): void;

  /** Stop then start with the given workspace dir. */
  async restart(workspaceDir: string): Promise<void>;

  // Events: "ready" (port), "stopped" (code), "error" (err), "config_missing"
}
```

### Start flow

```
start(workspaceDir):
  config = await resolvePreviewConfig(workspaceDir)
  this._config = config

  if config.source === "none":
    emit("config_missing")
    return

  if config.command is bare "vite":
    // Use ShipIt's bundled Vite binary with wrapper config (error capture)
    spawn VITE_BIN with --config <wrapper> --port <port> --host 0.0.0.0
    (same as current ViteManager.start)
  else:
    // General command: run via shell
    cwd = resolve(workspaceDir, config.directory ?? ".")
    spawn("sh", ["-c", config.command], { cwd })

  Monitor stdout for readiness patterns:
    "Local:", "ready in", "listening on", "started server on",
    "compiled successfully", "VITE", "http://localhost"

  If config.port is set:
    Poll that port with checkPort() every 500ms (max 30s)
    When open → _port = config.port, _running = true, emit("ready")
  Else:
    Poll DEFAULT_SCAN_PORTS (excluding baseline + server port) every 500ms
    When a new port opens → _port = port, _running = true, emit("ready")
```

### Vite special case

When `command` is exactly `"vite"` (bare word, not `npm run dev` that invokes
vite), PreviewManager uses ShipIt's bundled Vite binary and generates the
wrapper config with the error-capture plugin. This preserves:

- No npm install required (uses ShipIt's own `node_modules/.bin/vite`)
- Error capture via `transformIndexHtml`
- The wrapper config that merges the user's existing vite config

This keeps the static-html template working (no package.json needed) and
preserves error capture for projects that explicitly opt into bare `vite`.

### Error capture for non-Vite servers

For non-Vite commands, the `transformIndexHtml` approach doesn't work. Error
capture is **not available** in v1 for non-Vite projects. This is acceptable
because:

- The preview error panel already notes which errors it caught
- Console errors still appear in the terminal logs tab
- A future enhancement can add a reverse proxy that injects the error-capture
  script into HTML responses (out of scope for this feature)

---

## 4. Session change cleanup

### Server side: `activateSession()`

When `activateSession()` detects a directory change:

```
activateSession(sessionId):
  ... existing logic (update activeSessionDir, restart FileWatcher) ...

  if directory changed:
    // 1. Stop current preview process
    previewManager.stop()

    // 2. Kill processes on previously-detected ports
    await killProcessesOnPorts(detectedPorts, sessionsRoot)

    // 3. Clear detected ports
    detectedPorts = []

    // 4. Broadcast clean "not running" preview status immediately
    broadcastPreviewStatus()

    // 5. Clear terminal logs (old session's output is irrelevant)
    logBuffer = []
    broadcast({ type: "clear_logs" })

    // 6. Start preview for the new session's workspace (if it exists)
    if (newDir)
      await previewManager.start(newDir)

    // 7. Run a fresh port scan
    await runPortScan()
```

### Server side: `new_session` handler

```
if (msg.type === "new_session"):
  ... existing logic ...
  previewManager.stop()
  await killProcessesOnPorts(detectedPorts, sessionsRoot)
  detectedPorts = []
  broadcastPreviewStatus()
  logBuffer = []
  broadcast({ type: "clear_logs" })
```

No `previewManager.start()` — the next `send_message` or `apply_template`
will create the session directory and trigger preview start.

### Kill processes on detected ports

```ts
/**
 * Kill processes listening on the given ports.
 * Best-effort — failures are logged but do not throw.
 * Only kills processes whose cwd is within the sessions root directory,
 * as a safety guard against killing unrelated system processes.
 */
async function killProcessesOnPorts(
  ports: number[],
  sessionsRoot: string
): Promise<void> {
  for (const port of ports) {
    try {
      const { stdout } = await execFileAsync(
        "fuser", [`${port}/tcp`], { timeout: 3000 }
      );
      const pids = stdout.trim().split(/\s+/).map(Number).filter(Boolean);
      for (const pid of pids) {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd && cwd.startsWith(sessionsRoot)) {
          process.kill(pid, "SIGTERM");
        }
      }
    } catch {
      // fuser returns non-zero when no process found — expected
    }
  }
}
```

Safety guards:
- Only kills processes whose cwd is under `/workspace/sessions/`
- Uses SIGTERM (graceful), not SIGKILL
- Best-effort with silent failure
- `fuser` unavailable → degrades gracefully (log warning, skip kills)

### Client side: state reset

In both `resumeSessionInternal()` and `handleSessionNew()`:

```ts
setPreview(null);
setSelectedPort(null);
clearPreviewErrors();
setAutoFixEnabled(false);
autoFixRetriesRef.current = 0;
setAutoFixRetries(0);
autoFixCooldownRef.current = false;
autoFixErrorSignatureRef.current = null;
setActivity(undefined);
setLogEntries([]);
setUnreadLogCount(0);
```

---

## 5. New WS messages

### `preview_config_missing` (server → client)

Sent when PreviewManager cannot find a valid config for the session.

```ts
interface WsPreviewConfigMissing {
  type: "preview_config_missing";
  /** What was checked and not found */
  checked: ("shipit.yaml" | "package.json")[];
}
```

### `init_preview_config` (client → server)

Sent when user clicks "Set up preview" button. Server sends a message to
Claude asking it to create a `shipit.yaml` for the project.

```ts
interface WsInitPreviewConfig {
  type: "init_preview_config";
}
```

The server handles this by sending a prompt to Claude:

```
Analyze this project and create a shipit.yaml file at the workspace root.
The file should declare the preview command and port. Example format:

preview:
  command: npm run dev
  port: 3000

Look at package.json scripts, framework config files, and project structure
to determine the correct command and port.
```

After Claude creates the file, the FileWatcher detects the change, and
PreviewManager re-resolves config and starts the preview.

### `preview_config_error` (server → client)

Sent when `shipit.yaml` exists but is malformed.

```ts
interface WsPreviewConfigError {
  type: "preview_config_error";
  message: string;
}
```

---

## 6. Client UI for missing config

When the client receives `preview_config_missing`, the PreviewFrame shows:

```
┌──────────────────────────────────────┐
│                                      │
│     No preview server configured     │
│                                      │
│  Add a shipit.yaml to your project   │
│  to enable live preview.             │
│                                      │
│     [ Set up with Claude ]           │
│                                      │
└──────────────────────────────────────┘
```

Clicking the button sends `init_preview_config`. While Claude works, the
button shows a spinner. When the FileWatcher detects `shipit.yaml` creation
and PreviewManager starts, the normal preview replaces this prompt.

---

## 7. Template updates

Every template that runs a dev server gets a `shipit.yaml`. Templates that
don't serve HTTP (node-cli-ts) do not.

| Template | `shipit.yaml` contents |
|----------|----------------------|
| react-vite-ts | `preview:\n  command: npm run dev\n  port: 5173` |
| react-tailwind-vite-ts | `preview:\n  command: npm run dev\n  port: 5173` |
| vue-vite-ts | `preview:\n  command: npm run dev\n  port: 5173` |
| svelte-vite-ts | `preview:\n  command: npm run dev\n  port: 5173` |
| vanilla-vite | `preview:\n  command: npm run dev\n  port: 5173` |
| static-html | `preview:\n  command: vite\n  port: 5173` |
| nextjs | `preview:\n  command: npm run dev\n  port: 3001` |
| astro | `preview:\n  command: npm run dev\n  port: 5173` |
| express-ts | `preview:\n  command: npm run dev\n  port: 3001` |
| hono-ts | `preview:\n  command: npm run dev\n  port: 3001` |
| fastify-ts | `preview:\n  command: npm run dev\n  port: 3001` |
| node-cli-ts | *(no shipit.yaml)* |

The static-html template uses `command: vite` (bare) to trigger the
ShipIt-bundled-Vite special case — no npm required.

---

## 8. Post-turn auto-start behavior

Currently after Claude finishes a turn:
```ts
if (!viteManager.running) {
  viteManager.start(getActiveDir());
}
await runPortScan();
```

Updated to:
```ts
if (!previewManager.running) {
  await previewManager.start(getActiveDir());
}
await runPortScan();
```

This now starts the *right* command for the project, not blindly Vite.

**FileWatcher integration:** When `shipit.yaml` is created or modified, the
FileWatcher's `changes` event fires. The server detects `shipit.yaml` in the
changed paths and calls `previewManager.restart(getActiveDir())` to pick up
the new config. This handles the case where Claude creates `shipit.yaml`
mid-session (including via the `init_preview_config` flow).

---

## 9. `getPreviewStatus()` update

The preview status message now reflects the resolved config source:

```ts
const getPreviewStatus = (): WsServerMessage => {
  if (previewManager.running && previewManager.port) {
    return {
      type: "preview_status",
      running: true,
      port: previewManager.port,
      url: `http://localhost:${previewManager.port}`,
      source: previewManager.config?.command === "vite" ? "vite" : "detected",
      detectedPorts: detectedPorts.length > 0 ? detectedPorts : undefined,
    };
  }
  if (detectedPorts.length > 0) {
    return {
      type: "preview_status",
      running: true,
      port: detectedPorts[0],
      url: `http://localhost:${detectedPorts[0]}`,
      source: "detected",
      detectedPorts,
    };
  }
  return {
    type: "preview_status",
    running: false,
    port: 5173,
    url: `http://localhost:5173`,
  };
};
```

---

## State reset matrix (session change)

| State | `resumeSessionInternal` | `handleSessionNew` | Server-side |
|-------|:-:|:-:|:-:|
| `preview` | reset to `null` | reset to `null` | broadcast `preview_status { running: false }` |
| `selectedPort` | reset to `null` | reset to `null` | — |
| `previewErrors` | `clearErrors()` | `clearErrors()` | — |
| `autoFixEnabled` | `false` | `false` | — |
| `autoFixRetries` | `0` | `0` | — |
| `activity` | `undefined` | `undefined` | — |
| `logEntries` | `[]` | `[]` | server broadcasts `clear_logs` |
| `unreadLogCount` | `0` | `0` | — |
| PreviewManager | — | — | `stop()` then `start(newDir)` |
| Detected port procs | — | — | `killProcessesOnPorts()` |
| `detectedPorts` | — | — | `[]`, then fresh `runPortScan()` |
| Log buffer | — | — | Cleared |

---

## Key files

| File | Changes |
|------|---------|
| `src/server/preview-config.ts` | **New.** `resolvePreviewConfig()`, YAML parsing, `PreviewConfig` type. |
| `src/server/preview-manager.ts` | **New.** Replaces `src/server/vite-manager.ts`. Config-driven process lifecycle. |
| `src/server/vite-manager.ts` | **Deleted.** Logic moves into PreviewManager's bare-`vite` special case. |
| `src/server/index.ts` | Replace `viteManager` with `previewManager`. Update `activateSession()`, `new_session`, post-turn handler, `getPreviewStatus()`, FileWatcher `shipit.yaml` detection. Add `killProcessesOnPorts()`. Handle `init_preview_config` and `preview_config_missing` / `preview_config_error` messages. |
| `src/server/types.ts` | Add `WsPreviewConfigMissing`, `WsPreviewConfigError`, `WsInitPreviewConfig` to message unions. |
| `src/server/templates.ts` | Add `shipit.yaml` to each template's `files` map (except node-cli-ts). |
| `src/client/App.tsx` | Reset preview state in `resumeSessionInternal()` and `handleSessionNew()`. Handle `preview_config_missing` / `preview_config_error`. Handle `init_preview_config` send. |
| `src/client/components/PreviewFrame.tsx` | Show "no config" prompt with "Set up with Claude" button when config missing. |

---

## Edge cases

1. **Session with no workspace dir.** `activateSession()` sets
   `activeSessionDir = null`. Preview stops, no start attempted. Shows "not
   running" until a message creates the session directory.

2. **Switching to the same session.** `activateSession()` detects
   `dir === activeSessionDir` and skips. No preview restart.

3. **Rapid session switching.** Each switch stops the preview. `stop()` sends
   SIGTERM synchronously. The last `start()` wins — `start()` checks
   `if (this.proc) return`.

4. **Claude running during switch.** Claude continues (tied to agent session).
   Post-turn handler calls `previewManager.start(getActiveDir())` which
   targets the *current* active directory.

5. **`fuser` not available.** `killProcessesOnPorts()` catches errors, logs
   warning. Stale port processes survive but the port array is cleared.
   Port scanner may rediscover them.

6. **`shipit.yaml` created mid-session.** FileWatcher detects the change.
   Server calls `previewManager.restart()` to pick up new config.

7. **`shipit.yaml` with unknown fields.** Ignored — only `preview.command`,
   `preview.port`, `preview.directory` are read. Forward-compatible.

8. **`package.json` dev script that isn't a server.** (e.g., `tsx src/index.ts`
   for node-cli-ts). PreviewManager starts the command, polls for a port,
   times out after 30s, emits `"config_missing"` so the user sees the prompt.
   Port scanner also finds nothing. Acceptable — the CLI template doesn't need
   a preview.

9. **Port conflict.** If the configured port is already occupied (e.g., by a
   leaked process from a previous session), the dev server may fail to start
   or pick a different port. PreviewManager detects the process exit and emits
   `"stopped"`. The port scanner can still find the actual port if the server
   chose a fallback.

---

## Testing

### Unit tests

**`src/server/preview-config.test.ts`:**

1. Resolves `shipit.yaml` with command and port.
2. Resolves `shipit.yaml` with command only (no port).
3. Resolves `shipit.yaml` with directory field.
4. Falls back to `package.json` dev script when no `shipit.yaml`.
5. Extracts port from `package.json` dev script (e.g. `--port 3001`).
6. Returns `source: "none"` when neither file exists.
7. Returns `source: "none"` when `package.json` exists but has no dev script.
8. Handles malformed `shipit.yaml` gracefully (returns error info).

### Integration tests

**`src/server/integration_tests/session-switch-preview.test.ts`:**

1. **Preview restarts on session switch.** Create two sessions. Switch via
   `get_chat_history`. Assert preview stopped then started for new dir.
2. **Detected ports cleared on switch.** Inject ports via stub. Switch.
   Assert `preview_status` has no detected ports.
3. **New session clears preview.** Send `new_session`. Assert preview stopped.
4. **Same session is no-op.** Switch to active session. Assert no restart.
5. **Clear logs on switch.** Switch sessions. Assert `clear_logs` sent.
6. **Config missing triggers prompt.** Session with no `shipit.yaml` and no
   `package.json`. Assert `preview_config_missing` sent.
7. **`init_preview_config` sends prompt to Claude.** Send the message.
   Assert Claude receives a prompt about creating `shipit.yaml`.

### Client tests

8. **`resumeSessionInternal` resets preview state.** Assert `preview` null,
   `selectedPort` null, errors cleared, autofix disabled.
9. **`handleSessionNew` resets preview state.** Same assertions.
10. **PreviewFrame shows config-missing prompt.** Render with
    `configMissing=true`. Assert button visible.
11. **Config-missing button sends `init_preview_config`.** Click button.
    Assert WS message sent.

### Template tests

12. **All server templates include `shipit.yaml`.** Iterate templates, assert
    each server-capable template has `shipit.yaml` in its files map with valid
    `preview.command` and `preview.port`.
