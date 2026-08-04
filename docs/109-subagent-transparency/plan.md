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

> **The report is not always a markdown string** (SHI-287). The CLI delivers it
> as a **JSON-encoded block array** whenever the reply has more than one block —
> which is the normal case, because the CLI appends its own
> `agentId` / `subagent_tokens` / `tool_uses` / `duration_ms` footer after the
> report. The renderer handed that string straight to `MarkdownContent` for as
> long as this feature has existed, so a real subagent turn showed the user
> `[{"type":"text","text":"…"}]` with escaped newlines. `parseSubagentReport`
> now splits it: the text blocks become the report, and a recognized footer is
> demoted out of the prose (since 2026-08-04, into the header chips).
>
> Not a docs/244 regression, though it surfaced during that feature's
> verification: at the time, the lazy-body projection **exempted** subagent
> reports, so the renderer received byte-for-byte what it always did. That
> exemption is gone — see *The final report* below.

### The final report

Requirements: [`requirements.md`](./requirements.md). Visual reference:
[`mockup-final-report.html`](./mockup-final-report.html) — current-vs-proposed
for four report shapes.

The report is the part of the card a reader actually reads, and until 2026-08-04
it was the least designed part of it: undifferentiated body text at full
transcript width, glued to the bottom of the card, with the CLI's accounting
footer printed underneath as a raw `key: value` blob. `SubagentReport.tsx` now
owns it.

**A backgrounded subagent has no report, and saying it does was a content bug**
(reqs 1–2). A `run_in_background` Task returns the CLI's *launch
acknowledgement* — an `agentId` to resume with, an output-file path, and an
instruction never to quote any of it — and the card rendered that verbatim under
**FINAL REPORT** while stamping the header `done` for a subagent that was still
running. `isBackgroundLaunchAck` recognizes it and the card shows a running row
instead, with an `in background` badge. The recognizer needs the opening
sentence **and** a structural corroborator (`agentId:` or `output_file:` on its
own line), because the CLI owns that string and a false positive would hide a
real report — this repo's own docs quote the sentence.

**The report is quoted output, so it reads like it** (reqs 3–5). A bordered
panel with a label row separates it from the parent agent's prose; the
accounting footer becomes duration / tools / tokens chips on that row, and
`agentId` is dropped in `parseReportMeta` rather than at the render site, so
there is one place to check it cannot reach the DOM. The markdown scale is
deliberately flattened — every heading level renders at the body size — because
a subagent's `#` otherwise renders larger than anything in the conversation
containing it.

**Long reports clamp, and the full one opens in a modal** (reqs 6–8). The clamp
is a max-height with a fade rather than a line count: the body is rendered
markdown, so a table or a fenced block is far taller than its source lines
suggest.

That modal is what let the report **leave the docs/244 exemption set**. The
exemption's stated premise was that the transcript "renders it in full with no
expand affordance and no fetch path", so cutting it destroyed text with no way
back — a click and a fetch is exactly what removes that premise. So:

* `WHOLE_RESULT_TOOL_NAMES` is now `AskUserQuestion` alone.
* `projectToolResult` sends the report tools through `sliceSubagentReport`,
  which is a *separate* slice for a load-bearing reason: a report's normal
  encoding is a `JSON.stringify`'d block array, i.e. **one line**, so the
  generic line cap never fires and the byte backstop cuts mid-array — leaving
  JSON the client cannot parse and renders verbatim, which is SHI-287 arriving
  by a second route. The report slice clamps the *text inside* the blocks and
  rebuilds the structure, keeping the footer whole because the chips it feeds
  are visible without a click.
* `rendersResultContentInline` stays **true** for report tools. The clamped head
  is drawn with no click, so the body is bounded rather than emptied the way a
  modal-only result is.
* The modal fetches from the existing `/api/sessions/:id/tool-results/:toolUseId`.
  A report is a *top-level* tool result, committed in the same tick as its emit
  (`agent-listeners.ts`), so opening the modal on the turn that produced it
  cannot outrun the write.

If the modal is ever removed, the report has to go back into
`WHOLE_RESULT_TOOL_NAMES` — that set's docstring says so, and
`tool-result-slice.test.ts` pins the pairing.

**Where requirement 8 is deliberately relaxed.** A *nested* report — the final
report of a subagent's own subagent — is sent whole on the **live** path, on
both sides. The independent review flagged it as a requirement-8 shortfall,
correctly; it stands because the alternatives are worse, not because it was
missed:

