---
status: in-progress
priority: medium
description: Inject user input into a running agent turn (native-CLI-style steering), capability-gated, with a settings toggle to fall back to the stable per-turn queue.
---

# Live steering: inserting user input while an agent is running

## Goal

Let the user send a message *while an agent turn is in flight* and have the
running agent fold it into the current turn — the way the native Claude CLI and
the Claude VSCode extension behave. Today ShipIt queues mid-turn messages and
runs them as a fresh turn only after the current one finishes.

This is **opt-in and reversible**: the existing per-turn one-shot path is stable
and stays the default. Live steering is a capability-gated mode the user can
turn on (and off) in settings. If steering misbehaves, the user flips back to
the queue without losing anything.

**Both backends can steer.** Claude steers via `--input-format stream-json`
(persistent process, inject user-message NDJSON on stdin). Codex steers via the
app-server `turn/steer` JSON-RPC method — and the `CodexAdapter` **already
implements it** in `writeStdin` (`codex-adapter.ts`). The blocker is the same for
both: the WS routing layer queues mid-turn messages instead of routing them to
the adapter's steering primitive. So the bulk of the work (WS routing, client
UX, settings toggle) is shared; only the Claude adapter needs a substantial
spawn-mode change.

## Why this is feasible (spike findings)

Spiked directly against the pinned CLI (`claude` v2.1.145) driving
`--input-format stream-json` by hand. All four unknowns resolved:

| Behavior | Result |
|---|---|
| **Mid-turn steering** | ✅ Inject a `{"type":"user",...}` NDJSON line on stdin while a turn runs. The CLI buffers it and applies it at the **next decision point** (when the in-flight tool returns) — it does **not** abort a running tool. Same `session_id`, `num_turns` increments, no restart. The model changed course as instructed. |
| **Interrupt** | ✅ `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` → `control_response: success`, current turn ends with `result subtype=error_during_execution`, and the **streaming session stays alive** for the next message. |
| **Resume across a fresh process** | ✅ `--resume <session_id>` works in streaming-input mode. A brand-new process recalled prior context and reused the same `session_id`. This is the idle-eviction / orchestrator-restart recovery path. |
| **Permission-mode change mid-session** | ✅ `{"type":"control_request","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}` → success; the subsequent `init` reports the new mode. No restart needed. |

Relevant CLI flags (confirmed in `claude --help`):
- `--input-format stream-json` — "realtime streaming input" (only with `--print`).
- `--replay-user-messages` — re-emits injected user messages on stdout with
  `isReplay:true` so we can acknowledge/render them inline rather than
  optimistically. Requires stream-json in **and** out.
- `--include-partial-messages` — partial chunks (optional, for finer streaming).

Spike scripts were throwaway (lived in `/tmp/steer-spike`, not committed).

## The core architectural shift

Today (`src/server/session/claude.ts`): one `claude -p <prompt> …` process
**per turn**, spawned on a PTY (node-pty), and the `done` event == process exit.

Streaming mode inverts this:

- Spawn **once** with `-p --input-format stream-json --output-format stream-json
  --replay-user-messages …` and **keep the process alive across turns**.
- The initial prompt is no longer a CLI arg — it's the first NDJSON user message
  written to stdin.
- A **turn ends at the `result` event**, not at process exit. The process stays
  resident waiting for the next stdin message.
- Steering = writing another user-message NDJSON line to stdin mid-turn.
- Interrupt / permission-mode changes = `control_request` lines on stdin.

### PTY → pipe

The current PTY exists because piped stdin made *print mode* hang
(`claude.ts:49`). Streaming-input mode is **designed** for piped stdin (it's the
SDK transport), so the streaming variant should use `child_process.spawn` with
real piped stdio, not a PTY. Keep the two stdin models separate — do not
entangle the legacy PTY one-shot path with the streaming pipe path.

## Design: capability gate + settings toggle

Two independent switches gate the feature:

1. **`AgentCapabilities.supportsSteering`** (`agent-types.ts`) — `true` for
   **both** Claude (stream-json input) and Codex (`turn/steer`). Backend-level
   fact about whether the adapter can accept input mid-turn. An adapter with no
   steering primitive sets `false` and always uses the queue.
2. **User setting `liveSteering` (default off)** — even for a steering-capable
   agent, the user must opt in. Lives in the settings store / `settings.ts`
   service, surfaced in the settings UI. This is the "switch back to the stable
   way" escape hatch.

Live steering is active for a session only when **both** are true. Otherwise the
existing queue path runs unchanged.

### Per-adapter status

