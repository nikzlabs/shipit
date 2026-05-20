---
status: planned
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

1. **`AgentCapabilities.supportsStreamingInput`** (`agent-types.ts`) — Claude:
   `true`, Codex: `false`. Backend-level fact about whether the adapter can
   stream input at all.
2. **User setting `liveSteering` (default off)** — even for a streaming-capable
   agent, the user must opt in. Lives in the settings store / `settings.ts`
   service, surfaced in the settings UI. This is the "switch back to the stable
   way" escape hatch.

Live steering is active for a session only when **both** are true. Otherwise the
existing queue path runs unchanged.

## Touchpoints

**Types — `src/server/shared/types/agent-types.ts`**
- Add `supportsStreamingInput: boolean` to `AgentCapabilities`.
- Add a first-class `AgentProcess.sendUserMessage(text, { images? })` method
  distinct from raw `writeStdin()`. Streaming adapters serialize an NDJSON user
  event; the interface stays honest about intent.
- Consider `AgentProcess.setPermissionMode(mode)` and a streaming-aware
  `interrupt()` that emits a `control_request` instead of PTY Ctrl+C.

**Session — `src/server/session/claude.ts`**
- New streaming spawn path (piped stdio, the flags above), persistent process.
- Map the `result` event to turn-complete while keeping the process alive;
  reserve `done` for actual process exit / dispose.
- `sendUserMessage()` NDJSON serializer; `interrupt()` and `setPermissionMode()`
  via `control_request`; track `request_id` ↔ `control_response`.
- Process teardown moves to explicit dispose / idle-eviction, not per-turn.

**Worker — `src/server/session/session-worker.ts` + `worker-http.ts`**
- The raw `/agent/stdin` endpoint stays. Add `POST /agent/message`
  (`{text, images}`) → `sendUserMessage()`, and `POST /agent/control`
  (`{subtype, …}`) for interrupt / set-permission-mode.
- `ProxyAgentProcess` (`proxy-agent-process.ts`) +
  `container-session-runner.ts` proxy these over HTTP, mirroring the existing
  `writeAgentStdin` plumbing.

**Routing — `ws-handlers/send-message.ts` + `agent-execution.ts`**
- In `send_message`: if `runner.running` **and** live steering active, call
  `sendUserMessage()` and emit a new `message_steered` server event (rendered
  inline in the live transcript, confirmed by the `--replay-user-messages`
  echo). Otherwise keep the `messageQueue.push()` + `message_queued` path
  verbatim.
- The persistent process means the agent is **not** recreated each turn.
  `runAgentWithMessage` / `drainNextQueuedMessage` need a "process already
  alive, feed it the next message" branch for streaming agents. This is the
  fiddliest part and must respect the WS-lifecycle rules: capture session
  context at turn *start*, resolve runners via the registry, mutate runner state
  directly, emit via `runner.emitMessage()`.

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
- **`restartAgent` recovery** (docs/127) and **OOM auto-retry** (docs/126) —
  both currently assume a fresh process per turn. They need to resume via
  `--resume <session_id>` (verified working) when re-spawning a streaming
  session.
- **Reconnection contract** — if the orchestrator restarts while a streaming
  process is alive, recovery is "re-spawn + `--resume`". The session_id must be
  persisted at turn start.
- **Interrupt semantics** — `interrupt()` becomes a `control_request`, not PTY
  Ctrl+C. Confirm the existing interrupt UI/flow maps onto turn-end-without-kill.

## Implementation order (suggested)

1. Add `supportsStreamingInput` capability + `liveSteering` setting (both
   default to the stable path). No behavior change yet.
2. Add the streaming spawn path in `claude.ts` behind the capability, with
   `sendUserMessage` / control-message support. Unit-test the NDJSON framing and
   `result`-as-turn-end mapping.
3. Wire worker endpoints + proxy.
4. Route `send_message` to steering when active; add `message_steered` + client
   inline rendering.
5. Handle the lifecycle paths (dispose, restart, OOM, resume-on-respawn).
6. Settings UI toggle + docs.

## Open questions to resolve during build

- Exact `result subtype` taxonomy we should treat as "turn ended normally" vs.
  "interrupted" vs. "error" for the post-turn flow (auto-commit, PR card).
- Whether to also adopt `--include-partial-messages` for token-level streaming
  or keep message-granularity to limit blast radius.
- Codex parity: does the codex CLI have any streaming-input equivalent, or does
  it stay queue-only indefinitely (capability `false`).

## Key files

- `src/server/session/claude.ts` — spawn, stdin model, event mapping.
- `src/server/shared/types/agent-types.ts` — capabilities + AgentProcess.
- `src/server/session/session-worker.ts`, `worker-http.ts` — worker endpoints.
- `src/server/orchestrator/proxy-agent-process.ts`,
  `container-session-runner.ts` — container proxy.
- `src/server/orchestrator/ws-handlers/send-message.ts`,
  `agent-execution.ts` — routing + turn lifecycle.
- `src/client/components/MessageInput.tsx`, `QueueIndicator.tsx`,
  `src/client/stores/session-store.ts` — client UX + settings toggle.
