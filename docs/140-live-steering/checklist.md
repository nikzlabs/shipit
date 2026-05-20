# Live steering — checklist

Tracks remaining work for `docs/140-live-steering`. See `plan.md` for design.

## Spike / research (done)

- [x] Verify `claude --input-format stream-json` mid-turn steering (same session, no restart)
- [x] Verify Claude interrupt via `control_request {subtype:"interrupt"}` (turn ends, session stays alive)
- [x] Verify Claude `--resume <session_id>` works in streaming-input mode (fresh process recovery)
- [x] Verify Claude mid-session permission-mode change via `control_request {subtype:"set_permission_mode"}`
- [x] Confirm Codex steering primitive (`turn/steer`) — already implemented in `codex-adapter.ts` `writeStdin`
- [x] Research Codex `turn/interrupt` semantics (graceful, `turn/completed status:"interrupted"`)

## Phase 1 — capability + interface + setting (no behavior change)

- [ ] Add `supportsSteering: boolean` to `AgentCapabilities` (`agent-types.ts`)
- [ ] Set `supportsSteering: true` on Claude and Codex adapters; default `false` for any future adapter
- [ ] Add `sendUserMessage(text, {images?})` (+ any control methods) to the `AgentProcess` interface here, so types stay coherent as later phases merge
- [ ] Publish `supportsSteering` via the **agent registry** (mirror `supportsReview`); gating must NOT read `ProxyAgentProcess.capabilities` (hardcoded defaults)
- [ ] Add user setting `liveSteering` (default off) to settings store + `settings.ts` service
- [ ] Surface the toggle in the settings UI with "experimental / can switch back" copy
- [ ] Tests: capability defaults; registry publishes the flag; setting persistence + default-off

## Phase 2 — Claude streaming adapter

- [ ] Add streaming spawn path in `claude.ts` (piped stdio, `--input-format stream-json --output-format stream-json --replay-user-messages`), gated by capability + setting
- [ ] Persistent process: map `result` event → turn-complete; reserve `done` for process exit
- [ ] `sendUserMessage(text, {images?})` NDJSON serializer
- [ ] `interrupt()` via `control_request`; `setPermissionMode()` via `control_request`; track `request_id` ↔ `control_response`
- [ ] Turn-scoped inactivity watchdog (arm on send, clear on `result`) — not process-scoped
- [ ] Move auth-detection + ANSI/non-JSON heuristics to the separated stderr pipe (no longer PTY-merged)
- [ ] Move process teardown to explicit dispose / idle-eviction (not per-turn)
- [ ] Tests: NDJSON framing, `result`-as-turn-end, replay-echo handling, control-message round-trip

## Phase 3 — Codex adapter

- [ ] Expose `sendUserMessage()` (wraps existing `turn/steer` path)
- [ ] Upgrade `interrupt()` from hard `kill()` to `turn/interrupt` (graceful, `turn/completed status:"interrupted"`)
- [ ] **Decide steer-rejection detection mechanism** — `turn/steer` is fire-and-forget today (no reply); detecting a review/compaction rejection likely needs steer-as-`sendRequest` (with id) or watching for an error notification
- [ ] Detect/surface `turn/steer` rejection during review/compaction turns → fall back to queue
- [ ] Tests: `turn/steer` request/notification shape, interrupt path, rejection fallback

## Phase 4 — worker + proxy

- [ ] `POST /agent/message` (`{text, images}`) and `POST /agent/control` (`{subtype, …}`) on session worker (`session-worker.ts` / `worker-http.ts`)
- [ ] Proxy both through `ProxyAgentProcess` + `container-session-runner.ts` (mirror `writeAgentStdin`)
- [ ] Tests: worker endpoint validation; proxy delegation

## Phase 5 — WS routing + turn lifecycle

- [ ] In `send_message`: when `runner.running` && steering active → `sendUserMessage()`, else existing `messageQueue.push()` path verbatim
- [ ] **Steer targets the runner that owns the in-flight turn** (the `running===true` runner for the captured turn session), NOT the connection's active session — resolve via registry
- [ ] **Remap post-turn flow onto `agent_result` for streaming agents**: `postTurnCommit`, PR-card emission, `scheduleAutoPush`, `session_agent_finished` SSE, and queue drain currently live in the `done` handler (`agent-execution.ts`) — `done` only fires on dispose/crash in streaming mode
- [ ] **Unify queue + steer delivery**: `drainNextQueuedMessage` must feed the next message via `sendUserMessage` (not `run()` a fresh process) for streaming agents — single turn-start path
- [ ] **`answer_question` routing**: when steering active, disable the interrupt-on-AskUserQuestion hack (`agent-listeners.ts:335-357`) and route `handleAnswerQuestion` through `sendUserMessage`/control instead of fresh `--resume`
- [ ] Emit new `message_steered` server event (type in `ws-server-messages.ts`); broadcast via `runner.emitMessage()` (turn-event buffer for reconnect/multi-viewer)
- [ ] **Echo dedupe contract**: optimistic client insert tagged with a local id; reconcile against the Claude `--replay-user-messages` echo / Codex accepted `turnId` so the message isn't double-rendered
- [ ] Respect WS-lifecycle rules: capture session context at turn start, resolve via registry, mutate runner directly, emit via `runner.emitMessage()`
- [ ] Handle dispose (defined drop/preserve for buffered-but-unsent steer) / `restartAgent` (docs/127 — drops in-flight turn, resumes cold via `--resume`) / agent-container OOM (OOM circuit breaker, docs/122/124 — **not** docs/126, which is preview-OOM) / reconnection with `--resume`-on-respawn
- [ ] Integration tests: steer mid-turn; `result`-without-`done` post-turn flow; steer-then-disconnect/reconnect; steer-during-session-switch targets correct runner; fall-back-to-queue when setting off; interrupt during steered turn; AskUserQuestion answer via steering

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
