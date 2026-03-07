---
status: in-progress
---

# Preview Container Isolation

Run the preview (dev server) in a dedicated container, separate from the Claude session container. Today the preview process runs as a sibling to Claude CLI inside the same container — sharing memory, env vars, filesystem access, and PID namespace. A separate preview container provides resource isolation, secrets separation, and blast-radius containment.

## Motivation

When Claude and the preview share a container:

- **Resource contention** — a Vite/webpack build can exhaust the 512 MB memory limit, starving Claude
- **Secret leakage** — Claude can read `.env.local` (Clerk keys, Stripe keys, database URLs) and potentially leak them through tool use
- **Blast radius** — a crashing dev server can OOM-kill the entire container, taking Claude down

A separate preview container eliminates all of these by construction.

## Design

### Container topology

Every session gets at minimum two built-in containers on the same bridge network. Users may add more via Docker Compose (see "Docker Compose interaction" below). Both built-in containers use the same Docker image (`shipit-session-worker`), differentiated by the `WORKER_MODE` env var:

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  Session Container           │   │  Preview Container           │
│  WORKER_MODE=session         │   │  WORKER_MODE=preview         │
│                              │   │                              │
│  • Claude CLI                │   │  • Dev server (Vite, etc.)   │
│  • File watcher              │   │  • Install runner            │
│  • Terminal PTY              │   │                              │
│  • Session worker (:9100)    │   │  • Preview worker (:9100)    │
│                              │   │                              │
│  /user    ← workspace vol    │   │  /user    ← workspace vol   │
│  /credentials ← creds vol   │   │  (no credentials mount)      │
│                              │   │                              │
│  env: no repo secrets        │   │  env: repo secrets pushed    │
│                              │   │    via PUT /secrets at start │
└──────────────────────────────┘   └──────────────────────────────┘
         ▲                                 ▲
         │         bridge network          │
         └─────────────────────────────────┘
