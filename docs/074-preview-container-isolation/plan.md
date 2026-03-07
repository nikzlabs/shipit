---
status: planned
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

Every session gets two containers on the same bridge network:

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  Session Container           │   │  Preview Container           │
│  (shipit-session-worker)     │   │  (shipit-preview-worker)     │
│                              │   │                              │
│  • Claude CLI                │   │  • Dev server (Vite, etc.)   │
│  • File watcher              │   │  • Install runner            │
│  • Terminal PTY              │   │                              │
│  • Session worker (:9100)    │   │  • Preview worker (:9100)    │
│                              │   │                              │
│  /user    ← workspace vol    │   │  /user    ← workspace vol   │
│  /credentials ← creds vol   │   │  (no credentials mount)      │
│                              │   │                              │
│  env: no repo secrets        │   │  env: repo secrets injected  │
│                              │   │    via config.env at create  │
└──────────────────────────────┘   └──────────────────────────────┘
         ▲                                 ▲
         │         bridge network          │
         └─────────────────────────────────┘
```

### Secrets isolation

The core security property: **Claude cannot read user secrets, but the preview can.**

Users configure secrets (API keys for Clerk, Stripe, Supabase, etc.) through the ShipIt Secrets tab. These must be:
- Available to the dev server as environment variables
- Editable by the user (through the ShipIt UI)
- Persistent across sessions and preview restarts
- **Invisible to Claude CLI**

#### How it works

1. **Orchestrator-managed secrets (per-repo)** — secrets are stored in the orchestrator's SQLite database, keyed by repo URL (from `SessionInfo.remoteUrl`). This follows the same pattern as `DeploymentStore`. A new `SecretStore` class provides `saveSecrets(repoUrl, secrets)` and `loadSecrets(repoUrl)`. Secrets persist across sessions for the same repo — users enter their Clerk/Stripe keys once, and every session for that repo gets them.

2. **Injection at creation time** — when creating a preview container, the orchestrator loads the repo's secrets from the database and passes them as container environment variables via `config.env` in `container-lifecycle.ts`. The `buildContainerConfig()` call in `session-container.ts` merges the repo's secrets into `env`, and `buildEnv()` spreads them into the Docker container's `Env` array. The dev server reads env vars natively (Vite, Next.js, etc. all support `process.env`).

3. **Runtime updates via preview worker** — Docker container env vars are immutable after creation, so runtime secret changes use a different path. The preview worker exposes `PUT /secrets`, which accepts a `Record<string, string>`. On receipt, it merges the key-value pairs into `process.env` of the worker process, then restarts the dev server child process. The restarted dev server inherits the updated `process.env`. This is the same mechanism used for warm pool activation (see below).

4. **Session container gets no secrets** — only the preview container receives repo secrets (at creation via `config.env`, at runtime via `PUT /secrets`). The session container (where Claude runs) is created without them. Claude cannot access them via `process.env`, `printenv`, or any filesystem path.

5. **User edits** — the user manages secrets through the **Secrets tab** in the Settings modal (under the Project section, alongside Deploy). The orchestrator handles reads and writes:
   - `GET /api/secrets?repoUrl=...` — load secrets from the database
   - `PUT /api/secrets` — save secrets to the database, then push them to the active preview container(s) via `PUT /secrets` on each preview worker
   - The preview worker merges the new values into `process.env` and restarts the dev server

6. **Persistence** — secrets live in the orchestrator's SQLite database, keyed by repo URL. They survive across sessions, container restarts, and workspace resets. On each container creation, secrets are loaded fresh from the database into `config.env`. On runtime edits, they are pushed to the preview worker via HTTP.

#### `.env.local` file handling

Since secrets are injected via container env vars (not filesystem), `.env.local` files in the workspace are handled simply:

- If a `.env.local` exists in the repo (committed or scaffolded by Claude), it stays as-is in the workspace. Claude can read it, but it only contains non-sensitive defaults or placeholders.
- The preview container's env vars take precedence over `.env.local` values (standard env var priority: `process.env` > dotenv files).
- Users put real secrets (Clerk keys, Stripe keys, database URLs) in the Secrets tab, not in `.env.local`.

### Resource limits

With the preview in its own container, resource limits can be right-sized:

| Container | Memory | CPU | PIDs | Rationale |
|-----------|--------|-----|------|-----------|
| Session (Claude) | 256 MB | 0.5 | 256 | Claude CLI + node-pty + file watcher. ~60-85 MB typical, 150 MB peak. |
| Preview (dev server) | 512 MB | 0.5 | 256 | Vite/webpack builds are memory-hungry. Keep at 512 MB. |

This saves ~256 MB per session compared to today's single 512 MB container, while giving the preview MORE headroom (it no longer shares with Claude).

### Key properties

1. **Same workspace volume** — both containers mount `/user` from the same source (bind mount or named volume with subpath). File watcher stays in the session container and sees changes from both Claude and the dev server.

2. **Secrets only in preview** — repo secrets are passed as container env vars only to the preview container via `config.env`. The session container (Claude) never receives them. No credentials mount in preview, no secrets in session.

3. **Independent resource limits** — the preview container gets its own memory/CPU/PID limits. A runaway build can't starve Claude.

4. **Same bridge network** — the preview container joins the shipit bridge network so the orchestrator's preview proxy can reach it by IP.

5. **Preview worker** — a stripped-down session worker that only exposes preview-related endpoints: `/preview/start`, `/preview/stop`, `/preview/restart`, `/secrets`, `/health`, and `/events` (preview SSE events only).

### Changes by component

#### `container-lifecycle.ts`

- New `createPreviewContainer()` function that creates a container with:
  - Same workspace mount as the session container (reuse `buildMounts` but skip credentials)
  - Repo secrets injected via `config.env` (loaded from `SecretStore` at creation time)
  - Env via `buildEnv()` with `WORKER_MODE=preview` added (plus `WORKSPACE_DIR`, `WORKER_PORT`)
  - Same network as the session container
  - Labels: `shipit-preview-for={sessionId}` for cleanup association, plus `shipit-parent-session={sessionId}` so `cleanupSessionDockerResources()` catches it

- `buildEnv()` — add `WORKER_MODE` to the env vars passed to Docker. Session containers get `WORKER_MODE=session`, preview containers get `WORKER_MODE=preview`.

- `buildContainerConfig()` — reduce default memory from 512 MB to 256 MB for session containers

#### `session-container.ts` / `SessionContainerManager`

- `SessionContainer` gains `previewContainerIp`, `previewContainerId`, and `previewWorkerUrl` (constructed as `http://{previewContainerIp}:{workerPort}` after inspecting the preview container's bridge network IP, same pattern as the session container)
- `create()` spawns both containers (session first, then preview, in parallel if possible)
- `destroy()` tears down both containers
- `rediscover()` and `cleanupOrphans()` (delegated to `container-discovery.ts`) handle preview containers via the `shipit-preview-for` label
- Health check waits for both workers

