# Container recovery — checklist

## A. Diagnosis (health visibility)

- [x] Add `_lastSseEventAt` to `ContainerSessionRunner`, update on every SSE event, expose as `lastSseEventAt` getter on the interface.
- [x] Add optional `timeoutMs` parameter to `workerGet` / `workerPost` in `worker-http.ts`.
- [x] Create `services/health.ts` with `getContainerHealth(deps, sessionId): Promise<ContainerHealth>` aggregating the four signals.
- [x] Create `api-routes-container.ts` with `GET /api/sessions/:id/container/health`.
- [x] Wire the new route module into `api-routes.ts`.
- [x] Build `SessionHealthStrip.tsx` — polls health every 10s, renders status dot + signal labels.
- [x] Thread `sessionId` into `TerminalPanel` and embed the strip above tab content.

## B. Recovery actions

- [x] Add `container_restarting` server WS message type.
- [x] Create `services/recovery.ts` with `killAgent(deps, sessionId)` and `restartContainer(deps, sessionId)`.
- [x] Add `POST /api/sessions/:id/agent/kill` route.
- [x] Add `POST /api/sessions/:id/container/restart` route.
- [x] Add **Kill agent** button in `SessionHealthStrip`, enabled when `agentRunning === true`.
- [x] Add **Restart container** button in `SessionHealthStrip`. On 200, close + reconnect the per-session WS so the factory rebuilds the container.
- [x] Show a "Restarting container…" overlay on receipt of `container_restarting` until the new container is ready.

## C. Auto-watchdog *(deferred — sequence after A+B have shipped)*

- [ ] Periodic `/health` probe loop on `ContainerSessionRunner` (e.g., every 30s) that runs only while a viewer is attached and the container is `running`.
- [ ] Threshold + emit `container_unresponsive` after 3 consecutive failures.
- [ ] Client banner that surfaces the unresponsive state and reuses the Restart action from B.
- [ ] Telemetry / logging for false-positive rate before promoting the banner from "advisory" to "loud."

## Quality

- [x] Lint passes (`npm run lint`).
- [x] Typecheck passes (`npm run typecheck`).
- [x] `npm run test:dev` passes (server + client tests for new/touched files).
- [x] Full integration suite passes (62/63 files; the one failure — `git-identity.test.ts`'s `git_identity_required` case — reproduces on `main` and is unrelated).
- [ ] Add an integration test that exercises the restart route end-to-end (kill agent → destroy → recreate via factory). *(deferred — will add with C; manual verification documented in plan.md.)*

## Docs

- [x] `plan.md` written.
- [x] `checklist.md` written.
- [ ] Update `plan.md` "Key files" section if the implementation diverges.
