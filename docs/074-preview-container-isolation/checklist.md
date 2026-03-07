# Preview Container Isolation — Checklist

## Container infrastructure

- [ ] `container-lifecycle.ts`: Add `createPreviewContainer()` — workspace mount (no credentials), `WORKER_MODE=preview` env, same network, `shipit-preview-for` + `shipit-parent-session` labels
- [ ] `container-lifecycle.ts`: Add `WORKER_MODE` to `buildEnv()` — `session` for session containers, `preview` for preview containers
- [ ] `session-container.ts`: Add `previewContainerIp`, `previewContainerId`, `previewWorkerUrl` to `SessionContainer` interface
- [ ] `session-container.ts`: Reduce `DEFAULT_MEMORY_LIMIT` from 512 MB to 256 MB (session container only); preview container gets 512 MB
- [ ] `session-container.ts`: `create()` spawns both containers, inspects both for bridge IPs
- [ ] `session-container.ts`: `destroy()` tears down both containers
- [ ] `container-discovery.ts`: `rediscoverContainers()` discovers preview containers via `shipit-preview-for` label, populates preview fields on `SessionContainer`
- [ ] `container-discovery.ts`: `cleanupOrphanContainers()` handles preview containers

## Session worker (WORKER_MODE gating)

- [ ] `session-worker.ts`: Read `WORKER_MODE` env var (default: `session`)
- [ ] `session-worker.ts`: In `session` mode — register only agent, terminal, file watcher, health, events endpoints. No preview endpoints, no `PreviewManager`.
- [ ] `session-worker.ts`: In `preview` mode — register only `/preview/*`, `PUT /secrets`, `/health`, `/events`. No agent, terminal, or file watcher.
- [ ] `session-worker.ts`: `PUT /secrets` endpoint — accepts `Record<string, string>`, full-replace tracked keys in `process.env`, restart dev server if running
- [ ] `session-worker.ts`: Preview SSE events (`preview_ready`, `preview_stopped`, `preview_config_*`, `preview_install_status`, `preview_log`) only emitted in `preview` mode

## Container session runner

- [ ] `container-session-runner.ts`: Add `previewWorkerUrl` field (from `SessionContainer.previewWorkerUrl`)
- [ ] `container-session-runner.ts`: `startWorkerResources()` — wait for preview worker `/health`, push secrets via `PUT /secrets`, then `POST /preview/start` to `previewWorkerUrl`
- [ ] `container-session-runner.ts`: `stopWorkerResources()` — send `POST /preview/stop` to `previewWorkerUrl`
- [ ] `container-session-runner.ts`: `startPreviewOnWorker()`, `stopPreviewOnWorker()`, `restartPreviewOnWorker()` — all target `previewWorkerUrl`
- [ ] `container-session-runner.ts`: Dual SSE streams — session worker (agent, terminal, files) + preview worker (preview events)
- [ ] `container-session-runner.ts`: Per-stream reconnection state (independent backoff counters, reconnect timers)
- [ ] `container-session-runner.ts`: Preview SSE event handling (`preview_ready`, `preview_stopped`, etc.) moved to preview stream

## Preview proxy

- [ ] `preview-proxy.ts`: Route preview traffic to `sc.previewContainerIp` instead of `sc.containerIp`

## Secrets infrastructure

- [ ] `secret-store.ts`: New `SecretStore` class — SQLite table `secrets` (`repo_url`, `key`, `value`)
- [ ] `secret-store.ts`: `saveSecrets(repoUrl, secrets)` — delete-then-insert (full replace)
- [ ] `secret-store.ts`: `loadSecrets(repoUrl)` — returns `Record<string, string>`
- [ ] `api-routes.ts`: `GET /api/secrets?repoUrl=...` — load from `SecretStore`
- [ ] `api-routes.ts`: `PUT /api/secrets` — save to `SecretStore`, push to active preview containers via `PUT /secrets`

## Orchestrator API (preview routes)

- [ ] `api-routes-preview.ts`: `GET preview-status`, `POST preview/restart`, `POST preview-errors` — all target `previewWorkerUrl` via runner methods

## Client

- [ ] `ui-store.ts`: Add `"secrets"` to `SettingsTab` type
- [ ] `Settings.tsx`: Secrets tab in Project section — key-value editor, masked values, add/delete rows, save button

## Old code removal verification

- [ ] No preview endpoints registered in `WORKER_MODE=session` path
- [ ] No `PreviewManager` instantiation in `WORKER_MODE=session` path
- [ ] No preview commands sent to `this.workerUrl` (all go to `this.previewWorkerUrl`)
- [ ] No preview SSE events expected on the session SSE stream
- [ ] `preview-proxy.ts` does not reference `sc.containerIp` for preview routing

## Tests

- [ ] Integration tests for `SecretStore` (save, load, replace-all, empty repo)
- [ ] Integration tests for secrets API routes (`GET /api/secrets`, `PUT /api/secrets`)
- [ ] Integration tests for `PUT /secrets` worker endpoint (full replace, dev server restart)
- [ ] Integration tests for dual-container lifecycle (create, destroy, rediscover)
- [ ] Verify no existing tests assert preview behavior through the session worker
- [ ] Client component test for Secrets tab (render, add row, delete row, save)