#### `preview-proxy.ts`

- When resolving the container IP for preview traffic, use `sc.previewContainerIp` instead of `sc.containerIp`. This is the only routing change — subdomain parsing, path-based fallback, and WebSocket upgrade all stay the same.

#### `session-worker.ts` (preview mode)

- Add new `WORKER_MODE` env var (does not exist today). Values: `session` (default, current behavior) or `preview`
- In preview mode, only register preview endpoints (`/preview/*`, `/secrets`, `/health`, `/events`)
- Skip agent, terminal, and file watcher initialization
- SSE stream only emits preview events
- No filesystem-based secrets init needed — secrets arrive as container env vars via `config.env`

#### `container-session-runner.ts`

- Add `previewWorkerUrl` field (today only `workerUrl` exists, pointing at the session container). All preview-related POSTs (`/preview/start`, `/preview/stop`, `/preview/restart`) go to `previewWorkerUrl` instead of `workerUrl`.
- `startWorkerResources()` sends `POST /preview/start` to `previewWorkerUrl`
- Preview SSE events come from the preview container's `/events` endpoint
- Connect two SSE streams: one to session worker (agent, terminal, files), one to preview worker (preview events). Each stream has independent reconnection state (backoff counter, reconnect timer). The existing `handleSSEDisconnect()` logic is refactored to be per-stream rather than global.

