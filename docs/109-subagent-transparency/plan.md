---
status: done
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

## Implementation notes (post-shipping)

The shipped implementation matches the plan with a few clarifications:

- **Where the parent id flows.** Claude CLI's raw `assistant` and `user`
  events carry a top-level `parent_tool_use_id`. `ClaudeAdapter.mapEvent`
  copies it onto the normalized `AgentEvent` as `parentToolUseId`. The
  container path is unchanged — the worker re-uses the same adapter and the
  field rides through SSE intact.
- **Server-side splitting.** `agent-listeners.ts` checks `parentToolUseId` on
  each `agent_assistant` and `agent_tool_result` event. Nested events are
  attached to the parent group's `subagentEvents` array (a new
  `ChatMessageGroup` field) instead of being merged into the main
  `toolUse` / `toolResults` flow. Migration 10 adds a `subagent_events` JSON
  column to `messages` so reloads see the same tree.
- **Client tree rendering.** `groupEventsByParent` (new util) trees the flat
  list of subagent events by parent id. `SubagentCall.tsx` (new component)
  renders the four disclosure layers from the plan: header, prompt
  (collapsed), work timeline (auto-collapses once the final report arrives —
  user toggle wins), and the markdown final report. `MessageList` swaps the
  legacy "Subagent: <description>" strip for `SubagentCall` whenever it sees
  a Task tool.
- **Live updates.** The "work" view streams in real time because each nested
  `agent_event` is emitted to viewers via the same `runner.emitMessage`
  path. The renderer just attaches each new event to the parent message in
  the live messages array.
- **Per-subagent duration / token usage in the header is not yet wired up.**
  The Claude CLI does not expose per-subagent usage in its event stream
  (only the parent turn's totals via `agent_result`). The header will gain a
  cost/duration chip if/when a future CLI version surfaces it; the current
  data flow is set up to plumb it through if it appears on the event.
- **Backward compatibility.** Pre-feature sessions persist with
  `subagent_events = NULL` and render via the same `SubagentCall` —
  `groupEventsByParent` returns an empty map, so the work / final-report
  panels simply don't appear, leaving the header + collapsed prompt as the
  visible state. No data migration is required.

## Future extensions

- **Pause / cancel a running subagent** without canceling the parent turn.
- **Re-run a subagent** with a tweaked prompt without rerunning the parent.
- **Compare two subagent runs** side-by-side (helpful when fanning out the same task to two models).