| Adapter | Steering primitive | Adapter work needed |
|---|---|---|
| **Claude** | `--input-format stream-json` + user-message NDJSON on stdin | Substantial: new persistent streaming spawn path (see below). |
| **Codex** | `turn/steer` JSON-RPC notification | Minimal: `writeStdin` already sends `turn/steer` (`codex-adapter.ts:298`). Mostly just expose `sendUserMessage` and upgrade `interrupt()` to `turn/interrupt` (graceful) instead of the current hard `kill()`. |

Codex caveat: `turn/steer` is rejected during **review** and **manual
compaction** turns — the adapter must surface that rejection (fall back to the
queue for that message) rather than dropping it silently. Codex also kills its
app-server at `turn/completed` today (`handleTurnCompleted` → `kill()`), so
cross-turn persistence differs from Claude; steering is *within* a live turn, so
that's fine, but it means Codex needs no lifecycle rework for this feature.

## Touchpoints

**Types — `src/server/shared/types/agent-types.ts`**
- Add `supportsSteering: boolean` to `AgentCapabilities` (Claude + Codex both
  `true`).
- Add a first-class `AgentProcess.sendUserMessage(text, { images? })` method
  distinct from raw `writeStdin()`. Streaming adapters serialize an NDJSON user
  event; the interface stays honest about intent.
- Add `AgentProcess.setPermissionMode(mode)` (spike-verified via
  `control_request`) and a streaming-aware `interrupt()` that emits a
  `control_request` instead of PTY Ctrl+C. An interrupted streaming turn ends
  with a `result` (not a process exit), so the interrupt path rides the same
  post-turn remap onto `agent_result` described under Routing below.

**Session — `src/server/session/claude.ts`**
- New streaming spawn path (piped stdio, the flags above), persistent process.
- Map the `result` event to turn-complete while keeping the process alive;
  reserve `done` for actual process exit / dispose.
- `sendUserMessage()` NDJSON serializer; `interrupt()` and `setPermissionMode()`
  via `control_request`; track `request_id` ↔ `control_response`.
- Process teardown moves to explicit dispose / idle-eviction, not per-turn.
- **The PTY one-shot heuristics do not port to piped stdio.** Switching to
  `child_process.spawn` *separates* stderr (the PTY merges it — see the
  `drainLines` comment), so the auth-detection and ANSI/non-JSON heuristics move
  to the dedicated stderr stream. The 30s inactivity watchdog becomes
  **turn-scoped** (arm on send, clear on `result`) instead of process-scoped —
  an idle-but-alive persistent process between turns must not trip it.

**Worker — `src/server/session/session-worker.ts` + `worker-http.ts`**
- The raw `/agent/stdin` endpoint stays. Add `POST /agent/message`
  (`{text, images}`) → `sendUserMessage()`, and `POST /agent/control`
  (`{subtype, …}`) for interrupt / set-permission-mode.
- `ProxyAgentProcess` (`proxy-agent-process.ts`) +
  `container-session-runner.ts` proxy these over HTTP, mirroring the existing
  `writeAgentStdin` plumbing.
- **Steering eligibility is resolved via the shared agent registry, NOT
  `ProxyAgentProcess.capabilities`.** In production every container session runs
  through the proxy, whose `capabilities` are hardcoded conservative defaults
  (`proxy-agent-process.ts:60-72`) — it doesn't know its target's real
  capabilities. The gating code must read `supportsSteering` from the agent
  registry, exactly how `supportsReview` is published today.

**Routing — `ws-handlers/send-message.ts` + `agent-execution.ts`**
- In `send_message`: if `runner.running` **and** live steering active, call
  `sendUserMessage()` and emit a new `message_steered` server event. Otherwise
  keep the `messageQueue.push()` + `message_queued` path verbatim. If a steering
  primitive rejects the message (e.g. Codex during a review/compaction turn),
  fall back to the queue rather than dropping it (see Codex caveat below — this
  may require steer-as-request, not fire-and-forget notification).
- **Steer target is the runner that owns the in-flight turn, not the
  connection's active session.** `handleSendMessage` resolves the runner at
  handler entry via the connection's active session id; if the user switched
  sessions mid-turn, that's the wrong runner. The steer must be addressed to the
  runner whose `running===true` for the captured turn session, and
  `sendUserMessage` must target *that* runner's agent. Resolve via the registry.
- **Echo dedupe.** The steered message is rendered inline. The client inserts it
  optimistically; the backend also receives an echo (Claude
  `--replay-user-messages` with `isReplay:true`; Codex `turn/steer` accepted
  `turnId`). Define a dedupe contract (client tags its optimistic insert with a
  local id; the echo reconciles against it) so the message isn't double-rendered.
  Broadcast the canonical `message_steered` via `runner.emitMessage()` so the
  turn-event buffer carries it to reconnecting / other-tab viewers.