#### Orchestrator API

- `GET /api/secrets?repoUrl=...` — load secrets from `SecretStore` (database). Not session-scoped — secrets are per-repo.
- `PUT /api/secrets` — save secrets to `SecretStore`, then push to the active preview container(s) for sessions using that repo. The push calls `PUT /secrets` on each preview worker, which merges the values into `process.env` and restarts the dev server.
- These routes are always registered (secrets can be configured before a session has a preview container).

#### `SecretStore` (new)

- New class following `DeploymentStore` pattern. SQLite table `secrets` with columns: `repo_url TEXT`, `key TEXT`, `value TEXT`. Stores individual key-value pairs rather than raw file contents, since secrets are injected as env vars via `config.env`.
- `saveSecrets(repoUrl, secrets: Record<string, string>)` — upsert all key-value pairs for a repo
- `loadSecrets(repoUrl)` — returns `Record<string, string>` of all secrets for a repo
- `deleteSecret(repoUrl, key)` — remove a specific secret

#### Client

- **Secrets tab** in Settings modal, under the Project section (alongside Deploy). Added to the `SettingsTab` type in `ui-store.ts`.
- Key-value editor for `.env.local` entries: each row has a key input, a masked value input (with show/hide toggle), and a delete button. An "Add variable" button appends a new empty row.
- Save button calls `PUT /api/secrets` with the repo URL and the key-value pairs as `Record<string, string>`.
- The tab is available regardless of whether a session is active — users can pre-configure secrets before starting a session.

### SSE architecture

**Dual SSE streams** — the runner connects to both `session:9100/events` and `preview:9100/events`. Keeps containers fully independent. The runner already handles SSE reconnection.

**Independent reconnection** — each SSE stream reconnects independently. If the preview container restarts (e.g., OOM, manual restart) while the session container stays up, only the preview SSE stream drops and reconnects. The runner tracks connection state per stream and does not tear down the session stream when the preview stream disconnects. The health status reflects both streams: if either is down, the runner reports degraded health but continues operating on the healthy stream.

### Lifecycle

1. **Create**: `SessionContainerManager.create()` spawns both containers. The preview container starts with repo secrets injected as env vars via `config.env`. The dev server does NOT start yet (waits for `POST /preview/start`).

2. **Start preview**: `ContainerSessionRunner.startWorkerResources()` sends `/preview/start` to the preview worker URL. The preview container runs install + dev server.

3. **File changes**: File watcher in the session container detects changes and emits `file_changes`. If `shipit.yaml` changed, the runner sends `/preview/restart` to the preview worker.

4. **Secrets edit**: User edits secrets in the Settings → Secrets tab → `PUT /api/secrets` → orchestrator saves to database + pushes updated env vars to preview worker → preview worker restarts the dev server with new env.

5. **Destroy**: `SessionContainerManager.destroy()` stops both containers. Secrets remain in the database for the next session.

6. **Reconnect**: Runner reconnects both SSE streams. Preview worker replays `preview_ready`/`preview_stopped` state on reconnect (already implemented).

### Warm pool

Warm (standby) sessions pre-create both containers. The preview container sits idle until activated — minimal resource usage since no dev server is running. Warm containers are created without repo secrets (no repo URL yet). When the warm session is activated and assigned a repo URL, the orchestrator loads secrets from the database and pushes them to the preview worker via `PUT /secrets` (the runtime update path). The preview worker merges them into `process.env` before the dev server starts.

### Session clone / fork (worktrees)

When a session is forked (worktree branch), it shares the same repo URL → same secrets. The new session's preview container gets the same secrets from the database, injected as env vars at container start. No manual re-entry needed.

### In-process SessionRunner (test mode)

