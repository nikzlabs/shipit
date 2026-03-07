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
│  /credentials ← creds vol   │   │  /secrets ← secrets vol     │
│                              │   │  (no credentials mount)      │
│  NO /secrets mount           │   │                              │
│  .env.local does not exist   │   │  init: symlink               │
│  in this container           │   │    /secrets/.env.local       │
│                              │   │    → /user/.env.local        │
└──────────────────────────────┘   └──────────────────────────────┘
         ▲                                 ▲
         │         bridge network          │
         └─────────────────────────────────┘
```

### Secrets isolation

The core security property: **Claude cannot read user secrets, but the preview can.**

Users store secrets (API keys for Clerk, Stripe, Supabase, etc.) in `.env.local` files. These must be:
- Readable by the dev server (Vite/Next.js auto-loads them)
- Editable by the user (through the ShipIt UI)
- Persistent across preview restarts
- **Invisible to Claude CLI**

#### How it works

1. **Secrets volume** — a per-session named Docker volume (`shipit-secrets-{sessionId}`), mounted at `/secrets` in the preview container only. The session container does not mount it.

2. **Symlink on init** — the preview container's entrypoint creates symlinks from `/secrets/.env.local` → `/user/.env.local` (and any other `.env*` files). Vite/Next.js finds the file at the expected project root path.

3. **Claude sees nothing** — in the session container, `/user/.env.local` does not exist. Claude CLI cannot read, cat, or grep it. There is no path it can access to reach the secrets volume.

4. **User edits** — the preview worker exposes `GET /secrets` and `PUT /secrets` endpoints. The orchestrator proxies these through a new UI panel (secrets editor). Edits write directly to `/secrets/.env.local` on the secrets volume. The preview worker restarts the dev server when secrets change.

5. **Persistence** — the named volume persists across preview container restarts (and even session container restarts). Secrets survive until the session is destroyed, at which point `cleanupSessionDockerResources()` removes the volume via the `shipit-parent-session` label.

#### Supported secret files

The symlink init handles common dotenv patterns:
- `.env.local` (highest priority, git-ignored by convention)
- `.env.development.local`
- `.env` (if it exists on the secrets volume — user explicitly put it there)

Files that exist on the workspace volume but NOT on the secrets volume are left alone (e.g., `.env.example` committed to the repo stays visible to Claude for reference).

### Resource limits

With the preview in its own container, resource limits can be right-sized:

| Container | Memory | CPU | PIDs | Rationale |
|-----------|--------|-----|------|-----------|
| Session (Claude) | 256 MB | 0.5 | 256 | Claude CLI + node-pty + file watcher. ~60-85 MB typical, 150 MB peak. |
| Preview (dev server) | 512 MB | 0.5 | 256 | Vite/webpack builds are memory-hungry. Keep at 512 MB. |

This saves ~256 MB per session compared to today's single 512 MB container, while giving the preview MORE headroom (it no longer shares with Claude).

### Key properties

1. **Same workspace volume** — both containers mount `/user` from the same source (bind mount or named volume with subpath). File watcher stays in the session container and sees changes from both Claude and the dev server.

2. **Secrets only in preview** — the secrets volume is mounted only in the preview container. No credentials mount in preview, no secrets mount in session.

3. **Independent resource limits** — the preview container gets its own memory/CPU/PID limits. A runaway build can't starve Claude.

4. **Same bridge network** — the preview container joins the shipit bridge network so the orchestrator's preview proxy can reach it by IP.

5. **Preview worker** — a stripped-down session worker that only exposes preview-related endpoints: `/preview/start`, `/preview/stop`, `/preview/restart`, `/secrets`, `/health`, and `/events` (preview SSE events only).

### Changes by component

#### `container-lifecycle.ts`

- New `createPreviewContainer()` function that creates a container with:
  - Same workspace mount as the session container (reuse `buildMounts` but skip credentials)
  - Secrets volume mount at `/secrets` (`shipit-secrets-{sessionId}`)
  - Minimal env (just `WORKSPACE_DIR`, `WORKER_PORT`)
  - Same network as the session container
  - Label: `shipit-preview-for={sessionId}` for cleanup association
  - Entry command includes init step to create `.env*` symlinks

- `buildSessionContainerConfig()` — reduce default memory from 512 MB to 256 MB

#### `session-container.ts` / `SessionContainerManager`

- `SessionContainer` gains optional `previewContainerIp` and `previewContainerId`
- `create()` spawns both containers (session first, then preview, in parallel if possible)
- `destroy()` tears down both containers + secrets volume
- `rediscover()` and `cleanupOrphans()` handle preview containers via the `shipit-preview-for` label
- Health check waits for both workers

#### `preview-proxy.ts`

- When resolving the container IP for preview traffic, use `sc.previewContainerIp` instead of `sc.containerIp`. This is the only routing change — subdomain parsing, path-based fallback, and WebSocket upgrade all stay the same.

#### `session-worker.ts` (preview mode)

- Add `WORKER_MODE=preview` env var
- In preview mode, only register preview endpoints (`/preview/*`, `/secrets`, `/health`, `/events`)
- Skip agent, terminal, and file watcher initialization
- SSE stream only emits preview events
- Init step: create symlinks from `/secrets/.env*` → `/user/.env*`

#### `container-session-runner.ts`

- `startWorkerResources()` sends `POST /preview/start` to the **preview worker URL** instead of the session worker URL
- Preview SSE events come from the preview container's `/events` endpoint
- Connect two SSE streams: one to session worker (agent, terminal, files), one to preview worker (preview events)

#### Orchestrator API

- `GET /api/sessions/:id/secrets` — proxy to preview worker's `GET /secrets`, returns list of secret files and their contents
- `PUT /api/sessions/:id/secrets` — proxy to preview worker's `PUT /secrets`, writes secret files and restarts preview
- Routes only registered when preview container is available

#### Client

- Secrets editor panel (accessible from preview toolbar or settings)
- Key-value editor for `.env.local` entries
- Changes saved via `PUT /api/sessions/:id/secrets`

### SSE architecture

**Dual SSE streams** — the runner connects to both `session:9100/events` and `preview:9100/events`. Keeps containers fully independent. The runner already handles SSE reconnection; adding a second stream is straightforward.

### Lifecycle

1. **Create**: `SessionContainerManager.create()` spawns both containers + secrets volume. The preview container starts, runs init (symlinks), but does NOT start the dev server yet (waits for `POST /preview/start`).

2. **Start preview**: `ContainerSessionRunner.startWorkerResources()` sends `/preview/start` to the preview worker URL. The preview container runs install + dev server.

3. **File changes**: File watcher in the session container detects changes and emits `file_changes`. If `shipit.yaml` changed, the runner sends `/preview/restart` to the preview worker.

4. **Secrets edit**: User edits secrets in the UI → `PUT /api/sessions/:id/secrets` → preview worker writes to `/secrets/.env.local` → preview auto-restarts.

5. **Destroy**: `SessionContainerManager.destroy()` stops both containers. `cleanupSessionDockerResources()` removes the secrets volume via the `shipit-parent-session` label.

6. **Reconnect**: Runner reconnects both SSE streams. Preview worker replays `preview_ready`/`preview_stopped` state on reconnect (already implemented).

### Warm pool

Warm (standby) sessions pre-create both containers + secrets volume. The preview container sits idle until activated — minimal resource usage since no dev server is running.

### Docker Compose interaction

When Docker Compose is configured, the user may define their own preview services. In that case:
- The built-in preview container still starts (for the default dev server)
- Docker Compose services run in their own containers on the session network
- The preview proxy routes by port — compose services use different ports than the built-in preview
- Docker Compose services do NOT get the secrets volume (they define their own env in docker-compose.yml)

### No single-container fallback

The old mode (preview running inside the session container) is fully removed, not gated behind a flag. Reasons:

- **Maintaining two code paths costs more than it saves.** Every lifecycle operation (create, destroy, reconnect, rediscover, cleanup, health check), SSE handling, preview proxy routing, and the secrets UI would all need branching logic. The single-container path would rot as all development focuses on the dual-container path.
- **The resource overhead is negligible.** An idle preview container (Node worker, no dev server) uses ~30 MB. Not worth an entire alternate architecture to save.
- **Security should not be optional.** The whole point is that Claude can't read `.env.local`. A fallback mode that re-enables that defeats the purpose.
- **Testing surface doubles** if both paths must be covered. One path means one set of integration tests.

If something breaks with the preview container, the fix is to fix it — not to fall back.

### Migration

This is a clean cut-over, not a gradual migration:

1. **Remove** preview-related code from the session worker (preview endpoints, preview manager initialization, install runner, port scanner imports). The session worker becomes agent + terminal + file watcher only.
2. **Remove** preview start/stop/restart forwarding from `ContainerSessionRunner` to the session worker URL. All preview commands go to the preview worker URL.
3. **Remove** `POST /preview/start` and `POST /preview/stop` from the session worker's endpoint registration.
4. **Move** `PreviewManager`, `install-runner.ts`, `port-scanner.ts`, `vite-error-plugin.ts`, and `preview-config.ts` — these are only imported by the preview worker now. No code changes needed to the modules themselves; they just run in a different container.
5. **Update** the preview proxy to read `previewContainerIp` instead of `containerIp`. The proxy's subdomain parsing, path-based fallback, and WebSocket upgrade logic are unchanged.
6. **Update** integration tests to expect the dual-container topology. Remove any tests that assert preview behavior through the session worker.

The client is unaffected — the preview proxy switch is transparent. The secrets editor is a new UI surface.

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/container-lifecycle.ts` | `createPreviewContainer()`, secrets volume, reduced session memory |
| `src/server/orchestrator/session-container.ts` | Track preview container, dual create/destroy, secrets volume cleanup |
| `src/server/orchestrator/preview-proxy.ts` | Use `previewContainerIp` for routing |
| `src/server/session/session-worker.ts` | Remove preview endpoints and PreviewManager init, add `WORKER_MODE=preview` path |
| `src/server/orchestrator/container-session-runner.ts` | Dual SSE streams, preview URL routing, remove session-worker preview forwarding |
| `src/server/orchestrator/api-routes.ts` | Secrets proxy endpoints |
| `src/client/components/` | Secrets editor panel |
