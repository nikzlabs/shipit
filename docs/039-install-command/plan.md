
# 039 — Install command in `shipit.yaml`

## Problem

When a project template is applied or a user imports a repo, dependencies are
not installed automatically. The user must manually run `npm install` (or
equivalent) via the interactive terminal or ask Claude to do it. This is a
friction point — the preview server fails to start because `node_modules/`
doesn't exist, and the user sees cryptic errors instead of a working preview.

There is no declarative way for a project to specify **how** to install its
dependencies.

## Design overview

Extend `shipit.yaml` (see [037](../037-vite-preview-session-change/plan.md))
with a top-level `install` field. The PreviewManager reads this field and runs
the install command before starting the preview server.

---

## 1. `shipit.yaml` `install` field

The `install` key is a top-level sibling to `preview`. It specifies an
optional shell command that installs project dependencies before the preview
server starts.

```yaml
# Full example
install: npm install
preview:
  command: npm run dev
  ports: [5173]
```

The field is:
- **Optional** — when absent, no install step is performed.
- **A string** — the shell command to run (e.g. `npm install`, `yarn install`,
  `pnpm install`, `pip install -r requirements.txt`).
- **Flexible** — any shell command works, not just npm.

### Examples

```yaml
# Node.js project
install: npm install
preview:
  command: npm run dev
  ports: [5173]
```

```yaml
# Python project
install: pip install -r requirements.txt
preview:
  command: python -m http.server 8000
  ports: [8000]
```

```yaml
# Monorepo with directory
install: npm install
preview:
  command: npm run dev
  ports: [5173]
  directory: packages/frontend
```

```yaml
# Static HTML — no install needed
preview:
  html: index.html
```

---

## 2. When install runs

The install command runs in these scenarios:

1. **Before the preview command** — PreviewManager always runs `install` (if
   configured) before spawning the preview command. If install fails, the
   preview does not start and an `install_status` error message is sent.

2. **After template application** — when `apply_template` or
   `home_create_repo_with_template` scaffolds files that include a
   `shipit.yaml` with an `install` field, PreviewManager runs install when it
   starts the preview.

3. **After `shipit.yaml` is created or modified** — when Claude (or the user)
   writes `shipit.yaml` mid-session and the FileWatcher detects it,
   PreviewManager restarts and runs install if configured.

4. **On session resume** — when the user switches to a session whose
   `shipit.yaml` has an `install` field, if the install has not already run
   (determined by checking for an install marker file `.shipit/.install-done`).

---

## 3. Install process

The install process is managed by `install-runner.ts`:

```
PreviewManager.start(workspaceDir):
  config = await resolvePreviewConfig(workspaceDir)

  if config.install:
    cwd = resolve(workspaceDir, config.mode.directory ?? ".")
    markerDir = join(workspaceDir, ".shipit")
    markerFile = join(markerDir, ".install-done")

    // Skip if install has already succeeded for this workspace
    if not exists(markerFile):
      emit("install_status", { status: "running" })
      exitCode = await runCommand(config.install, { cwd })
      if exitCode !== 0:
        emit("install_status", { status: "error", message: "..." })
        return   // Do not start preview
      // Write marker to avoid redundant re-runs
      mkdirSync(markerDir, { recursive: true })
      writeFileSync(markerFile, new Date().toISOString())
      emit("install_status", { status: "complete" })

  // ... proceed to start preview
```

**Behavior:**
- Runs with `cwd` set to the workspace root (or `preview.directory` if set).
- stdout/stderr are streamed to the client as `log_entry` messages with
  `source: "install"`.
- On success, writes a marker file `.shipit/.install-done` to avoid redundant
  re-runs on session switches.
- On failure, sends `install_status { status: "error" }` and does not start
  the preview.

---

## 4. WS message: `install_status`

Server → Client. Sent when the install command starts, completes, or fails.

```ts
interface WsInstallStatus {
  type: "install_status";
  status: "running" | "complete" | "error";
  /** Human-readable message (e.g. error details). */
  message?: string;
}
```

**Client UI behavior:**
- `running`: PreviewFrame shows "Installing dependencies..." with a spinner.
- `complete`: Clears the install indicator; preview starts normally.
- `error`: PreviewFrame shows the error message with a "Retry" button.

---

## 5. Config resolution integration

The `PreviewConfig` type (from doc 037) gains an `install` field:

```ts
interface PreviewConfig {
  mode: PreviewMode;
  source: "shipit.yaml" | "package.json" | "index.html" | "none";
  /** Shell command to install dependencies. From shipit.yaml `install` field. */
  install?: string;
}
```

Resolution behavior:
- When `shipit.yaml` is present, `install` is read from the top-level
  `install` field (if it exists).
- When falling back to `package.json` or `index.html`, `install` is
  `undefined` — only `shipit.yaml` can declare an install command.

---

