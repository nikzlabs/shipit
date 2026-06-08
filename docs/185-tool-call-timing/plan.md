---
description: Derive and surface per-tool execution time in the tool-call detail modal.
---

# Tool-call timing

Show how long each tool call took inside the tool-call detail modal (`ToolOutputModal`).

## The problem

The Claude/Codex CLIs emit no per-tool timing. The only duration in the NDJSON
stream is a **turn-level** `duration_ms` on the `result` event (already surfaced
via `AgentResultEvent.durationMs` / `usage_turns`). Individual `tool_use` /
`tool_result` blocks carry no timestamps, so the detail modal had nothing to show.

## The approach: derive timing at the parse boundary

We don't need the CLI to report it. The orchestrator sees every `agent_tool_use`
block and its matching `agent_tool_result` (correlated by `tool_use_id`) stream
through `wireAgentListeners`. Stamping wall-clock time at each gives the tool's
execution duration as the delta — accurate to within parse latency, no CLI change.

Flow (`agent-listeners.ts`):

1. **Stamp start** — `recordToolUses` (already called for every observed
   `tool_use`, top-level and subagent) now also records `tool_use_id → Date.now()`
   in `toolUseStartTimes`. First observation wins.
2. **Stamp end** — when an `agent_tool_result` event arrives, `stampToolDurations`
   injects `duration_ms = now - start` onto each `tool_result` content block,
   **before** the event is emitted to viewers. Mutating the event content (not a
   side channel) means one computed value rides BOTH paths: the live WS event the
   client reads, and the persisted `toolResults` that `extractToolResults` builds
   downstream — single source, no extra plumbing. Negative deltas (clock skew)
   clamp to 0.
3. **Carry into entries** — `extractToolResults` reads `duration_ms` → `durationMs`
   on each `ToolResultEntry`, which flows into the persisted message group.

## Persistence (no migration)

`durationMs` is added to `PersistedMessage.toolResults[]`, which serializes as a
JSON blob in the existing `tool_results` column (`toRow` does
`JSON.stringify`, `fromRow` does `JSON.parse`). No schema change. The
serialization-contract test in `chat-history.test.ts` guards the round-trip.

## Client

- `ToolResultBlock` gains `durationMs?`.
- Live path: `agent-event.ts` reads `block.duration_ms` into the result block.
- Reload path: `loadSessionHistory` spreads persisted messages, so `durationMs`
  flows through automatically (`session-data.ts` type updated to match).
- Display: `ToolOutputModal` renders the duration next to the "Output" header,
  formatted by `formatToolDuration` (`<1s` → ms, `<10s` → one decimal, else whole
  seconds). The modal is the only surface (scope: persisted + modal only — no
  inline badge on collapsed tool rows).

## Caveat: interactive tools

For tools that block on a human (AskUserQuestion / ExitPlanMode), the delta
includes approval/think time, so it reads as *elapsed*, not pure execution. The
modal's tooltip notes this. Not corrected for — these are rare and the elapsed
figure is still meaningful.

## Key files

- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `toolUseStartTimes`,
  `stampToolDurations`, `extractToolResults`, the stamp call before emit.
- `src/server/orchestrator/session-runner.ts` — `ToolResultEntry.durationMs`.
- `src/server/orchestrator/chat-history.ts` — `PersistedMessage.toolResults[].durationMs`.
- `src/client/components/MessageList.tsx` — `ToolResultBlock.durationMs`.
- `src/client/hooks/message-handlers/agent-event.ts` — live read of `duration_ms`.
- `src/client/utils/session-data.ts` — history-response type.
- `src/client/components/message-tools.tsx` — `formatToolDuration`, modal render.

## Tests

- `agent-listeners.test.ts` — `stampToolDurations` (stamp / skip-unknown / no-overwrite
  / clamp / non-result no-op) and `extractToolResults` duration passthrough.
- `chat-history.test.ts` — `durationMs` in the serialization-contract round-trip.
- `message-tools.test.tsx` — modal shows/omits the duration; `formatToolDuration` units.
