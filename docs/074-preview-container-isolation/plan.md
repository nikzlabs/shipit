---
status: planned
---

# Preview Container Isolation

Run the preview (dev server) in a dedicated container, separate from the Claude session container. Today the preview process runs as a sibling to Claude CLI inside the same container — sharing memory, env vars, filesystem access, and PID namespace. A separate preview container provides resource isolation, env separation, and blast-radius containment.

## Motivation

When Claude and the preview share a container:

- **Resource contention** — a Vite/webpack build can exhaust the 512 MB memory limit, starving Claude
- **Env var leakage** — third-party npm packages in the dev server can read session credentials
- **Process introspection** — `/proc` lets the dev server inspect Claude's memory and args
- **Port hijacking** — a malicious package could bind to port 9100 (worker IPC) before the session worker
- **Blast radius** — a crashing dev server can OOM-kill the entire container, taking Claude down

A separate preview container eliminates all of these by construction.

## Design

### Container topology

Every session gets two containers on the same bridge network:

```
┌─────────────────────────────┐   ┌──────────────────────────────┐
│  Session Container          │   │  Preview Container           │
│  (shipit-session-worker)    │   │  (shipit-preview-worker)     │
│                             │   │                              │
│  • Claude CLI               │   │  • Dev server (Vite, etc.)   │
│  • File watcher             │   │  • Install runner            │
│  • Terminal PTY             │   │                              │
│  • Session worker (:9100)   │   │  • Preview worker (:9100)    │
│                             │   │                              │
│  /user  ← workspace vol     │   │  /user  ← same workspace vol│
│  /credentials ← creds vol  │   │  (no credentials mount)      │
└─────────────────────────────┘   └──────────────────────────────┘
         ▲                                 ▲
         │         bridge network          │
         └─────────────────────────────────┘
```

### Key properties

1. **Same workspace volume** — both containers mount `/user` from the same source (bind mount or named volume with subpath). File watcher stays in the session container and sees changes from both Claude and the dev server.

2. **No credentials in preview** — the preview container does NOT mount `/credentials`. Env vars like `SESSION_ID`, API keys, etc. are not passed. Only `WORKSPACE_DIR` and `WORKER_PORT`.

3. **Independent resource limits** — the preview container gets its own memory/CPU/PID limits. A runaway build can't starve Claude. Default: 512 MB / 0.5 CPU (same as session), but tunable independently.

4. **Same bridge network** — the preview container joins the shipit bridge network so the orchestrator's preview proxy can reach it by IP. The session container can also reach it (for port scanning if needed).

5. **Preview worker** — a stripped-down version of the session worker that only exposes preview-related endpoints: `/preview/start`, `/preview/stop`, `/preview/restart`, `/health`, and `/events` (preview SSE events only).

### Changes by component

#### `container-lifecycle.ts`

- New `createPreviewContainer()` function that creates a container with:
  - Same workspace mount as the session container (reuse `buildMounts` but skip credentials)
  - Minimal env (just `WORKSPACE_DIR`, `WORKER_PORT`)
  - Same network as the session container
  - Label: `shipit-preview-for={sessionId}` for cleanup association
  - Separate resource limits (configurable)

#### `session-container.ts` / `SessionContainerManager`

- `SessionContainer` gains an optional `previewContainerIp` and `previewContainerId`
- `create()` spawns both containers (session first, then preview, in parallel if possible)
- `destroy()` tears down both containers
- `rediscover()` and `cleanupOrphans()` handle preview containers via the `shipit-preview-for` label
- Health check waits for both workers

#### `preview-proxy.ts`

- When resolving the container IP for preview traffic, use `sc.previewContainerIp` instead of `sc.containerIp`. This is the only routing change — subdomain parsing, path-based fallback, and WebSocket upgrade all stay the same.

#### `session-worker.ts` (preview mode)

- Add a `--preview-only` flag or `WORKER_MODE=preview` env var
- In preview mode, only register preview endpoints (`/preview/*`, `/health`, `/events`)
- Skip agent, terminal, and file watcher initialization
- SSE stream only emits preview events

#### `container-session-runner.ts`

- `startWorkerResources()` sends `POST /preview/start` to the **preview worker URL** instead of the session worker URL
- Preview SSE events come from the preview container's `/events` endpoint
- Connect two SSE streams: one to session worker (agent, terminal, files), one to preview worker (preview events)
- Or: session worker proxies preview events from the preview container (simpler, single SSE stream)

#### `preview-manager.ts`

- No changes needed — it already runs inside whatever container spawns it. It just moves from the session container image to the preview container image.

### SSE architecture choice

**Option A: Dual SSE streams** — the runner connects to both `session:9100/events` and `preview:9100/events`. Cleaner separation but adds complexity to reconnection logic.

**Option B: Session worker proxies preview SSE** — the session worker connects to the preview worker's SSE and re-emits events on its own stream. Single stream for the runner, but couples the containers.

**Recommendation: Option A** — keeps containers fully independent. The runner already handles SSE reconnection; adding a second stream is straightforward.

### Lifecycle

1. **Create**: `SessionContainerManager.create()` spawns both containers. The preview container starts but does NOT run the dev server yet (waits for `POST /preview/start`).

2. **Start preview**: `ContainerSessionRunner.startWorkerResources()` sends `/preview/start` to the preview worker URL. The preview container runs install + dev server.

3. **File changes**: File watcher in the session container detects changes and emits `file_changes`. If `shipit.yaml` changed, the runner sends `/preview/restart` to the preview worker.

4. **Destroy**: `SessionContainerManager.destroy()` stops both containers. `cleanupSessionDockerResources()` catches any stragglers via the `shipit-preview-for` label.

5. **Reconnect**: Runner reconnects both SSE streams. Preview worker replays `preview_ready`/`preview_stopped` state on reconnect (already implemented).

### Warm pool

Warm (standby) sessions pre-create both containers. The preview container sits idle until activated — minimal resource usage since no dev server is running.

### Docker Compose interaction

When Docker Compose is configured, the user may define their own preview services. In that case:
- The built-in preview container still starts (for the default dev server)
- Docker Compose services run in their own containers on the session network
- The preview proxy routes by port — compose services use different ports than the built-in preview

### Migration

This is a non-breaking change. The preview proxy already routes by container IP:port — switching from session container IP to preview container IP is transparent to the client. No client changes needed.

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/container-lifecycle.ts` | `createPreviewContainer()`, skip credentials mount |
| `src/server/orchestrator/session-container.ts` | Track preview container, dual create/destroy |
| `src/server/orchestrator/preview-proxy.ts` | Use `previewContainerIp` for routing |
| `src/server/session/session-worker.ts` | `WORKER_MODE=preview` flag, subset of endpoints |
| `src/server/orchestrator/container-session-runner.ts` | Dual SSE streams, preview URL routing |
| `src/server/orchestrator/container-lifecycle.ts` | Cleanup preview containers by label |
