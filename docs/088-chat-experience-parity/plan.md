---
status: done
---

# ShipIt Chat Experience Parity Design

## Purpose

This document describes how to reproduce ShipIt's chat UX in another application, including:

- Message rendering and visual grouping
- Markdown/code formatting behavior
- Tool call/result presentation
- Streaming and queue behavior
- WebSocket interaction patterns and message contracts
- History persistence/reload semantics

It is written as an implementation blueprint, not just a high-level architecture note.

## 1) System model to replicate

ShipIt chat behavior depends on three cooperating parts:

1. **Client rendering pipeline** (`MessageList` + helper components)
2. **Client event reducer** (`useMessageHandler`) that maps WS events into UI state
3. **Server turn lifecycle** (`send-message` + `agent-listeners`) that emits events and persists grouped messages

To recreate the same UX, keep this same separation of concerns:

- **Server owns turn semantics** (streaming boundaries, queueing, persistence checkpoints)
- **Client owns display semantics** (grouping visuals, markdown/code rendering, controls)
- **Shared typed protocol** defines exact payloads for consistency

## 2) Canonical chat message model

Rebuild your local message state around ShipIt's `ChatMessage` shape:

```ts
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  images?: { data: string; mediaType: string; src?: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  streaming?: boolean;
  isError?: boolean;
  queued?: boolean;
  queuePosition?: number;
  commitHash?: string;
  parentCommitHash?: string;
  uploadPaths?: string[];
  rolledBack?: boolean;
}
```

Notes for parity:

- `streaming` is transient UI state (never shown as persisted `true` after finalized turns).
- `toolUse` and `toolResults` are attached to assistant messages and matched via `toolUseId`.
- `commitHash`/`parentCommitHash` power rollback affordances on assistant bubbles.
- `rolledBack` dims old messages without deleting them.

## 3) Transport and protocol contracts

### 3.1 Client → server messages to support

Minimum WS message set to replicate behavior:

- `send_message` (text + optional files/uploads/permission mode)
- `answer_question` (for AskUserQuestion tool)
- `interrupt_claude`
- `cancel_queued_message`
- `rollback_code`, `rollback_code_and_chat`, `fork_session_from_message`
- `rewind_to_message`
- `set_agent`, `set_model`

Design choice to preserve: **send prompt traffic through per-session WebSocket** so streaming updates are naturally coupled with request/response lifecycle.

### 3.2 Server → client messages to support

Required for parity:

- `agent_event` (`agent_assistant`, `agent_tool_result`, `agent_result`)
- `chat_history`
- `message_queued`, `queue_updated`
- `session_status`
- `error`, `claude_interrupted`
- `commit_linked`, `rollback_complete`, `rewind_complete`, `session_forked`
- plus surrounding app events (preview/git/file updates) as needed

Implementation guidance:

- Keep a discriminated union `type` field for every message.
- Parse and route via a single reducer-like handler on client.

## 4) Streaming event handling (client)

ShipIt's `useMessageHandler` behavior is the core of “feels like ShipIt”.

### 4.1 Assistant delta handling (`agent_assistant`)

For each event:

1. Concatenate all `text` blocks in content.
2. Collect all `tool_use` blocks.
3. Update activity label:
   - if tools present → tool-derived label
   - else if text present → "Thinking..."
4. Merge into last assistant message **iff** last is `streaming` assistant and has no tool results (with a special standalone-tool merge exception).
5. Otherwise close any previous streaming assistant messages and append a new streaming assistant message.

This produces continuous typing + tool additions in one bubble until a boundary is hit.

### 4.2 Tool result handling (`agent_tool_result`)

- Parse `tool_result` blocks, normalize content to string.
- Truncate oversize tool output (ShipIt caps at 1MB in client).
- Append results to the latest assistant message's `toolResults`.
- Set activity to "Processing results...".

### 4.3 Turn completion (`agent_result`)

- `isLoading = false`
- clear activity
- mark all streaming assistant messages as `streaming: false`
- emit a completion notification

### 4.4 Error paths

- On `error`, close streaming state and append assistant error bubble (`isError: true`).
- On WS disconnect during active load, inject a connection-lost error bubble.
- On `claude_interrupted`, close streaming and append interruption note to in-flight assistant message.

## 5) Visual rendering pipeline

### 5.1 Build visual elements before rendering

ShipIt does not render `messages[]` directly. It transforms to `VisualElement[]` with kinds:

- `message`
- `tool-group`
- `subagent`
- `standalone-tool`

Why this matters:

- Consecutive groupable assistant tools are collapsed into compact scrolling groups.
- Subagent tools (`Task`, `Skill`, `Agent`) render as separate left-bordered blocks.
- Standalone interaction tools (`AskUserQuestion`, `ExitPlanMode`) can render outside empty bubbles.

If you skip this transform step, output will look functionally similar but not behaviorally equivalent.

### 5.2 Bubble/layout rules

- User messages: right aligned, rounded accent bubble.
- Assistant messages: left/full-width textual content without solid bubble background.
- Rolled-back messages: `opacity` reduced.
- Queued user messages show spinner + queue position badge text.
- Hover toolbar appears per message for rewind/rollback actions.

### 5.3 Loading indicators

- Inline typing dots appear at end of currently streaming assistant text.
- Separate thinking indicator appears when waiting for first response or active tool execution.

## 6) Markdown and code formatting

To match ShipIt output style:

1. Render assistant text via `marked` configured with `breaks: true`, `gfm: true`.
2. Custom renderer for fenced code blocks:
   - optional language header row
   - highlighted code using `highlight.js`
   - themed container surface and small monospace typography