* The projection cannot slice it, because a nested result skips
  `replaceInProgress` entirely (the `parentToolUseId` branch of the
  `agent_tool_result` handler returns before it), so its row is not on disk and
  the fetch behind the slice would 404.
* The client cap cannot cut it either. Capping without marking destroys the tail
  with no affordance to recover it; marking without fetchability promises the
  404 above.

So it ships whole for the life of that turn's view and is bounded properly on
the next history load, where the row **is** committed. The requirement's own
wording is what makes this a relaxation rather than a violation — it says only
the clamped part *needs* to be sent, and requires that nothing be permanently
lost. Nothing is: the persisted row is always whole, and
`/tool-results/:toolUseId` scans `subagent_events` too.

Two further review findings that shaped the code rather than the docs: a
**lone** footer-shaped block is now treated as the footer (it used to render as
prose, which put `agentId` on screen for a subagent that returned nothing but
accounting), and `sliceSubagentReport` rebuilds the block array **in place**
(an earlier version emitted a fresh `[text, meta]` pair, which deleted any image
the subagent had returned). Image substitution runs before the clamp, so a
report carrying a screenshot is bounded on both axes.

One shortfall is **not** addressed here and is recorded in `checklist.md`: a
nested report renders through the generic `ToolResult` path, not `SubagentCall`,
so it shows raw block JSON including the footer and needs two clicks to open.
That predates this change.

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
3. **Subagent's work** — collapsed by default, in every state (running and finished alike). The toggle carries a live action count, so the collapsed row still says "something is happening" without spending the vertical space. Expands to show the nested tool calls (file reads, greps, edits) the subagent performed. This is the "swarm" view.
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
| `src/client/utils/group-events-by-parent.ts` | New util. `parseSubagentReport` (SHI-287) moved to `server/shared/subagent-report.ts` and is re-exported here |
| `src/client/components/MessageList/MessageToolUse.tsx` | Route subagent tools to `SubagentCall` |
| `src/client/components/SubagentReport.tsx` | The report itself: background-launch row, panel, chips, clamp, modal, lazy fetch |
| `src/server/shared/subagent-report.ts` | Isomorphic report code — `parseSubagentReport` (structural parse: `startsWith("[")` → `JSON.parse` → inspect block types, matching `parseContentForImages`; the footer has no structural marker, so it is recognized narrowly — last block only, every line a `key: value` with a known key — because a false positive would eat someone's report), `parseReportMeta`, `isBackgroundLaunchAck`, `sliceSubagentReport` |
| `src/server/shared/transcript-slice-tools.ts` | `SUBAGENT_TOOL_NAMES` (layout) + `SUBAGENT_REPORT_TOOL_NAMES` (report / report-shaped slice) |
| `src/server/orchestrator/transcript-projection.ts` | Route the report set through `sliceSubagentReport` |

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
  (collapsed), work timeline (collapsed — see
  [The work timeline's default state](#the-work-timelines-default-state)), and
  the markdown final report. `MessageToolUse` swaps the
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

## The work timeline's default state

The work disclosure has been through three defaults, and the current one is
deliberate:

1. **Auto-collapse on the final report** (shipped first) — expanded while
   streaming, collapsed the moment the subagent finished. Wrong because it
   yanked content away mid-read: the tool calls and per-step narration
   disappeared exactly when the user went to look at them.
2. **Always expanded** — fixed (1) by never collapsing. Wrong for the opposite
   reason: a subagent's timeline is long, and the reader is following the
   *parent's* conversation. A turn with two or three concurrent subagents
   buried the main transcript under nested tool calls nobody had asked to see.
3. **Always collapsed** (current) — the timeline is opt-in in every state.

What makes (3) work rather than just hiding things is that the collapsed row is
not silent: the toggle reads `Subagent's work (N actions)` and **N ticks up
live** as the subagent streams, next to the header's `working…` spinner. The
reader sees that work is happening and how much of it, and opens the caret when
they want the detail. The user override (`userOverride ?? false`) still wins for
the lifetime of the card, so expanding is sticky within a session view.

The prompt and the final report are unaffected: the prompt was always collapsed,
and the report stays always-visible — it is the actionable output, and it is
what the parent agent itself acts on.

## Future extensions

- **Pause / cancel a running subagent** without canceling the parent turn.
- **Re-run a subagent** with a tweaked prompt without rerunning the parent.
- **Compare two subagent runs** side-by-side (helpful when fanning out the same task to two models).
