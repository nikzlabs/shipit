# 048 — Multi-Port Preview Support Checklist

## Phase 1 — Reverse proxy (core)

- [x] Create `src/server/preview-proxy.ts` with HTTP proxy (path stripping, body forwarding, error handling)
- [x] Add WebSocket upgrade proxy in `preview-proxy.ts` (bidirectional pipe, header forwarding)
- [x] Wire `isPortAllowed()` in `src/server/index.ts` checking managed ports, detected ports, and per-runner state
- [x] Register HTTP proxy routes (`/preview/:port/*` and bare `/preview/:port` redirect)
- [x] Register WS proxy via `onReady` hook (after `@fastify/websocket` installs its upgrade listener)
- [x] Update `buildPreviewStatus()` in `session-runner.ts` — URLs now use `/preview/{port}/`
- [x] Update global `getPreviewStatus()` in `index.ts` — same URL format change
- [x] Update `PreviewFrame.tsx` — iframe src and polling URL use `/preview/{port}/`
- [x] Add HMR `clientPort` config to Vite wrapper in `preview-manager.ts`
- [x] Add `setRunning()` helper to `StubPreviewManager` in test-helpers
- [x] Unit tests: `preview-proxy.test.ts` (path stripping, port validation, proxy forwarding, 502, redirect)
- [x] Integration tests: `preview-proxy.test.ts` (HTTP proxy via buildApp, WS bidirectional relay, port allowlist)
- [x] Update `PreviewFrame.test.tsx` — all URL assertions use `/preview/{port}/` format
- [x] Update `port-auto-detection.test.ts` — URL assertion updated
- [x] Update `src/server/types/ws-server-messages.ts` — document that `url` field now uses proxy path format
- [ ] Verify end-to-end in Docker (manual: start a user app on port 8080, confirm iframe loads via proxy)

## Phase 2 — Enhancements (future, optional)

- [ ] Named port labels in `shipit.yaml` (`port: 8080, label: "API"`)
- [ ] Tabbed multi-preview UI (multiple iframes side by side)
- [ ] Broader port detection via `/proc/net/tcp` instead of hardcoded list
