---
status: in-progress
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
   preview command (with ports) **or** a static HTML entry point.
2. Replace **ViteManager** with a general-purpose **PreviewManager** that reads
   config, spawns the right command, and tracks the process.
3. Fall back to **`package.json` `dev` script** when `shipit.yaml` is absent.
4. Fall back to **`index.html` detection** — serve static files with the
   bundled Vite binary when an HTML entry point exists but no config/scripts.
5. When nothing is found, **prompt the user** with a button to generate
   `shipit.yaml` via Claude.
6. Update all **templates** to ship with `shipit.yaml`.
7. On **session change**, stop the old preview process, kill detected-port
   processes, reset client state, and start the new session's preview.

---

## 1. `shipit.yaml` format

Lives at the workspace root (e.g. `/workspace/sessions/{id}/shipit.yaml`).

Two mutually exclusive modes — **`command`** (run a dev server) or **`html`**
(serve static files):

```yaml
# Mode 1: Run a dev server command
preview:
  command: npm run dev
  ports: [3000]
```

```yaml
# Mode 2: Serve static HTML with ShipIt's bundled Vite
preview:
  html: index.html
```

A single command can expose multiple ports (e.g. frontend + API started via
`concurrently`):

```yaml
preview:
  command: concurrently "npm run dev:client" "npm run dev:api"
  ports: [3000, 8080]
```

The first port in the list is the **primary** preview (shown by default in the
iframe). All ports appear in the port selector dropdown so the user can switch.

**Fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `preview.command` | mutual-excl with `html` | — | Shell command to run. Executed with `cwd` set to the workspace root. |
| `preview.html` | mutual-excl with `command` | — | Path to an HTML file relative to workspace root. Served by ShipIt's bundled Vite on port 5173 with error-capture plugin. |
| `preview.ports` | no | auto-detect | Port(s) the command listens on. Array of numbers. Only used with `command`. If omitted, PreviewManager polls the scan-port list until one opens. |
| `preview.directory` | no | `.` | Working directory relative to workspace root. For monorepos where the dev server lives in a subdirectory. |

Minimal examples:

```yaml
# Static HTML project — no package.json or npm install needed
preview:
  html: index.html
```

```yaml
# Vite-based React app
preview:
  command: npm run dev
  ports: [5173]
```

**Parsing:** Use a small YAML parser (`yaml` npm package, already available in
Node). Validate with a type guard. Malformed files produce a
`preview_config_error` WS message with a human-readable description.

---

## 2. Config resolution

New module: **`src/server/preview-config.ts`**

```ts
type PreviewMode =
  | { kind: "command"; command: string; ports?: number[]; directory?: string }
  | { kind: "html"; html: string };

interface PreviewConfig {
  mode: PreviewMode;
  source: "shipit.yaml" | "package.json" | "index.html" | "none";
}

async function resolvePreviewConfig(workspaceDir: string): Promise<PreviewConfig>
```

**Resolution order:**

```
1. Read <workspaceDir>/shipit.yaml
   → if present and has `preview.command`:
       return { mode: { kind: "command", command, ports, directory }, source: "shipit.yaml" }
   → if present and has `preview.html`:
       return { mode: { kind: "html", html }, source: "shipit.yaml" }

2. Read <workspaceDir>/package.json
   → if present and has `scripts.dev`:
       return { mode: { kind: "command", command: "npm run dev", ports }, source: "package.json" }
     - Attempt to extract port from the dev script string (e.g. "--port 3001")
     - If found, return ports: [3001]. If not, leave ports undefined (auto-detect)

3. Check for <workspaceDir>/index.html
   → if present:
       return { mode: { kind: "html", html: "index.html" }, source: "index.html" }
     (implicit static serving — preserves zero-config experience for blank sessions)

4. Return { mode: { kind: "command", command: "" }, source: "none" }
```

When source is `"none"`, the server sends a `preview_config_missing` message
to the client so the UI can prompt the user.

Step 3 is what preserves today's behavior: Claude writes an `index.html` in
a blank session → preview works immediately with no config file needed.

---

## 3. PreviewManager (replaces ViteManager)

New file: **`src/server/preview-manager.ts`**

```ts
class PreviewManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _running = false;
  private _ports: number[] = [];
  private _config: PreviewConfig | null = null;

  get running(): boolean;
  /** All ports this preview is serving on. First is primary. */
  get ports(): number[];
  /** Primary port (first in the list), or null if not running. */
  get port(): number | null;
  get config(): PreviewConfig | null;

  /**
   * Resolve config and start the preview server.
   * For "html" mode, use ShipIt's bundled Vite binary with the wrapper
   * config (error-capture plugin). For "command" mode, spawn via shell.
   */
  async start(workspaceDir: string): Promise<void>;

  /** Stop the running preview process. */
  stop(): void;

  /** Stop then start with the given workspace dir. */
  async restart(workspaceDir: string): Promise<void>;

  // Events: "ready" (ports), "stopped" (code), "error" (err), "config_missing"
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

  if config.mode.kind === "html":
    // Use ShipIt's bundled Vite binary with wrapper config (error capture)
    // Resolve html path to determine the root directory for Vite
    spawn VITE_BIN with --config <wrapper> --port 5173 --host 0.0.0.0
    (same as current ViteManager.start)
    _ports = [5173]
  else: // kind === "command"
    // General command: run via shell
    cwd = resolve(workspaceDir, config.mode.directory ?? ".")
    spawn("sh", ["-c", config.mode.command], { cwd })

  Monitor stdout for readiness patterns:
    "Local:", "ready in", "listening on", "started server on",
    "compiled successfully", "VITE", "http://localhost"

  If mode is "html":
    Poll port 5173 with checkPort() every 500ms (max 30s)
    When open → _running = true, emit("ready")
  Else if mode.ports is set:
    Poll all ports in mode.ports with checkPort() every 500ms (max 30s)
    As each port opens, add to _ports
    When the first port opens → _running = true, emit("ready", _ports)
    Continue polling remaining ports in background (they may start later)
  Else:
    Poll DEFAULT_SCAN_PORTS (excluding baseline + server port) every 500ms
    When a new port opens → _ports = [port], _running = true, emit("ready")
```

