---
issue: https://linear.app/shipit-ai/issue/SHI-276
title: Subagent transparency
description: Render a subagent's prompt, work timeline, and final report inline instead of an opaque tool call.
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
| `src/client/components/MessageList/MessageToolUse.tsx` | Route subagent tools to `SubagentCall` |
| `src/server/shared/transcript-slice-tools.ts` | `SUBAGENT_TOOL_NAMES` (layout) + `SUBAGENT_REPORT_TOOL_NAMES` (report / slice exemption) |
| `src/server/orchestrator/transcript-projection.ts` | Exempt the report set from docs/244 slicing |

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
  user toggle wins), and the markdown final report. `MessageToolUse` swaps the
  legacy "Subagent: <description>" strip for `SubagentCall` whenever the tool
  name is in `SUBAGENT_REPORT_TOOL_NAMES` (`Task`, `Agent`) — see
  [What actually shipped broken](#what-actually-shipped-broken-and-the-fix);
  gating this on the literal `"Task"` is what kept the feature dark.
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
- **Codex spawn-agent rendering.** Codex surfaces subagent orchestration as
  `collabToolCall` items with tool names like `spawn_agent`. `CodexAdapter`
  normalizes `spawn_agent` into ShipIt's existing `Agent` tool-use shape
  (`subagent_type`, `description`, `prompt`) so the client extracts it into
  the same standalone subagent block instead of grouping it with ordinary
  shell/read/edit tools. Other collab tools (`send_input`, `wait_agent`,
  `close_agent`, etc.) still render as regular tool calls.

## What actually shipped broken (and the fix)

Everything above describes the design as if it worked. It did not. From the day
this feature shipped until the fix below, **no subagent's work was ever visible
in the ShipIt transcript.** The user saw a subagent get called, then nothing,
then the main agent acting on results they never saw.

### The gate mismatch

`MessageToolUse.tsx` routed to `SubagentCall` only when the tool was named
**`Task`**:

```jsx
if (tool.name === "Task") { return <SubagentCall … subagentEvents={…} /> }   // the real view
if (tool.name === "Agent") { … return <div>{label}{description}{prompt}</div> }  // never reads subagentEvents
```

**The Claude Code CLI emits the tool as `Agent`, not `Task`.** Verified directly
against CLI 2.1.219 by running the same invocation ShipIt uses
(`claude -p … --output-format stream-json --verbose`) and reading the raw NDJSON:

```
assistant :: tool_use[Agent] id=toolu_01B8iW…
  input = {description, prompt, subagent_type, run_in_background}
assistant PARENT=toolu_01B8iW… :: tool_use[Bash] id=toolu_012fPv…
user     PARENT=toolu_01B8iW… :: tool_result for=toolu_012fPv…
user                          :: tool_result for=toolu_01B8iW…   ← the final report
```

So every real subagent call took the second branch, which renders a label, a
description and the prompt — and drops `subagentEvents` on the floor.

Nothing else in the pipeline was wrong. `ClaudeAdapter.mapEvent` maps
`parent_tool_use_id` on both event types, `agent-listeners.ts` routes nested
events into the parent group's `subagentEvents`, and the message builder
attaches them. The data arrived at the client correctly and was then discarded
by the renderer.

### Why the tests stayed green

`integration_tests/subagent-transparency.test.ts` injected **synthetic** events
named `Task` into a fake CLI process — a name the real CLI never sends. It
exercised the one branch production never reached, so the suite proved the
feature worked on an input that does not exist. The tests now use `Agent`, and
`MessageList.test.tsx` carries the client-side regression cases (they fail
against the pre-fix renderer).

This is the general hazard: a fake that invents its own protocol constants can
only ever test the fake. Where a fixture stands in for an external CLI, the
constants in it should be copied from a captured real run.

### The fix

One shared set replaces the hardcoded name, and the two jobs the old
`SUBAGENT_TOOL_NAMES` was doing get split apart
(`src/server/shared/transcript-slice-tools.ts`):

| Set | Members | Job |
|---|---|---|
| `SUBAGENT_TOOL_NAMES` | `Task`, `Skill`, `Agent` | **Layout** — render as a standalone top-level element rather than inside the clipped tool-call group. |
| `SUBAGENT_REPORT_TOOL_NAMES` | `Task`, `Agent` | **Report** — route to `SubagentCall` *and* exempt the result body from docs/244 slicing. |

`MessageToolUse` gates on the report set; `transcript-projection` exempts the
report set. Reading the same constant is what makes them unable to drift: a name
that renders a full report but gets sliced loses text irrecoverably, and a name
that is exempted but renders nothing ships an unbounded body for no reason.

### The three design decisions

1. **`Agent` routes into `SubagentCall`, and nothing is dropped.** The CLI's
   `Agent` input is `{description, prompt, subagent_type}` — exactly the fields
   `SubagentCall` already reads. The header renders
   `Subagent (general-purpose): <description>`, covering both fields the old
   strip showed. The only change for a user is that the prompt moves from an
   always-visible clipped preview into the same collapsed disclosure `Task`
   used, which is the consistent treatment.

2. **`Task` is kept, not deleted.** Chat history persists tool names verbatim
   (`chat-history.ts` → the `tool_use` JSON column), so sessions recorded before
   this fix still hold `Task` rows and must keep rendering. It is dead on the
   live path and alive on the reload path.

3. **`Skill` stays compact and loses its slice exemption.** Verified against CLI
   2.1.219: an in-context skill invocation emits **no** nested
   `parent_tool_use_id` events and a ~33-character `tool_result` (a
   base-directory acknowledgement) — the skill's actual content arrives as a
   separate top-level user message, not as a report under the tool. There is no
   work timeline and no report to disclose, so `SubagentCall` would draw an
   empty shell. Meanwhile the old exemption meant `Skill` bodies were exempt
   from *every* size bound while rendering nothing — an unbounded payload
   shipped for no reader (the docs/244 finding). Removing `Skill` from the
   report set fixes both halves.

   *Not verified:* whether a **subagent-backed** skill (one the CLI runs in its
   own agent) attaches nested events to the `Skill` tool id. The observable
   evidence points away from it — a background skill returns an agent name and
   its result arrives as a separate task notification — but this was not
   exercised against a live run. If such a shape turns up, the fix is to add
   `Skill` to `SUBAGENT_REPORT_TOOL_NAMES` and give `SubagentCall` a skill-shaped
   header; the sets exist precisely so that is a one-line change.

### Verified how

- Raw CLI NDJSON captured from a live `claude -p` run (above) — the tool name,
  the input shape, and the `parent_tool_use_id` threading.
- A real browser render of the real `MessageList` against the captured event
  shape, showing all four disclosure layers for an `Agent` call: header +
  status badge, collapsed prompt, expanded work timeline with the subagent's
  own `Bash` call, and the markdown final report.
- Client regression tests that fail against the pre-fix renderer.

## Future extensions

- **Pause / cancel a running subagent** without canceling the parent turn.
- **Re-run a subagent** with a tweaked prompt without rerunning the parent.
- **Compare two subagent runs** side-by-side (helpful when fanning out the same task to two models).