- **Unify "queued message" and "steer" into one delivery path for streaming
  agents.** With a persistent process the agent is **not** recreated per turn, so
  `drainNextQueuedMessage` must *not* `run()` a fresh process — it feeds the next
  message via `sendUserMessage` too. Otherwise there are two divergent turn-start
  paths. A message that arrives in the narrow window after `result` (when
  `running` just flipped false) correctly falls to the queue, and the drain then
  feeds it to the still-alive process. This whole branch must respect the
  WS-lifecycle rules: capture session context at turn *start*, resolve runners
  via the registry, mutate runner state directly, emit via `runner.emitMessage()`.

**Post-turn flow remap (the actually-fiddly part).** Today `result` and process
exit fire back-to-back for the one-shot process, so the orchestrator's post-turn
work hangs off the **`done`** path in `agent-execution.ts`: `postTurnCommit`
(auto-commit), PR-card emission, `scheduleAutoPush`, `drainNextQueuedMessage`,
and the `session_agent_finished` SSE broadcast. (`agent-listeners.ts` already
flips `running=false` and persists chat history on `agent_result`.) In streaming
mode `done` only fires on dispose/crash, so **for streaming agents every one of
those post-turn actions must move to the `agent_result` event.** This bifurcation
(listeners on `result`, execution on `done`) is the core lifecycle change, not a
claude.ts-local detail. Needs a "result without done" integration test.

**AskUserQuestion / `answer_question` routing.** This interacts directly with the
model. Today (`agent-listeners.ts:335-357`) the `-p` headless CLI *cannot* block
on `AskUserQuestion`, so the orchestrator deliberately `agent.interrupt()`s on
seeing that tool, sets `wasInterrupted=true` to suppress the post-turn
error/queue-drain, and `handleAnswerQuestion` later resumes with a fresh
`--resume` process carrying the answer as the next prompt. Streaming mode breaks
all three assumptions: the CLI may now genuinely block awaiting input,
`interrupt()` is a `control_request` (not a process kill), and the answer should
flow through `sendUserMessage` rather than spawning a fresh `--resume` process.
The plan must: (a) disable the interrupt-on-AskUserQuestion hack when steering is
active, and (b) route `handleAnswerQuestion` through `sendUserMessage`/control
for steering sessions. This belongs in Phase 5 with its own integration test.

**Client — `MessageInput.tsx`, `QueueIndicator.tsx`, `session-store.ts`,
settings UI**
- For streaming + opt-in: enable the send button while running; sent messages
  render inline (confirmed by replay echo).
- Keep `QueueIndicator` for the non-steering path — capability/setting-gated in
  the UI.
- Add the `liveSteering` toggle to settings with copy explaining it's
  experimental and can be switched back.

## Lifecycle implications (the real risk surface)

A persistent process changes assumptions that currently key off "process
exited":