3. Non-markdown fallback path for plain/user/error text keeps whitespace with `whitespace-pre-wrap`.
4. Search highlighting must work across text and code-segment offsets (ShipIt parses segments with source offsets).

Security note for ports:

- ShipIt uses `dangerouslySetInnerHTML` for markdown; if reproducing in a new security context, add sanitization (e.g., DOMPurify) while preserving class hooks.

## 7) Tool rendering semantics

Implement tool-specific UX decisions:

- `Edit` / `Write` → render as inline diff blocks (not generic tool lines)
- `AskUserQuestion` → interactive question card; submit sends `answer_question`
- `ExitPlanMode` → plan approval card; submit sends follow-up message
- `TodoWrite` → hidden inline; latest todos render in dedicated `TodoPanel`
- Other tools → compact one-line log row + “Show output” modal

This mapping is essential for high-fidelity parity.

## 8) Input behavior parity

`MessageInput` parity checklist:

- Enter submits, Shift+Enter newline
- drag/drop and paste image upload
- pending file chips + upload chips
- `@` file autocomplete based on workspace tree/uploads
- plan mode toggle / permission mode support
- model + agent selector in composer
- interrupt button replaces send while running
- focus restoration on session switch/new session

## 9) Queue semantics to preserve

When server emits `message_queued`:

- add entry to visible queue list
- remove optimistically added matching user message from chat
- stash removed message in map keyed by text

When server emits `queue_updated` with `dequeued`:

- restore stashed user message at end of conversation (after completed turn)
- clear `queued` flags

This detail is why queued prompts appear ordered correctly relative to assistant turns.

## 10) Server-side turn lifecycle required for parity

### 10.1 Send flow

On `send_message` server should:

1. validate auth/attachments
2. queue if already running
3. ensure active session/runner
4. start agent process
5. wire event listeners for this turn

### 10.2 Message-group persistence boundary logic

ShipIt persists assistant output as **message groups** split at tool-result boundaries:

- `agent_assistant` accumulates text/tool_use into current group
- `agent_tool_result` marks boundary for next group and attaches results to current group
- each boundary triggers `replaceInProgress(...)` persistence
- `agent_result` finalizes groups and clears `inProgress`

This guarantees that reloaded history has the same bubble boundaries as live streaming.

### 10.3 Standalone tool merge rule

Special-case merge keeps `ExitPlanMode`/`AskUserQuestion` with preceding plan text when needed, preventing detached empty bubbles after reload.

## 11) Persistence and hydration

ShipIt persistence layer stores messages in DB with optional fields for tools/images/files/results and `in_progress` marker.

Hydration pattern to copy:

- On WS open: fetch `/api/sessions/:id/history` over HTTP.
- Load persisted messages into client store as non-streaming.
- Continue live WS updates on top.
- Ignore stale WS session-scoped events during session switches.

## 12) Styling system requirements (for visual match)

- Tailwind utility classes with semantic CSS tokens (`--color-*`) rather than raw color constants
- dark surface hierarchy (`bg-primary`, `bg-secondary`, `bg-elevated` semantics)
- prose markdown styling + syntax highlight theme
- subtle borders and low-contrast tool logs
- small typography scale (`text-xs`/`text-sm`) with compact spacing rhythm

If porting to a different design system, preserve **semantic roles** (accent bubble, subdued tool rows, elevated modals) even if token names differ.

## 13) Rebuild blueprint (implementation order)

1. **Define shared WS types** for client/server.
2. **Implement chat store** with ShipIt-compatible `ChatMessage` fields.
3. **Implement server turn runner** with queue + message-group persistence.
4. **Implement client WS reducer** (`agent_assistant`, `agent_tool_result`, `agent_result`, queue, rollback/rewind).
5. **Implement `buildVisualElements()` transform**.
6. **Build renderer** (`MessageList`, tool components, markdown pipeline).
7. **Build composer** (`MessageInput`, uploads, file refs, mode selectors).
8. **Add history hydration + stale-event guards**.
9. **Add rewind/rollback controls + handlers**.
10. **Tune spacing/colors/motion to tokenized dark theme**.

## 14) Verification checklist for parity

- Streaming assistant text merges into a single live message until boundary events
- Tool calls compact into grouped rows and can open full output modal
- AskUserQuestion and Plan approval are interactive inline elements
- Queueing removes optimistic user message and re-inserts when dequeued
- Reloaded session preserves same message boundaries as live view
- Rollback/rewind controls appear only on eligible messages
- Markdown and code blocks visually match (headers, syntax highlighting, spacing)
- Disconnect/interruption states are clearly represented in chat

## 15) Key source files audited

Client rendering and input:

- `src/client/components/MessageList.tsx`
- `src/client/components/visual-elements.ts`
- `src/client/components/message-markdown.tsx`
- `src/client/components/message-tools.tsx`
- `src/client/components/MessageInput.tsx`

Client transport/reducer:

- `src/client/hooks/useWebSocket.ts`
- `src/client/hooks/useConnectionSync.ts`
- `src/client/hooks/useMessageHandler.ts`

Server protocol and lifecycle:

- `src/server/shared/types/ws-client-messages.ts`
- `src/server/shared/types/ws-server-messages.ts`
- `src/server/orchestrator/ws-handlers/send-message.ts`
- `src/server/orchestrator/ws-handlers/agent-listeners.ts`
- `src/server/orchestrator/chat-history.ts`
