---
status: done
priority: medium
description: Let Codex ask structured multiple-choice questions in any mode via a ShipIt-managed AskUserQuestion MCP bridge, reusing the existing question/interrupt/resume flow.
---

# Codex question tool (`AskUserQuestion` MCP bridge)

## Problem

Codex could not ask the user multiple-choice questions inside ShipIt. When the
model tried, the user saw a plain-text fallback like:

> I tried the structured question tool, but it is only available in Plan mode here.

Claude has this via its native `AskUserQuestion` tool (rendered by
`AskUserQuestion.tsx`). Codex has a *native* equivalent (`request_user_input`)
but it is gated behind the experimental, **Plan-mode-only** feature
`default_mode_request_user_input` (`stage: underDevelopment`,
`defaultEnabled: false`). ShipIt runs every turn in Default mode (so the agent
can edit files), so Codex's native tool is never offered to the model.

## Chosen approach — an internal MCP bridge (not the native tool)

Rather than enable Codex's experimental native tool (which would require
`--enable default_mode_request_user_input`, handling a blocking
`item/tool/requestUserInput` JSON-RPC request, and a brand-new
`answerUserInput` answer channel — see "Rejected alternative" below), we
register a ShipIt-managed `AskUserQuestion` **MCP tool** for Codex, mirroring
the existing `shipit-review` / `shipit-present` / `shipit-voice` bridges.

The bridge's input is shaped exactly like Claude's native tool
(`{ questions: [{ question, header, options: [{ label, description }],
multiSelect }] }`). When Codex calls it, the Codex adapter observes the
`item/started` notification and **re-emits it as a normalized
`AskUserQuestion` tool_use** under that raw name. From there, the orchestrator's
existing flow takes over unchanged:

- `agent-listeners.ts` sees the `AskUserQuestion` tool_use, sets
  `wasInterrupted`, suppresses any auto-resolved tool_result, and calls
  `agent.interrupt()` (which for Codex kills the app-server process).
- The question card renders normally (`message-tools.tsx` matches
  `tool.name === "AskUserQuestion" && Array.isArray(tool.input.questions)`).
- The user answers; `handleAnswerQuestion` → `runAgentWithMessage` resumes the
  session with the answer as the next turn — for Codex that is a
  `thread/resume` with the answer text. This is the **same** agent-agnostic
  answer path Claude's non-streaming flow uses; no Codex-specific routing was
  added.

Because it's a normal MCP tool, it is available in **any** mode — bypassing the
Plan-mode gate that blocked the native tool.

### Bridge blocking semantics

`mcp-ask-bridge.ts` is pure transport. For a **well-formed** call the tool
intentionally never returns: the orchestrator interrupts the turn the moment it
sees the tool_use (killing the Codex process and, with it, the bridge
subprocess), then resumes with the answer as a fresh turn — so the bridge's
result is never consumed. The handler `await`s a never-resolving promise; when
the process is torn down its stdin closes and it exits. A **malformed** call
(no usable `questions`) returns an error immediately so the model self-corrects
within the same turn instead of hanging — mirroring how Claude's CLI rejects a
malformed `AskUserQuestion`.

The question reaches the UI through the adapter's event stream (the
`item/started` observation), **not** through a bridge→worker→orchestrator
round-trip — so unlike the review/voice/present bridges, no new `/agent-ops`
route is needed.

## Rejected alternative — Codex's native `request_user_input`

The earlier plan (preserved in git history) enabled the native tool via
`--enable default_mode_request_user_input` and answered the blocking
`item/tool/requestUserInput` JSON-RPC request with a new `answerUserInput`
method on every adapter. Rejected because:

- It depends on an `underDevelopment` upstream feature flag that can be renamed
  or removed by a CLI bump.
- The answer must be sent as the JSON-RPC **response** to the blocked request
  (same turn), which is a *different* path from ShipIt's existing
  answer-as-next-turn flow — forcing a new answer method on every adapter and a
  Codex-specific branch in `handleAnswerQuestion`.

The bridge approach reuses the existing UI, interrupt, answer, and resume logic
with no orchestrator changes, and keeps the fix scoped to the Codex adapter +
one new bridge file.

## Implementation (as built)

1. **`src/server/session/mcp-ask-bridge.ts`** (new) — stdio MCP server exposing
   the `AskUserQuestion` tool with the Claude-compatible input schema. Validates
   `questions`; blocks on a well-formed call, errors on a malformed one.
2. **`src/server/shared/types/agent-types.ts`** — new `AgentMcpAskBridge` type;
   `askBridge` field on `AgentMcpWriteContext`.
3. **`src/server/session/session-worker.ts`** — `askBridgePaths()` resolves the
   bridge + `tsx` (graceful-degrade to null), passed into `writeMcpConfig`.
4. **`src/server/session/agents/codex/adapter.ts`**
   - `capabilities.toolNames` gains `"AskUserQuestion"` (so `agent_init`
     advertises it and the UI/history recognize it).
   - `writeMcpConfig` registers `[mcp_servers.shipit-ask]` when `askBridge` is
     present.
   - `handleItem` mcpToolCall branch: `isAskUserQuestionTool()` detects the
     bridge tool (bare or server-qualified name) and re-emits it as an
     `AskUserQuestion` tool_use with `normalizeAskQuestions()`-cleaned input
     (synthesizes `multiSelect: false` and `description: ""` fallbacks). A
     `completed` for the ask tool emits **no** tool_result (would mark the card
     answered).
5. **`src/server/session/agents/codex/tool-map.ts`** — `AskUserQuestion` →
   `ask_user` so activity labels canonicalize like Claude's.
6. Claude is unchanged: it ignores `askBridge` (it has the native tool).

## Tests

- `codex/adapter.test.ts` — a `shipit-ask` mcpToolCall (server-qualified and
  bare names) re-emits as a normalized `AskUserQuestion` tool_use; defaults are
  synthesized; a completed ask call emits no tool_result; non-ask MCP tools
  still flow through under their own name; `agent_init` advertises the tool.
- `codex/mcp-writer.test.ts` — `[mcp_servers.shipit-ask]` is written when
  `askBridge` is supplied and omitted when null.
- The orchestrator interrupt/answer/resume flow is agent-agnostic and already
  covered by `integration_tests/ask-user-question.test.ts` (it keys on the
  `AskUserQuestion` tool name, which Codex now emits with the identical shape).

## Known considerations

- **Resume after an abandoned tool call.** Interrupt+resume kills the turn while
  the bridge tool call is still pending in the Codex thread, then resumes via
  `thread/resume`. Codex's resume is built to continue interrupted threads;
  this mirrors Claude's `--resume`-after-interrupt path. Watch for any
  resume confusion from the dangling call in live use.
- `isSecret`-style masked answers are not supported (ShipIt's question card has
  no masked input); the bridge schema omits it.
