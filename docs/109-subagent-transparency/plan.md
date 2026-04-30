---
status: planned
---

# 109 — Subagent / Task Tool Transparency

## Summary

When the agent invokes the `Task` tool to spawn a subagent, render the subagent's prompt and its returned report inline in the chat as a collapsible nested message group. Today these calls show up as opaque "Task: <description>" tool invocations whose internals are invisible. Conductor v0.23.0 / v0.34.1 fixed this with subagent prompt visibility and "agent swarm" rendering.

## Motivation

The Task tool is one of Claude's most powerful primitives — it's how Claude does fan-out research, parallel implementation, multi-step investigations. ShipIt currently displays:

```
🔧 Task
  description: "Audit ShipIt for review features"
  → (large opaque blob)
```

The user can't tell:

- What prompt the subagent was given (was it precise? did it inherit useful context?).
- What the subagent reported back (the synthesized result).
- Whether the parent's summary of the subagent's work is faithful to what the subagent actually said.

Without this, Task feels like a black box and users default to single-agent prompts when subagents would be more efficient.

## Design

### Where the data lives

The Claude Code CLI emits subagent calls as nested `agent_assistant` / `agent_tool_call` / `agent_tool_result` events with a parent-child relationship via the tool-use id. `claude.ts` (in `src/server/session/`) already parses these events; today they get rolled into the parent's tool-result blob.

Two fields we already see on the wire and can capture:

- `tool_use.input.prompt` — the prompt sent to the subagent.
- `tool_result.content` — the subagent's final report (markdown).

### UI

In the message renderer (`MessageList.tsx`'s tool-call component), Task tool invocations get a new collapsible structure:

```
▶ Subagent · Audit ShipIt for review features
   ├─ Prompt (click to expand)
   ├─ ▶ Subagent's work
   │     [event 1] read foo.ts
   │     [event 2] grep pattern…
   │     [event 3] wrote summary…
   └─ Final report (markdown rendered)
```

Three disclosure levels:

1. **Header** — always visible, shows description and runtime.
2. **Prompt** — collapsed by default, click to expand. Renders as fenced markdown.
3. **Subagent's work** — collapsed by default. Expands to show the nested tool calls (file reads, greps, edits) the subagent performed. This is the "swarm" view.
4. **Final report** — always visible (it's the actionable bit), rendered as markdown.

### How nested events get captured

`claude.ts` currently flattens nested events. Change: stream them with their `parentToolUseId` preserved so the client can re-tree them.

- Extend `AgentEvent` type with `parentToolUseId?: string`.
- The orchestrator's `agent-listeners.ts` doesn't drop nested events — it forwards them through. The client's message-grouping layer trees them by parent id.

### Live updates

While the subagent runs, the "Subagent's work" subtree streams in real time — user sees each tool call land. Same SSE pipeline as parent agent events.

### Cost & duration

Show per-subagent duration and token usage in the header (using the per-turn usage data from [105](../105-context-window-display/plan.md)). Lets users see when a subagent is over-spending.

## Server pieces

- `src/server/session/claude.ts`: preserve `parentToolUseId` on emitted events instead of collapsing.
- `src/shared/types/agent-types.ts`: add `parentToolUseId?: string` to relevant events.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts`: forward nested events as-is. Don't try to merge into parent's result.

## Client pieces

- New component: `src/client/components/ToolCall/SubagentCall.tsx` (replaces the generic Task rendering when `tool_name === 'Task'`).
- New util: `src/client/utils/group-events-by-parent.ts` — trees a flat list of events by `parentToolUseId`.
- Extend `MessageList`'s grouping to handle the nested tree.

## Persistence

Chat history must preserve the parent-child structure so reloading shows the same tree. Already-flat sessions (pre-feature) display the legacy opaque rendering. New events are written with `parentToolUseId`.

## Tests

`integration_tests/subagent-transparency.test.ts`:

1. FakeClaude emits a Task tool call with nested events → client receives them with parent ids → renders nested tree.
2. Reload → nested structure persists from chat history.
3. Final report renders even before subagent finishes (incremental); subagent's work tree fills in live.

Component tests for `SubagentCall` covering each disclosure level.

## Key files

| File | Change |
|---|---|
| `src/shared/types/agent-types.ts` | `parentToolUseId` |
| `src/server/session/claude.ts` | Stop flattening nested events |
| `src/server/orchestrator/ws-handlers/agent-listeners.ts` | Forward nested events |
| `src/server/orchestrator/chat-history.ts` | Persist parent ids |
| `src/client/components/ToolCall/SubagentCall.tsx` | New component |
| `src/client/utils/group-events-by-parent.ts` | New util |
| `src/client/components/MessageList.tsx` | Use treed rendering for Task |

## Future extensions

- **Pause / cancel a running subagent** without canceling the parent turn.
- **Re-run a subagent** with a tweaked prompt without rerunning the parent.
- **Compare two subagent runs** side-by-side (helpful when fanning out the same task to two models).