```

### Secrets isolation

The core security property: **Claude cannot read user secrets, but the preview can.**

Users typically store secrets (API keys for Clerk, Stripe, Supabase, etc.) in `.env` or `.env.local` files. In ShipIt, these are managed through the Secrets tab instead. These must be:
- Available to the dev server as environment variables
- Editable by the user (through the ShipIt UI)
- Persistent across sessions and preview restarts
- **Invisible to Claude CLI**

#### How it works

1. **Orchestrator-managed secrets (per-repo)** — secrets are stored in the orchestrator's SQLite database, keyed by repo URL (from `SessionInfo.remoteUrl`). A new `SecretStore` class follows `DeploymentStore`'s structural pattern (SQLite via `DatabaseManager`, class wrapping prepared statements) but uses `repo_url` as the key instead of `session_id`. `SecretStore` provides `saveSecrets(repoUrl, secrets)` and `loadSecrets(repoUrl)`. Secrets persist across sessions for the same repo — users enter their Clerk/Stripe keys once, and every session for that repo gets them.

2. **Injection via preview worker** — the preview worker exposes `PUT /secrets`, which accepts a `Record<string, string>`. This is a **full replace**, not a merge: the worker tracks which keys were set by previous `PUT /secrets` calls, removes any that are absent from the new payload, and sets all new key-value pairs in `process.env`. This ensures that when a user deletes a secret in the UI, it is actually removed from the dev server's environment — not just orphaned until container restart. After updating `process.env`, the worker restarts the dev server child process (if running). The restarted dev server inherits the updated `process.env`. The dev server reads env vars natively (Vite, Next.js, etc. all support `process.env`). No secrets are passed at container creation — this keeps a single code path for all scenarios (fresh sessions, warm pool activation, and user edits).

3. **Startup sequence** — the orchestrator creates the preview container, waits for the worker health check, pushes secrets via `PUT /secrets`, then sends `POST /preview/start`. Secrets are always pushed before the dev server starts — even if the repo has no secrets configured (or the session has no `remoteUrl`), the push sends an empty `Record<string, string>` and the preview starts normally.

4. **Session container gets no secrets** — only the built-in preview container receives repo secrets (via `PUT /secrets`). The session container (where Claude runs) never receives them. Claude cannot access them via `process.env`, `printenv`, or any filesystem path. User-provided containers (Docker Compose) manage their own env vars independently.

5. **User edits** — the user manages secrets through the **Secrets tab** in the Settings modal (under the Project section, alongside Deploy). The orchestrator handles reads and writes:
   - `GET /api/secrets?repoUrl=...` — load secrets from the database
   - `PUT /api/secrets` — save secrets to the database, then push them to the active preview container(s) via `PUT /secrets` on each preview worker
   - The preview worker replaces its tracked secrets in `process.env` and restarts the dev server

6. **Persistence** — secrets live in the orchestrator's SQLite database, keyed by repo URL. They survive across sessions, container restarts, and workspace resets. On each session start (and on user edits), secrets are loaded from the database and pushed to the preview worker via `PUT /secrets`.

#### `.env.local` file handling

Since secrets are injected via container env vars (not filesystem), `.env.local` files in the workspace are handled simply:

- If a `.env.local` exists in the repo (committed or scaffolded by Claude), it stays as-is in the workspace. Claude can read it, but it only contains non-sensitive defaults or placeholders.
- The preview container's env vars take precedence over `.env.local` values (standard env var priority: `process.env` > dotenv files).
- Users put real secrets (Clerk keys, Stripe keys, database URLs) in the Secrets tab, not in `.env.local`.

### Resource limits

With the preview in its own container, resource limits can be right-sized:

| Container | Memory | CPU | PIDs | Rationale |
|-----------|--------|-----|------|-----------|
| Session (Claude) | 256 MB | 0.5 | 256 | Claude CLI + node-pty + file watcher. ~60-85 MB typical, 150 MB peak. Claude-triggered `npm install` also runs here but is typically lightweight (single package adds). |
| Preview (dev server) | 512 MB | 0.5 | 256 | Vite/webpack builds are memory-hungry. Keep at 512 MB. |

This saves ~256 MB per session compared to today's single 512 MB container, while giving the preview MORE headroom (it no longer shares with Claude).

### Key properties

1. **Same workspace volume** — all containers in the session (built-in and user-provided) mount `/user` from the same source (bind mount or named volume with subpath). File watcher stays in the session container and sees changes from all containers. See "Shared workspace contract" below.

2. **Secrets only in built-in preview** — repo secrets are pushed to the built-in preview worker via `PUT /secrets`. The session container (Claude) never receives them. User-provided containers (Docker Compose) manage their own env vars. No credentials mount in preview, no secrets in session.

3. **Independent resource limits** — each container gets its own memory/CPU/PID limits. A runaway build can't starve Claude.

4. **Same bridge network** — the preview container joins the shipit bridge network so the orchestrator's preview proxy can reach it by IP.

5. **Preview worker** — a stripped-down session worker that only exposes preview-related endpoints: `/preview/start`, `/preview/stop`, `/preview/restart`, `/secrets`, `/health`, and `/events` (preview SSE events only).

### Changes by component

#### `container-lifecycle.ts`

- New `createPreviewContainer()` function that creates a container with:
  - Same workspace mount as the session container (reuse `buildMounts` but skip credentials)
  - No repo secrets at creation time — secrets are pushed via `PUT /secrets` after the worker is healthy
  - Env via `buildEnv()` with `WORKER_MODE=preview` added (`WORKSPACE_DIR` and `WORKER_PORT` are already set by `buildEnv()`)
  - Same network as the session container
  - Labels: `shipit-preview-for={sessionId}` for cleanup association, plus `shipit-parent-session={sessionId}` so `cleanupSessionDockerResources()` catches it

- `buildEnv()` — add `WORKER_MODE` to the env vars passed to Docker. Session containers get `WORKER_MODE=session`, preview containers get `WORKER_MODE=preview`.

- No changes to `buildContainerConfig()` memory defaults — `DEFAULT_MEMORY_LIMIT` lives in `session-container.ts` and is passed to `buildContainerConfig()` (in `container-lifecycle.ts`) via `LifecycleDeps.defaultMemoryLimit`

#### `session-container.ts` / `SessionContainerManager`

- `SessionContainer` gains `previewContainerIp`, `previewContainerId`, and `previewWorkerUrl` (constructed as `http://{previewContainerIp}:{workerPort}` after inspecting the preview container's bridge network IP, same pattern as the session container)
- `create()` spawns both containers (session first, then preview, in parallel if possible)
- `destroy()` tears down both containers
- `rediscover()` and `cleanupOrphans()` (delegated to `container-discovery.ts`) handle preview containers via the `shipit-preview-for` label
- `create()` waits for both containers to start (Docker-level), but does NOT poll worker health checks. Worker health checks are owned by `ContainerSessionRunner.startWorkerResources()` — it waits for the session worker (`_workerReady`) and then the preview worker before pushing secrets and starting the preview.

