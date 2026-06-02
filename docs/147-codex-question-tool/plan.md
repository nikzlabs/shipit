---
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
multiSelect }] }`). When Codex calls it, the bridge **POSTs the questions to the
worker** (`POST /agent-ops/ask/submit`), which normalizes them and **injects a
normalized `AskUserQuestion` tool_use** into the agent event stream — the same
`agent_event` the adapter emits for real tool calls. From there, the
orchestrator's existing flow takes over unchanged:

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

### Why the worker round-trip (corrected — see "Bug: card never rendered")

The original design assumed the Codex app-server emits an `item/started`
notification the moment the MCP tool is **called**, which the adapter could
re-emit as the `AskUserQuestion` tool_use. **It does not.** Codex surfaces an
`mcpToolCall` item only on `item/completed`, *after* the tool returns — and a
well-formed question deliberately never returns. So the adapter's event stream
never carried the question: the card never rendered, and the call sat until
Codex's own MCP tool-call timeout (~120s) fired. The user saw nothing, then a
timeout.

The fix routes the question through the **same bridge→worker→client path the
voice/present/review bridges use**, which does not depend on Codex's event
stream at all:

- `mcp-ask-bridge.ts` POSTs `{ questions }` to `POST /agent-ops/ask/submit` on
  the worker the moment the tool is called.
- The worker (`registerAskEndpoint`) normalizes the questions
  (`ask-question.ts`) and `broadcastSSE`s a synthetic `agent_event` of type
  `agent_assistant` carrying the `AskUserQuestion` tool_use — identical in shape
  to what the adapter emits for a real tool call.
- The orchestrator's existing AskUserQuestion handling (agent-listeners.ts) sees
  the tool_use, renders the card, and **interrupts the turn within
  milliseconds** — killing the Codex process and, with it, the bridge
  subprocess. No 120s wait.

### Bridge blocking semantics

`mcp-ask-bridge.ts` is pure transport. For a **well-formed** call, once the
worker has accepted the question (HTTP 200) the tool intentionally never
returns: the orchestrator interrupts the turn the moment it sees the injected
tool_use, then resumes with the answer as a fresh turn — so the bridge's result
is never consumed. The handler `await`s a never-resolving promise; when the
process is torn down its stdin closes and it exits. A **malformed** call (no
usable `questions`) — *or a worker that can't be reached / rejects the payload* —
returns an error immediately so the model self-corrects or retries within the
same turn instead of hanging.

The adapter (`handleItem`) now **ignores** the `shipit-ask` MCP tool on both
`item/started` and `item/completed`: emitting a tool_use there would duplicate
the bridge's card, and a tool_result would flip it to "answered". The question
is surfaced exclusively by the worker round-trip.

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
   `questions`; on a well-formed call POSTs them to `/agent-ops/ask/submit` and
   then blocks (never returns); on a malformed call — or an unreachable/failing
   worker — returns an error so the model self-corrects or retries.
2. **`src/server/session/ask-question.ts`** (new) — `normalizeAskQuestions()`:
   shared normalizer that cleans the raw `questions` into the card shape
   (`{ question, header, options: [{ label, description }], multiSelect }`),
   synthesizing `multiSelect: false` / `description: ""` fallbacks and dropping
   options without a label (and questions left with none). Independently
   unit-tested in `ask-question.test.ts`.
3. **`src/server/shared/types/agent-types.ts`** — `AgentMcpAskBridge` type;
   `askBridge` field on `AgentMcpWriteContext`.
4. **`src/server/session/session-worker.ts`**
   - `askBridgePaths()` resolves the bridge + `tsx` (graceful-degrade to null),
     passed into `writeMcpConfig`.
   - `registerAskEndpoint()` mounts `POST /agent-ops/ask/submit`: normalizes the
     questions, rejects an empty/unusable payload with 400, and otherwise
     `broadcastSSE`s a synthetic `agent_assistant` `agent_event` carrying the
     `AskUserQuestion` tool_use (id `ask_<uuid>`).
5. **`src/server/session/agents/codex/adapter.ts`**
   - `capabilities.toolNames` includes `"AskUserQuestion"` (so `agent_init`
     advertises it and the UI/history recognize it).
   - `writeMcpConfig` registers `[mcp_servers.shipit-ask]` when `askBridge` is
     present.
   - `handleItem` mcpToolCall branch: `isAskUserQuestionTool()` detects the
     bridge tool (bare or server-qualified name) and **ignores it entirely** in
     both phases — the worker round-trip surfaces the card, so re-emitting here
     would duplicate it (started) or mark it answered (completed).
6. **`src/server/session/agents/codex/tool-map.ts`** — `AskUserQuestion` →
   `ask_user` so activity labels canonicalize like Claude's.
7. Claude is unchanged: it ignores `askBridge` (it has the native tool).

## Tests

- `ask-question.test.ts` — `normalizeAskQuestions` passes well-formed input
  through, synthesizes defaults, drops unlabeled options / empty questions, and
  returns `[]` for unusable input.
- `codex/adapter.test.ts` — the adapter IGNORES a `shipit-ask` mcpToolCall on
  both `item/started` and `item/completed` (emits nothing); non-ask MCP tools
  still flow through under their own name; `agent_init` advertises the tool.
- `integration_tests/session-worker.test.ts` — `POST /agent-ops/ask/submit`
  injects a normalized `AskUserQuestion` tool_use that propagates over SSE to
  the proxy agent; a malformed payload returns 400.
- `codex/mcp-writer.test.ts` — `[mcp_servers.shipit-ask]` is written when
  `askBridge` is supplied and omitted when null.
- The orchestrator interrupt/answer/resume flow is agent-agnostic and already
  covered by `integration_tests/ask-user-question.test.ts` (it keys on the
  `AskUserQuestion` tool name, which the worker now injects with the identical
  shape).

## Bug: card never rendered, then 120s timeout (fixed)

The first cut relied on the adapter re-emitting an `item/started` for the MCP
call. Codex never emits one before the tool returns, so the card never appeared
and the call hung until Codex's MCP tool-call timeout (~120s). Fixed by the
worker round-trip above (bridge POST → `/agent-ops/ask/submit` → injected
`agent_event`), which is independent of Codex's event stream and triggers the
orchestrator interrupt immediately. See the "Why the worker round-trip" section.

## Known considerations

- **Resume after an abandoned tool call.** Interrupt+resume kills the turn while
  the bridge tool call is still pending in the Codex thread, then resumes via
  `thread/resume`. Codex's resume is built to continue interrupted threads;
  this mirrors Claude's `--resume`-after-interrupt path. Watch for any
  resume confusion from the dangling call in live use.
- `isSecret`-style masked answers are not supported (ShipIt's question card has
  no masked input); the bridge schema omits it.