## 6. Template updates

All templates with `package.json` include `install: npm install` in their
`shipit.yaml`. Templates without dependencies (static-html) and without HTTP
(node-cli-ts) do not.

| Template | `shipit.yaml` `install` |
|----------|------------------------|
| react-vite-ts | `install: npm install` |
| react-tailwind-vite-ts | `install: npm install` |
| vue-vite-ts | `install: npm install` |
| svelte-vite-ts | `install: npm install` |
| vanilla-vite | `install: npm install` |
| static-html | *(none)* |
| nextjs | `install: npm install` |
| astro | `install: npm install` |
| express-ts | `install: npm install` |
| hono-ts | `install: npm install` |
| fastify-ts | `install: npm install` |
| node-cli-ts | *(no shipit.yaml)* |

---

## 7. Claude prompt for `init_preview_config`

When the user clicks "Set up with Claude" (no preview config found), the
prompt sent to Claude includes install guidance:

```
Analyze this project and create a shipit.yaml file at the workspace root.
The file configures the live preview and dependency installation.

For projects with dependencies (npm, yarn, pip, etc.), include an install command:

install: npm install
preview:
  command: npm run dev
  ports: [3000]

For static HTML projects (no build step, no dependencies):

preview:
  html: index.html

Look at package.json scripts, framework config files, and project structure
to determine the correct install command, preview mode, command, and ports.
```

---

## Key files

| File | Role |
|------|------|
| `src/server/install-runner.ts` | **New.** `parseInstallCommand()`, `isInstallDone()`, `markInstallDone()`, `clearInstallMarker()`, `runInstallCommand()` utility functions. |
| `src/server/types/ws-server-messages.ts` | `WsInstallStatus` type added to `WsServerMessage` union. |
| `src/server/types/terminal-types.ts` | `"install"` added to `WsLogEntry.source` union. |
| `src/server/templates.ts` | `shipit.yaml` with `install: npm install` added to all npm-based templates. |
| `src/client/components/TerminalPanel.tsx` | `"install"` added to `LogSource`, filter UI, color/label maps. |
| `src/server/preview-config.ts` | *(future)* `install` field in `PreviewConfig` type and `resolvePreviewConfig()`. |
| `src/server/preview-manager.ts` | *(future)* Runs install before preview start, emits `install_status` events. |
| `src/client/components/PreviewFrame.tsx` | *(future)* Shows install progress/errors in preview pane. |

---

## Edge cases

1. **Install command fails.** PreviewManager emits `install_status` with
   `status: "error"` and does not start the preview. The client shows the
   error with a "Retry" button. On retry, the marker file is absent (never
   written on failure), so install runs again.

2. **Install already completed.** `.shipit/.install-done` marker exists. The
   install step is skipped entirely. To force a re-install, delete the marker
   file (or run the install command via the interactive terminal).

3. **`shipit.yaml` changed mid-install.** The FileWatcher fires and calls
   `previewManager.restart()`. The `stop()` call sends SIGTERM to the install
   process. The new `start()` reads the updated config and re-runs install.

4. **`install` with no `preview`.** If `shipit.yaml` has `install` but no
   `preview` key, config resolution returns `source: "none"` — the install
   field is only used when preview config is also present. This avoids
   running install for projects with no preview intent.

5. **Session switch during install.** `stop()` kills the install process.
   The marker file was never written (install didn't complete), so the next
   `start()` for this session will re-run install.

6. **Non-string `install` value.** Validation error — `preview_config_error`
   sent to client.

---

## Testing

### Install runner unit tests (`src/server/install-runner.test.ts`)

1. `parseInstallCommand()` extracts install command from yaml string.
2. `parseInstallCommand()` returns `undefined` when no install field.
3. `isInstallDone()` / `markInstallDone()` / `clearInstallMarker()` marker lifecycle.
4. `runInstallCommand()` with a simple command (e.g. `echo hello`).

### Preview config unit tests (`src/server/preview-config.test.ts`, additional)

5. Resolves `shipit.yaml` with `install` field — returns `install: "npm install"`.
6. Resolves `shipit.yaml` without `install` field — returns `install: undefined`.
7. Non-string `install` value is rejected (validation error).
8. Fallback to `package.json` does not set `install` (only `shipit.yaml` can).

### Integration tests (`src/server/integration_tests/`)

9. Install runs before preview — assert `install_status { status: "running" }` sent.
10. Install failure blocks preview — assert `install_status { status: "error" }`.
11. Install skipped when marker exists — no `install_status` message sent.
12. Install marker written on success — `.shipit/.install-done` exists.

### Template tests

13. All npm templates include `install: npm install` in their `shipit.yaml`.

### Client tests

14. PreviewFrame shows install progress spinner on `install_status { status: "running" }`.
15. PreviewFrame shows install error with retry button on `install_status { status: "error" }`.