### `html` mode — bundled Vite

When `mode.kind === "html"`, PreviewManager uses ShipIt's bundled Vite binary
and generates the wrapper config with the error-capture plugin. This provides:

- No npm install required (uses ShipIt's own `node_modules/.bin/vite`)
- Error capture via `transformIndexHtml`
- The wrapper config that merges the user's existing vite config
- Always serves on port 5173

This is used by:
- The static-html template (`html: index.html` in shipit.yaml)
- The index.html fallback (no config, but `index.html` exists at root)
- Any project that explicitly sets `html:` in shipit.yaml

### Error capture for non-Vite servers

For `command` mode, the `transformIndexHtml` approach doesn't work. Error
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
The file configures the live preview. Use ONE of these two modes:

For projects with a dev server (npm run dev, etc.):

preview:
  command: npm run dev
  ports: [3000]

For static HTML projects (no build step):

preview:
  html: index.html

Look at package.json scripts, framework config files, and project structure
to determine the correct mode, command, and ports.
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
| react-vite-ts | `preview:\n  command: npm run dev\n  ports: [5173]` |
| react-tailwind-vite-ts | `preview:\n  command: npm run dev\n  ports: [5173]` |
| vue-vite-ts | `preview:\n  command: npm run dev\n  ports: [5173]` |
| svelte-vite-ts | `preview:\n  command: npm run dev\n  ports: [5173]` |
| vanilla-vite | `preview:\n  command: npm run dev\n  ports: [5173]` |
| static-html | `preview:\n  html: index.html` |
| nextjs | `preview:\n  command: npm run dev\n  ports: [3001]` |
| astro | `preview:\n  command: npm run dev\n  ports: [5173]` |
| express-ts | `preview:\n  command: npm run dev\n  ports: [3001]` |
| hono-ts | `preview:\n  command: npm run dev\n  ports: [3001]` |
| fastify-ts | `preview:\n  command: npm run dev\n  ports: [3001]` |
| node-cli-ts | *(no shipit.yaml)* |

The static-html template uses `html: index.html` to serve via ShipIt's
bundled Vite — no npm required.

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

The preview status message now reflects the resolved config and all managed
ports. Managed ports (from `config.ports`) are merged with scanner-detected
ports into a single `detectedPorts` array so the client's existing port
selector UI works without changes.

```ts
const getPreviewStatus = (): WsServerMessage => {
  // Merge managed ports (after the primary) with scanner-detected ports
  const extraManagedPorts = previewManager.ports.slice(1);
  const allDetected = [...extraManagedPorts, ...detectedPorts];

  if (previewManager.running && previewManager.port) {
    return {
      type: "preview_status",
      running: true,
      port: previewManager.port,              // primary port (first in config.ports)
      url: `http://localhost:${previewManager.port}`,
      source: previewManager.config?.mode.kind === "html" ? "vite" : "managed",
      detectedPorts: allDetected.length > 0 ? allDetected : undefined,
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

For example, with `ports: [3000, 8080]`:
- `port: 3000` (primary, shown in iframe by default)
- `detectedPorts: [8080, ...]` (available in the port selector dropdown)

The client's existing port selector already handles `detectedPorts`, so no UI
changes are needed for multi-port support.

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
   `preview.html`, `preview.ports`, `preview.directory` are read.
   Forward-compatible.

8. **`shipit.yaml` with both `command` and `html`.** Validation error —
   `preview_config_error` sent to client. The fields are mutually exclusive.

9. **`package.json` dev script that isn't a server.** (e.g., `tsx src/index.ts`
   for node-cli-ts). PreviewManager starts the command, polls for a port,
   times out after 30s, emits `"config_missing"` so the user sees the prompt.
   Port scanner also finds nothing. Acceptable — the CLI template doesn't need
   a preview.

10. **Blank session, Claude writes `index.html`.** No config files exist.
    Post-turn, PreviewManager re-resolves config. Step 3 finds `index.html`
    → starts bundled Vite. Preview works immediately, same as today.

11. **Port conflict.** If the configured port is already occupied (e.g., by a
   leaked process from a previous session), the dev server may fail to start
   or pick a different port. PreviewManager detects the process exit and emits
   `"stopped"`. The port scanner can still find the actual port if the server
   chose a fallback.

---

## Testing

### Unit tests

**`src/server/preview-config.test.ts`:**

1. Resolves `shipit.yaml` with `command` and single port.
2. Resolves `shipit.yaml` with `command` and multiple ports.
3. Resolves `shipit.yaml` with `command` only (no ports — auto-detect).
4. Resolves `shipit.yaml` with `html` field (static mode).
5. Rejects `shipit.yaml` with both `command` and `html` (validation error).
6. Resolves `shipit.yaml` with `directory` field.
7. Falls back to `package.json` dev script when no `shipit.yaml`.
8. Extracts port from `package.json` dev script (e.g. `--port 3001`) into `ports: [3001]`.
9. Falls back to `index.html` detection when no config/scripts exist.
10. Returns `source: "none"` when no files exist at all.
11. Returns `source: "none"` when `package.json` exists but has no dev script and no `index.html`.
12. Handles malformed `shipit.yaml` gracefully (returns error info).

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
    `preview.command`/`preview.ports` or `preview.html`.