- **Idle eviction / dispose** — disposing a session must now explicitly tear
  down the streaming process; "process exited" is no longer the turn-end signal.
  A buffered-but-unsent steer must have defined drop/preserve semantics on
  teardown (don't silently vanish).
- **`restartAgent` recovery** (docs/127) — currently assumes "new runner starts
  idle." A persistent streaming session restarted mid-turn **drops the in-flight
  turn** and resumes cold via `--resume <session_id>` (verified working). State
  this explicitly; it matches the existing idle-start contract.
- **Agent-container OOM** is the **OOM circuit breaker**
  (`oom-circuit-breaker.ts`, docs/122/124), which trips on container OOM and
  refuses to recreate the container until the user resets via Rescue. (Note:
  docs/126 "OOM auto-retry" is about *preview compose services*, not the agent
  process — it has no interaction with steering.) The question for steering is
  whether a persistent process changes how a mid-turn container death is
  observed; recovery is still re-spawn + `--resume`.
- **Reconnection contract** — if the orchestrator restarts while a streaming
  process is alive, recovery is "re-spawn + `--resume`". The session_id is
  persisted on `agent_init` / `agent_result` today; for a persistent process
  `init` fires once and steered turns reuse it — confirm that's sufficient.
- **Interrupt semantics** — `interrupt()` becomes a `control_request`, not PTY
  Ctrl+C. Confirm the existing interrupt UI/flow maps onto turn-end-without-kill.

## Implementation order (suggested)

1. Add `supportsSteering` capability + the `AgentProcess.sendUserMessage`
   interface method + `liveSteering` setting (all default to the stable path).
   The interface addition lands here so types stay coherent as later phases
   merge. No behavior change yet.
2. Add the streaming spawn path in `claude.ts` behind the capability, with
   `sendUserMessage` / control-message support, turn-scoped watchdog, and
   stderr-pipe auth/log heuristics. Unit-test NDJSON framing and
   `result`-as-turn-end mapping.
3. Codex adapter: expose `sendUserMessage`, upgrade `interrupt()` → `turn/interrupt`,
   and resolve the steer-rejection detection mechanism.
4. Wire worker endpoints + proxy; resolve steering eligibility via the registry.
5. Route `send_message` to steering when active; remap post-turn flow
   (commit/PR/`session_agent_finished`/drain) onto `agent_result`; unify
   queue+steer delivery; handle `answer_question` routing; add `message_steered`
   + client inline rendering with echo dedupe.
6. Handle the lifecycle paths (dispose, restartAgent, container-OOM,
   resume-on-respawn) + settings UI toggle + docs.

## Post-stabilization cleanup

Once Phase 6 lands and steering has soaked in real use, the `liveSteering`
user setting should be retired. It was scaffolded as a reversible escape
hatch while the streaming path bedded in; once that's no longer needed, the
dual-mode plumbing becomes pure tax.

- **Drop the user toggle.** Streaming becomes the only behavior for adapters
  with `supportsSteering: true`. Removes the gate in `send-message.ts:109/172/400`,
  the `useStreaming` branch in `agent-execution.ts:258`, and the "stale agent
  kill" carve-out (`send-message.ts:168–176`).
- **Keep the capability gate.** `supportsSteering` stays load-bearing — it's
  the seam that lets future agent backends without a steering primitive (or
  Codex during review / manual compaction turns) fall through to the queue
  path. CLAUDE.md explicitly commits to an agent-agnostic architecture, so
  the queue path can't go away; only the user-toggle layer on top of it can.
- **One-release transition.** Keep `liveSteering` as a hidden/dev-mode flag
  for one release as a self-rescue lever, then fully delete it from
  `credentialStore`, `settings.ts`, the settings UI, `MessageInput` gating,
  and the bootstrap payload.

This also closes a latent bug by construction. Today's gate
(`send-message.ts:111`, `agent-execution.ts:258`) reads the **adapter**
capability plus the user setting — it does NOT check whether *this particular
running process* was actually spawned in streaming mode. So if a user has the
toggle off, starts a turn (one-shot PTY process), then flips the toggle on
mid-turn and sends another message, the orchestrator calls `sendUserMessage`
on a non-streaming agent. The adapter's default falls through to raw stdin,
which the headless `-p` CLI ignores — the message silently vanishes. Removing
the toggle eliminates the "non-streaming process running under a steering
gate" state entirely; no runtime `canSteer()` check or proxy capability
plumbing is needed.

Net result: one path per adapter capability, not two paths gated by a user
setting. The dual-mode tax in `send-message.ts`, `agent-execution.ts`, and
the `result`-vs-`done` post-turn bifurcation is paid down considerably.

## Open questions to resolve during build

- Exact `result subtype` taxonomy we should treat as "turn ended normally" vs.
  "interrupted" vs. "error" for the post-turn flow (auto-commit, PR card).
- Whether to also adopt `--include-partial-messages` for token-level streaming
  or keep message-granularity to limit blast radius.
- How to detect/surface a `turn/steer` rejection (review/compaction turn) so the
  message falls back to the queue instead of vanishing. **`turn/steer` is sent
  as a fire-and-forget notification today (`codex-adapter.ts:343`), which has no
  reply to observe a rejection from** — reliable detection likely requires
  switching the steer to a `sendRequest` (with id) or watching for a specific
  error notification. Promote to a Phase 3 design decision.

## Key files

- `src/server/session/claude.ts` — spawn, stdin model, event mapping.
- `src/server/session/agents/codex-adapter.ts` — already wires `turn/steer` in
  `writeStdin`; needs `sendUserMessage` exposure + `turn/interrupt`.
- `src/server/shared/types/agent-types.ts` — capabilities + AgentProcess.
- `src/server/session/session-worker.ts`, `worker-http.ts` — worker endpoints.
- `src/server/orchestrator/proxy-agent-process.ts`,
  `container-session-runner.ts` — container proxy.
- `src/server/orchestrator/ws-handlers/send-message.ts`,
  `agent-execution.ts` — routing + turn lifecycle.
- `src/client/components/MessageInput.tsx`, `QueueIndicator.tsx`,
  `src/client/stores/session-store.ts` — client UX + settings toggle.