The in-process `SessionRunner` (used in integration tests) is not affected by this change. It does not run a preview today (`getPreview()` returns `null`, `buildPreviewStatus()` returns hardcoded "not running"). This remains unchanged — the dual-container topology only applies to `ContainerSessionRunner`. No preview worker mock is needed for `SessionRunner`.

### Docker Compose interaction

When Docker Compose is configured, the user may define their own preview services. In that case:
- The built-in preview container still starts (for the default dev server)
- Docker Compose services run in their own containers on the session network
- The preview proxy routes by port — compose services use different ports than the built-in preview
- Docker Compose services do NOT get repo secrets by default — they define their own env in `docker-compose.yml`. If users need shared secrets (e.g., a backend API needing the same database URL as the frontend), they can define the same env vars in their compose `environment` block. Orchestrator-managed injection into compose services is a future enhancement — out of scope for the initial implementation.

### No single-container fallback

The old mode (preview running inside the session container) is fully removed, not gated behind a flag. Reasons:

- **Maintaining two code paths costs more than it saves.** Every lifecycle operation (create, destroy, reconnect, rediscover, cleanup, health check), SSE handling, preview proxy routing, and the secrets UI would all need branching logic. The single-container path would rot as all development focuses on the dual-container path.
- **The resource overhead is negligible.** An idle preview container (Node worker, no dev server) uses ~30 MB. Not worth an entire alternate architecture to save.
- **Security should not be optional.** The whole point is that Claude can't access user secrets. A fallback mode that re-enables that defeats the purpose.
- **Testing surface doubles** if both paths must be covered. One path means one set of integration tests.

If something breaks with the preview container, the fix is to fix it — not to fall back.

### Migration

This is a clean cut-over, not a gradual migration:

1. **Gate preview code behind `WORKER_MODE`** — `session-worker.ts` serves both roles (same Docker image). When `WORKER_MODE=session`: register only agent, terminal, file watcher endpoints. When `WORKER_MODE=preview`: register only preview, secrets, health, and events endpoints. `PreviewManager`, `install-runner.ts`, `port-scanner.ts`, `vite-error-plugin.ts`, and `preview-config.ts` are imported conditionally — only when `WORKER_MODE=preview`.
2. **Remove** preview start/stop/restart forwarding from `ContainerSessionRunner` to the session worker URL. All preview commands go to the preview worker URL.
3. **Add `PUT /secrets` endpoint** to the preview worker — accepts `Record<string, string>`, merges into `process.env`, restarts the dev server child process.
5. **Update** the preview proxy to read `previewContainerIp` instead of `containerIp`. The proxy's subdomain parsing, path-based fallback, and WebSocket upgrade logic are unchanged.
6. **Update** integration tests to expect the dual-container topology. Remove any tests that assert preview behavior through the session worker.

The client is unaffected — the preview proxy switch is transparent. The secrets editor is a new UI surface.

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/container-lifecycle.ts` | `createPreviewContainer()`, secrets via `config.env`, reduced session memory |
| `src/server/orchestrator/session-container.ts` | Track preview container, dual create/destroy, `DEFAULT_MEMORY_LIMIT` reduction |
| `src/server/orchestrator/container-discovery.ts` | `rediscoverContainers()` and `cleanupOrphanContainers()` handle preview containers via `shipit-preview-for` label |
| `src/server/orchestrator/preview-proxy.ts` | Use `previewContainerIp` for routing |
| `src/server/session/session-worker.ts` | Gate endpoints behind `WORKER_MODE`: session path (agent/terminal/files) vs preview path (preview/secrets/health) |
| `src/server/orchestrator/container-session-runner.ts` | `previewWorkerUrl`, dual SSE streams, per-stream reconnection, preview URL routing |
| `src/server/orchestrator/secret-store.ts` | New `SecretStore` class — per-repo secrets in SQLite |
| `src/server/orchestrator/api-routes.ts` | Secrets CRUD endpoints (`GET/PUT /api/secrets`) |
| `src/client/components/Settings.tsx` | Secrets tab in Settings modal (Project section) |
| `src/client/stores/ui-store.ts` | Add `"secrets"` to `SettingsTab` type |
