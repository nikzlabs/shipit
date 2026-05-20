# Live steering — checklist

Tracks remaining work for `docs/140-live-steering`. See `plan.md` for design.

## Spike / research (done)

- [x] Verify `claude --input-format stream-json` mid-turn steering (same session, no restart)
- [x] Verify Claude interrupt via `control_request {subtype:"interrupt"}` (turn ends, session stays alive)
- [x] Verify Claude `--resume <session_id>` works in streaming-input mode (fresh process recovery)
- [x] Verify Claude mid-session permission-mode change via `control_request {subtype:"set_permission_mode"}`
- [x] Confirm Codex steering primitive (`turn/steer`) — already implemented in `codex-adapter.ts` `writeStdin`
- [x] Research Codex `turn/interrupt` semantics (graceful, `turn/completed status:"interrupted"`)

## Phase 1 — capability + setting (no behavior change)

- [ ] Add `supportsSteering: boolean` to `AgentCapabilities` (`agent-types.ts`)
- [ ] Set `supportsSteering: true` on Claude and Codex adapters; default `false` for any future adapter
- [ ] Add user setting `liveSteering` (default off) to settings store + `settings.ts` service
- [ ] Surface the toggle in the settings UI with "experimental / can switch back" copy
- [ ] Tests: capability defaults; setting persistence + default-off

## Phase 2 — Claude streaming adapter

- [ ] Add streaming spawn path in `claude.ts` (piped stdio, `--input-format stream-json --output-format stream-json --replay-user-messages`), gated by capability + setting
- [ ] Persistent process: map `result` event → turn-complete; reserve `done` for process exit
- [ ] `sendUserMessage(text, {images?})` NDJSON serializer
- [ ] `interrupt()` via `control_request`; `setPermissionMode()` via `control_request`; track `request_id` ↔ `control_response`
- [ ] Move process teardown to explicit dispose / idle-eviction (not per-turn)
- [ ] Tests: NDJSON framing, `result`-as-turn-end, replay-echo handling, control-message round-trip

## Phase 3 — Codex adapter

- [ ] Expose `sendUserMessage()` (wraps existing `turn/steer` path)
- [ ] Upgrade `interrupt()` from hard `kill()` to `turn/interrupt` (graceful)
- [ ] Detect/surface `turn/steer` rejection during review/compaction turns → fall back to queue
- [ ] Tests: `turn/steer` notification shape, interrupt path, rejection fallback

## Phase 4 — AgentProcess interface + worker + proxy

- [ ] Add `sendUserMessage` (and any control methods) to `AgentProcess` interface
- [ ] `POST /agent/message` (`{text, images}`) and `POST /agent/control` (`{subtype, …}`) on session worker (`session-worker.ts` / `worker-http.ts`)
- [ ] Proxy both through `ProxyAgentProcess` + `container-session-runner.ts` (mirror `writeAgentStdin`)
- [ ] Tests: worker endpoint validation; proxy delegation

## Phase 5 — WS routing + turn lifecycle

- [ ] In `send_message`: when `runner.running` && steering active → `sendUserMessage()`, else existing `messageQueue.push()` path verbatim
- [ ] Emit new `message_steered` server event (type in `ws-server-messages.ts`)
- [ ] `runAgentWithMessage` / `drainNextQueuedMessage`: "process already alive, feed next message" branch for streaming agents
- [ ] Respect WS-lifecycle rules: capture session context at turn start, resolve via registry, mutate runner directly, emit via `runner.emitMessage()`
- [ ] Handle dispose / `restartAgent` (docs/127) / OOM-retry (docs/126) / reconnection with `--resume`-on-respawn for persistent Claude sessions
- [ ] Integration tests: steer mid-turn, steer-then-disconnect/reconnect, fall-back-to-queue when setting off, interrupt during steered turn

## Phase 6 — client UX

- [ ] Enable send button while running when steering active (capability + setting gated)
- [ ] Render steered messages inline in the live transcript (confirmed by echo / accepted turnId)
- [ ] Keep `QueueIndicator` for the non-steering path (gated)
- [ ] Component tests: input enabled-while-running, inline steered message render, queue path unchanged when off

## Cross-cutting

- [ ] `npm run lint` + `npm run typecheck` clean
- [ ] Update `src/server/shipit-docs/` if any agent-facing behavior changes
- [ ] Decide `result subtype` taxonomy: normal vs interrupted vs error for post-turn flow (auto-commit, PR card)
- [ ] Decide whether to adopt `--include-partial-messages` (token-level streaming) or keep message-granularity
- [ ] Update `plan.md` status → `in-progress` when work starts, `done` + all boxes checked when complete