#### `preview-proxy.ts`

- When resolving the container IP for preview traffic, use `sc.previewContainerIp` instead of `sc.containerIp`. This is the only routing change — subdomain parsing, path-based fallback, and WebSocket upgrade all stay the same.

#### `session-worker.ts` (preview mode)

- Add new `WORKER_MODE` env var (does not exist today). Values: `session` (default, current behavior) or `preview`
- In preview mode, only register preview endpoints (`/preview/*`, `/secrets`, `/health`, `/events`)
- Skip agent, terminal, and file watcher initialization
- SSE stream only emits preview events
- Secrets arrive via `PUT /secrets` (HTTP) — no filesystem or config.env injection needed

#### `container-session-runner.ts`

- Add `previewWorkerUrl` field (today only `workerUrl` exists, pointing at the session container). All preview-related POSTs (`/preview/start`, `/preview/stop`, `/preview/restart`) go to `previewWorkerUrl` instead of `workerUrl`.
- `startWorkerResources()` pushes secrets via `PUT /secrets`, then sends `POST /preview/start` to `previewWorkerUrl`
- `stopWorkerResources()` sends `POST /preview/stop` to `previewWorkerUrl` (today it sends to `workerUrl`)
- Preview SSE events come from the preview container's `/events` endpoint
- Connect two SSE streams: one to session worker (agent, terminal, files), one to preview worker (preview events). Each stream has independent reconnection state (backoff counter, reconnect timer). The existing `handleSSEDisconnect()` logic is refactored to be per-stream rather than global.
- `file_changes` handler: extend to restart the preview on lockfile changes (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`) in addition to `shipit.yaml` changes. Restart calls go to `previewWorkerUrl`.
- `_previewStateReceived` flag: must track events from the preview SSE stream only (not the session stream), since preview events no longer arrive on the session SSE stream.
- File watcher endpoints (`/files/watch`, `/files/unwatch`, `/files/tree`) continue targeting `workerUrl` (session container) — no change needed, the file watcher stays in the session container.

#### Orchestrator API

- `GET /api/secrets?repoUrl=...` — load secrets from `SecretStore` (database). Not session-scoped — secrets are per-repo.
- `PUT /api/secrets` — save secrets to `SecretStore`, then push to the active preview container(s) for sessions using that repo. The push calls `PUT /secrets` on each preview worker, which replaces tracked secrets in `process.env` and restarts the dev server.
- These routes are always registered (secrets can be configured before a session has a preview container).

#### `SecretStore` (new)

- New class following `DeploymentStore` pattern. SQLite table `secrets` with columns: `repo_url TEXT`, `key TEXT`, `value TEXT`. Stores individual key-value pairs, pushed to preview workers as env vars via `PUT /secrets`.
- `saveSecrets(repoUrl, secrets: Record<string, string>)` — replace all secrets for a repo (delete existing rows, insert new set). This ensures deleted keys don't linger.
- `loadSecrets(repoUrl)` — returns `Record<string, string>` of all secrets for a repo

#### Client

- **Secrets tab** in Settings modal, under the Project section (alongside Deploy). Added to the `SettingsTab` type in `ui-store.ts`.
- Key-value editor for environment variables: each row has a key input, a masked value input (with show/hide toggle), and a delete button. An "Add variable" button appends a new empty row.
- Save button calls `PUT /api/secrets` with the repo URL and the key-value pairs as `Record<string, string>`.
- The tab is available regardless of whether a session is active — users can pre-configure secrets before starting a session.

### SSE architecture

**Dual SSE streams** — the runner connects to both `session:9100/events` and `preview:9100/events`. Keeps containers fully independent. The runner already handles SSE reconnection.

The preview worker's `/events` stream emits: `preview_ready`, `preview_stopped`, `preview_config_missing`, `preview_config_error`, `preview_install_status`, `preview_startup_step`, `preview_log`. The session worker's `/events` stream emits agent, terminal, and file watcher events only — no preview events.

**Independent reconnection** — each SSE stream reconnects independently. If the preview container restarts (e.g., OOM, manual restart) while the session container stays up, only the preview SSE stream drops and reconnects. The runner tracks connection state per stream and does not tear down the session stream when the preview stream disconnects. The health status reflects both streams: if either is down, the runner reports degraded health but continues operating on the healthy stream.

### Lifecycle

1. **Create**: `SessionContainerManager.create()` spawns both containers. The dev server does NOT start yet.

2. **Start preview**: `ContainerSessionRunner.startWorkerResources()` waits for both workers to be healthy (`_workerReady` for session, then poll preview worker `/health`), pushes secrets via `PUT /secrets`, then sends `POST /preview/start` to the preview worker URL. The preview container runs install + dev server with secrets in `process.env`.

3. **File changes**: File watcher in the session container detects changes and emits `file_changes`. The runner restarts the preview on `shipit.yaml` or lockfile changes (see "Claude-triggered installs" below).

4. **Secrets edit**: User edits secrets in the Settings → Secrets tab → `PUT /api/secrets` → orchestrator saves to database + pushes updated env vars to preview worker → preview worker restarts the dev server with new env.

5. **Destroy**: `SessionContainerManager.destroy()` stops both containers. Secrets remain in the database for the next session.

6. **Reconnect**: Runner reconnects both SSE streams. Preview worker replays `preview_ready`/`preview_stopped` state on reconnect (already implemented).

### Dependency install and test execution

All containers in a session share the `/user` workspace volume (see "Shared workspace contract" below), so `node_modules` written by one container is visible to every other. This creates interactions that need explicit handling:

#### Install runs in the preview container

`install-runner.ts` moves to the preview worker (`WORKER_MODE=preview`). The preview container runs `npm install` (or the command from `shipit.yaml`) before starting the dev server. Since `node_modules` lives on the shared volume, the installed packages are also available to Claude in the session container — tests invoked by Claude (`npm test`, `npx vitest`, etc.) can find their dependencies.

#### Timing: Claude may run tests before install finishes

Today, Claude and install share a container and Claude can observe install progress. In the new design, Claude in the session container has no visibility into the preview container's install step. If Claude runs `npm test` while install is still in progress, it will fail with missing modules.

This is acceptable for the initial implementation — the same race exists today (Claude can run tests before install completes), and in practice Claude waits for the dev server to be ready before running tests. If this becomes a problem, a future enhancement could:
- Expose install status on the session SSE stream (the preview worker emits `install_status` events, which the runner already forwards to the client — Claude's terminal could also check this)
- Add a `/install/status` endpoint on the preview worker that the session container can poll

#### Claude-triggered installs (`npm install <pkg>`)

Claude frequently installs packages via the terminal (e.g., `npm install zod`). This runs in the session container and writes to the shared `node_modules`. Tests in the session container work immediately. However, the preview container's dev server won't pick up the new dependency until it restarts — it has already resolved its module graph.

**Fix: restart preview on lockfile changes.** The file watcher (session container) already detects `shipit.yaml` changes and triggers a preview restart ([container-session-runner.ts:729](src/server/orchestrator/container-session-runner.ts#L729)). Extend this to also trigger on lockfile changes:

```typescript
case "file_changes": {
  const paths = (data.paths as string[]) ?? [];
  this.emitMessage({ type: "files_changed", paths } as WsServerMessage);

  const configChanged = paths.some((p) => p === "shipit.yaml" || p.endsWith("/shipit.yaml"));
  const lockfileChanged = paths.some((p) =>
    /\/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(p) ||
    /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(p)
  );

  if (configChanged || lockfileChanged) {
    workerPost(this.previewWorkerUrl, "/preview/restart")
      .catch(/* ... */);
  }
  break;
}
```

The `/preview/restart` endpoint calls `PreviewManager.restart()`, which calls `clearInstallMarker()` before `start()` — so install re-runs with the updated lockfile. Using `/preview/restart` instead of stop+start is important: a bare `/preview/start` would check `isInstallDone()`, find the existing marker, and skip install entirely.

#### Shared workspace contract

All containers in a session — the session container, the built-in preview container, and any user-provided containers (custom Docker image or Docker Compose services) — mount the same `/user` workspace volume. This is the fundamental contract: code, `node_modules`, config files, and build artifacts are visible to every container. Install runs once (in the preview container) and the results are shared.

**Compatibility is the user's responsibility.** When users provide custom preview images (via a single Docker image or `docker-compose.yml`), they must ensure their images are compatible with the shared workspace:
- Same OS architecture (guaranteed if running on the same Docker host)
- Compatible Node.js version if both containers run Node (native `node_modules` binaries like `@rollup/rollup-linux-x64-gnu` are ABI-specific)
- Compatible system libraries (e.g., glibc vs musl — an Alpine-based custom image won't run binaries compiled in the Debian-based session container)

**Default images** — the base `shipit-session-worker` image and the Docker-capable variant built from `Dockerfile.session-worker.docker` (see [doc 061](../061-self-hosting/plan.md)) share the same base, so native binaries are always compatible between the session and built-in preview containers.

### Warm pool

Warm (standby) sessions pre-create the two built-in containers (session + preview). User-provided containers (Docker Compose) are not pre-created — they start when the session is activated and the compose stack is brought up. The preview container sits idle until activated — minimal resource usage since no dev server is running. Warm containers are created without repo secrets (no repo URL yet). When the warm session is activated and assigned a repo URL, the orchestrator loads secrets from the database and pushes them to the preview worker via `PUT /secrets` (the runtime update path). The preview worker sets them in `process.env` before the dev server starts.

### Session clone / fork (worktrees)

When a session is forked (worktree branch), it shares the same repo URL → same secrets. The new session's preview worker receives the same secrets via `PUT /secrets` during startup. No manual re-entry needed.

### In-process SessionRunner (test mode)

The in-process `SessionRunner` (used in integration tests) is not affected by this change. It does not run a preview today (`getPreview()` returns `null`, `buildPreviewStatus()` returns hardcoded "not running"). This remains unchanged — the dual-container topology only applies to `ContainerSessionRunner`. No preview worker mock is needed for `SessionRunner`.

### Docker Compose interaction

When Docker Compose is configured, the user may define their own preview services (custom images, multiple containers). All containers — built-in and user-provided — share the `/user` workspace volume (see "Shared workspace contract" above).

- The built-in preview container still starts (for the default dev server)
- Docker Compose services run in their own containers on the session network
- The preview proxy routes by port — compose services use different ports than the built-in preview
- User-provided containers must be compatible with the shared workspace (OS, Node version, system libraries)
- Docker Compose services do NOT get repo secrets by default — they define their own env in `docker-compose.yml`. If users need shared secrets (e.g., a backend API needing the same database URL as the frontend), they can define the same env vars in their compose `environment` block. Orchestrator-managed injection into compose services is a future enhancement — out of scope for the initial implementation.

### No single-container fallback

The old mode (preview running inside the session container) is fully removed, not gated behind a flag. Reasons:

- **Maintaining two code paths costs more than it saves.** Every lifecycle operation (create, destroy, reconnect, rediscover, cleanup, health check), SSE handling, preview proxy routing, and the secrets UI would all need branching logic. The single-container path would rot as all development focuses on the dual-container path.
- **The resource overhead is negligible.** An idle preview container (Node worker, no dev server) uses ~30 MB. Not worth an entire alternate architecture to save.
- **Security should not be optional.** The whole point is that Claude can't access user secrets. A fallback mode that re-enables that defeats the purpose.
- **Testing surface doubles** if both paths must be covered. One path means one set of integration tests.

If something breaks with the preview container, the fix is to fix it — not to fall back.

### Migration

This is a clean cut-over, not a gradual migration. The old single-container preview code is fully removed — no dead code, no feature flags, no fallback paths.

#### Steps

1. **Gate worker code behind `WORKER_MODE`** — `session-worker.ts` serves both roles (same Docker image). When `WORKER_MODE=session`: register only agent, terminal, file watcher endpoints. When `WORKER_MODE=preview`: register only preview, secrets, health, and events endpoints. `PreviewManager`, `install-runner.ts`, `port-scanner.ts`, `vite-error-plugin.ts`, and `preview-config.ts` are imported conditionally — only when `WORKER_MODE=preview`.
2. **Redirect** all preview commands in `ContainerSessionRunner` from `workerUrl` to `previewWorkerUrl`. Add secrets push before preview start.
3. **Add `PUT /secrets` endpoint** to the preview worker — accepts `Record<string, string>`, does a full replace of tracked secrets in `process.env`, restarts the dev server child process.
4. **Update** the preview proxy to read `previewContainerIp` instead of `containerIp`. The proxy's subdomain parsing, path-based fallback, and WebSocket upgrade logic are unchanged.
5. **Update** integration tests to expect the dual-container topology. Remove any tests that assert preview behavior through the session worker.

The client is unaffected — the preview proxy switch is transparent. The secrets editor is a new UI surface.

#### Old code to remove

The following code exists today for preview-in-session-container and must be deleted or relocated:

| File | What to remove | Replacement |
|------|---------------|-------------|
| `session-worker.ts` | Preview endpoint registrations (`POST /preview/start`, `/preview/stop`, `/preview/restart`, `GET /preview/status`) in `WORKER_MODE=session` path | These endpoints only exist in the `WORKER_MODE=preview` path |
| `session-worker.ts` | `PreviewManager` instantiation, `preview` field, `_previewLogBuffer`, `_lastPreviewExitCode`, `wirePreviewEvents()` in `WORKER_MODE=session` path | Moved to `WORKER_MODE=preview` path only |
| `session-worker.ts` | Preview-related SSE events (`preview_ready`, `preview_stopped`, `preview_config_*`, `preview_install_status`, `preview_startup_step`, `preview_log`) in `WORKER_MODE=session` path | Only emitted by the preview worker's SSE stream |
| `container-session-runner.ts` | `startPreviewOnWorker()`, `stopPreviewOnWorker()`, `restartPreviewOnWorker()` sending to `this.workerUrl`; `startWorkerResources()` and `stopWorkerResources()` sending preview commands to `this.workerUrl` | All replaced by methods sending to `this.previewWorkerUrl`. `startWorkerResources()` also gains the secrets push step. |
| `container-session-runner.ts` | Preview SSE event handling (`preview_ready`, `preview_stopped`, etc.) on the session SSE stream | Handled on the preview SSE stream instead |
| `api-routes-preview.ts` | `POST preview/restart` calls `restartPreviewOnWorker()` which targets `workerUrl` | Same route, but the runner method now targets `previewWorkerUrl`. `GET preview-status` uses in-memory runner state (no worker call). `POST preview-errors` broadcasts a log entry (no worker call). Neither needs URL changes. |
| `preview-proxy.ts` | `sc.containerIp` used as the proxy target IP | Replaced with `sc.previewContainerIp` |

No old code should remain that sends preview commands to the session container or expects preview events on the session SSE stream.

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/container-lifecycle.ts` | `createPreviewContainer()`, `WORKER_MODE` env var |
| `src/server/orchestrator/session-container.ts` | Track preview container, dual create/destroy, `DEFAULT_MEMORY_LIMIT` reduction |
| `src/server/orchestrator/container-discovery.ts` | `rediscoverContainers()` and `cleanupOrphanContainers()` handle preview containers via `shipit-preview-for` label |
| `src/server/orchestrator/preview-proxy.ts` | Use `previewContainerIp` for routing |
| `src/server/session/session-worker.ts` | Gate endpoints behind `WORKER_MODE`: session path (agent/terminal/files) vs preview path (preview/secrets/health) |
| `src/server/orchestrator/container-session-runner.ts` | `previewWorkerUrl`, secrets push before preview start, dual SSE streams, per-stream reconnection, lockfile-triggered preview restart |
| `src/server/orchestrator/secret-store.ts` | New `SecretStore` class — per-repo secrets in SQLite |
| `src/server/orchestrator/api-routes.ts` | Secrets CRUD endpoints (`GET/PUT /api/secrets`) |
| `src/server/orchestrator/api-routes-preview.ts` | All preview routes (`preview-status`, `preview/restart`, `preview-errors`) now target `previewWorkerUrl` |
| `src/client/components/Settings.tsx` | Secrets tab in Settings modal (Project section) |
| `src/client/stores/ui-store.ts` | Add `"secrets"` to `SettingsTab` type |
