# Codex App Server Adapter — Design Document

## Overview

The `CodexAdapter` integrates OpenAI's Codex CLI into ShipIt via the Codex App Server's JSON-RPC 2.0 protocol. Unlike the `ClaudeAdapter` (which wraps a PTY-based NDJSON stream), the `CodexAdapter` speaks a structured request/response protocol over stdio, managing thread lifecycle, turn control, and streaming event translation.

This document describes the adapter's architecture, protocol handling, event mapping, and the design decisions that shaped it.

---

## Architecture

```
ShipIt Server (index.ts)
    │
    │  agentFactory("codex")
    ▼
┌────────────────────────────┐
│       CodexAdapter         │  implements AgentProcess
│   (codex-adapter.ts)       │
│                            │
│  ┌──────────────────────┐  │
│  │  JSON-RPC Client     │  │  sendRequest(), sendNotification()
│  │  (request/response)  │  │  pendingRequests Map<id, Promise>
│  └──────────┬───────────┘  │
│             │              │
│  ┌──────────▼───────────┐  │
│  │  JSONL Transport     │  │  stdin: write lines
│  │  (line-buffered)     │  │  stdout: drainLines() parser
│  └──────────┬───────────┘  │
│             │              │
│  ┌──────────▼───────────┐  │
│  │  Notification Handler│  │  item/*, turn/completed, etc.
│  │  → AgentEvent mapper │  │  → emit("event", AgentEvent)
│  └──────────────────────┘  │
└─────────────┬──────────────┘
              │ stdio (pipe)
              ▼
┌────────────────────────────┐
│   codex app-server         │  Child process
│   (JSON-RPC 2.0 server)    │  Long-running, manages threads/turns
└────────────────────────────┘
```

### Contrast with ClaudeAdapter

| Aspect | ClaudeAdapter | CodexAdapter |
|---|---|---|
| Inner process | `ClaudeProcess` (PTY + NDJSON) | `codex app-server` (stdio + JSON-RPC) |
| Wrapping style | Thin wrapper — delegates to existing `ClaudeProcess` | Self-contained — owns the child process directly |
| Process lifetime | One process per turn (spawned and exits) | One process per turn (spawned, handshake, then exits after turn) |
| Protocol | Line-delimited JSON, no framing | JSON-RPC 2.0 with requests, responses, and notifications |
| Session management | `--resume <id>` CLI flag | `thread/start` or `thread/resume` JSON-RPC methods |
| Streaming | Raw NDJSON events on stdout | Server-initiated notifications (no `id` field) |

---

## JSON-RPC Protocol

The Codex App Server uses JSON-RPC 2.0 over JSONL on stdio. Four message types:

- **Client requests** (client → server): `{ method, id, params? }` — expect a response.
- **Responses** (server → client): `{ id, result? }` or `{ id, error: { code, message } }`.
- **Notifications** (server → client): `{ method, params? }` — no `id`, fire-and-forget.
- **Server requests** (server → client): `{ method, id, params? }` — the server asks
  *us* something and blocks the turn until we reply with `{ id, result }`. Approval
  prompts arrive this way (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`).

> **Critical:** a server request and a response are both `id`-bearing, so they MUST
> be distinguished by the presence of a `method` field — a server request has both
> `id` and `method`; a response has `id` only. `handleMessage` checks `hasId &&
> hasMethod` *before* the response branch. Misrouting a server request as a stray
> response drops it on the floor, and the app-server blocks the turn forever
> (`thread/status/changed` flips to `activeFlags: ["waitingOnApproval"]` and the UI
> sits on "Thinking…").

### Approval handling — auto-approve, like Claude

ShipIt runs Codex inside its own session container: the container *is* the sandbox
and the agent operates the box autonomously (CLAUDE.md §5), exactly like the Claude
adapter. `turn/start` sets `approvalPolicy: "never"` + `sandboxPolicy:
dangerFullAccess`, which suppresses *most* prompts — but the model can still request
escalated permissions explicitly, forcing an approval request regardless of policy.
`handleServerRequest` auto-answers every such request:

| Server request method | Reply |
|---|---|
| `item/commandExecution/requestApproval` (v2) | `{ decision: "accept" }` |
| `item/fileChange/requestApproval` (v2) | `{ decision: "accept" }` |
| `execCommandApproval` / `applyPatchApproval` (legacy v1) | `{ decision: "approved" }` |
| anything else (tool input, MCP elicitation) | JSON-RPC error `-32601` (fail fast, never hang) |

Because approvals are auto-answered, Codex never actually blocks on a human and the
UI needs no separate "waiting for approval" state — the `waitingOnApproval` flag is
transient. Decision enums are from the generated schema (`codex app-server
generate-json-schema`).

### Transport layer

```typescript
// codex-adapter.ts — key transport methods

private sendRequest(method, params?)   → Promise<result>   // Stores in pendingRequests map
private sendNotification(method, params?) → void            // Fire-and-forget
private writeJsonRpc(msg)              → void               // JSON.stringify + "\n" to stdin
private drainLines(flush?)             → void               // Buffer stdout, split on "\n", parse JSON
private handleMessage(msg)             → void               // Dispatch: server request → handleServerRequest, response → resolve promise, notification → handleNotification
private handleServerRequest(req)       → void               // Auto-approve approval requests; error on the rest
private sendResponse(id, result)       → void               // Reply to a server request
private sendErrorResponse(id, code, m) → void               // Reply to a server request with an error
```

The `pendingRequests` map (keyed by incrementing `id`) bridges the async request/response pattern. When a response arrives, the matching promise is resolved or rejected.

### Lifecycle sequence

```
CodexAdapter                          codex app-server
    │                                       │
    │──── initialize { clientInfo } ───────►│  (request, id:1)
    │◄─── { result: serverInfo } ──────────│  (response, id:1)
    │──── initialized ─────────────────────►│  (notification)
    │                                       │
    │──── thread/start {} ─────────────────►│  (request, id:2)
    │◄─── { result: { threadId } } ────────│  (response, id:2)
    │                                       │
    │──── turn/start { threadId, input } ──►│  (request, id:3)
    │◄─── { result: { turnId } } ──────────│  (response, id:3)
    │                                       │
    │◄─── thread/started { threadId } ─────│  (notification)
    │◄─── turn/started ───────────────────── │  (notification)
    │◄─── item/agentMessage/delta ─────────│  (notification, streaming text)
    │◄─── item/started ───────────────────── │  (notification, tool call)
    │◄─── item/completed ─────────────────── │  (notification, tool result)
    │◄─── item/agentMessage/delta ─────────│  (notification, more text)
    │◄─── turn/completed { status, usage } ─│  (notification)
    │                                       │
    │──── SIGTERM ─────────────────────────►│  (process killed)
```

For session resume, `thread/resume { threadId }` replaces `thread/start`. If resume fails (thread not found), the adapter falls back to creating a new thread.

---

## Event mapping

The adapter translates Codex streaming notifications into the normalized `AgentEvent` schema that the server and client already understand from Phase 1.

### Notification → AgentEvent

| Codex notification | Condition | AgentEvent |
|---|---|---|
| `item/completed` | `item.role === "assistant"` + content | `agent_assistant` with text blocks |
| `item/completed` | `item.type === "function_call"` | `agent_assistant` with `tool_use` block |
| `item/completed` | `item.type === "function_call_output"` | `agent_tool_result` |
| `item/agentMessage/delta` | `delta.content` has text | `agent_assistant` (streaming text) |
| `turn/completed` | always | `agent_result` (success/error + tokens + duration) |

The `agent_init` event is synthetic — emitted by the adapter after the thread is created, before turn streaming begins. This matches how the server expects to receive a session ID early in the flow.

### Content block mapping

Codex uses `output_text` for its text content blocks; the adapter normalizes both `output_text` and `text` types to the standard `{ type: "text", text }` format.

```
Codex: { type: "output_text", text: "Hello" }  →  AgentEvent: { type: "text", text: "Hello" }
Codex: { type: "text", text: "Hello" }          →  AgentEvent: { type: "text", text: "Hello" }
```

### Tool call mapping

Codex function calls carry JSON-encoded arguments as a string. The adapter parses them:

```
Codex item:
  { type: "function_call", call_id: "call-001", name: "shell", arguments: '{"command":"ls"}' }

AgentEvent:
  { type: "agent_assistant", content: [{
      type: "tool_use", id: "call-001", name: "shell", input: { command: "ls" }
  }]}
```

If `arguments` is malformed JSON, the adapter wraps the raw string as `{ raw: "..." }` rather than crashing.

**Shell command unwrapping.** Codex runs every shell command as
`/bin/bash -lc '<script>'` (the `commandExecution` item's `command` field is that
full invocation). `unwrapShellCommand()` strips the wrapper and one layer of outer
quotes so the tool call reads like Claude's Bash — `ls -la`, not
`/bin/bash -lc 'ls -la'`. Non-wrapped commands pass through untouched. The client
also gives the `shell` tool the same bash syntax-highlighting as `Bash` in the
tool-output modal.

### File change mapping (`fileChange` → `apply_patch`)

A `fileChange` item is surfaced as an `apply_patch` tool call so edits render as
diffs in chat, matching Claude's Edit/Write. Each change is normalized to
`{ path, kind, diff }`. The wire shape is the v2 `FileUpdateChange` (verified
against `codex app-server generate-json-schema`, CLI 0.132.x):

- **`diff`** is a **top-level string** — required by the 0.136.0 schema. Runtime
  verification against `codex-cli 0.136.0` showed completed `fileChange` items
  for new files carry raw file content here, while `turn/diff/updated` carries
  the full unified diff. The adapter normalizes raw `add`/`delete` content into
  all-`+` / all-`-` lines so chat write blocks show line counts and the clickable
  diff affordance. Some app-server builds have emitted path-only `add` changes;
  for that case the adapter reads the just-written file from the session
  workspace and synthesizes the same all-`+` display diff.
- **`kind`** is an **internally-tagged** enum object — `{ type: "add" }`,
  `{ type: "delete" }`, or `{ type: "update", move_path: string | null }` — **not**
  the plain string the field name suggests. Interpolating this object raw was the
  source of the old `[object Object] <path>` rendering. `fileChangeKindLabel()`
  reads `.type` (and tolerates a plain string / single-key object defensively).

```
Codex item (FileUpdateChange):
  { type: "fileChange", id: "fc-1", changes: [
      { path: "src/a.ts", diff: "@@ -1 +1 @@\n-a\n+b", kind: { type: "update", move_path: null } },
      { path: "src/new.md", diff: "# New\ncontent\n", kind: { type: "add" } } ]}

AgentEvent (tool_use):
  { type: "tool_use", id: "fc-1", name: "apply_patch", input: {
      files: ["src/a.ts", "src/new.md"],
      changes: [
        { path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "src/new.md", kind: "add", diff: "+# New\n+content" }] }}
```

The client's `ToolUseItem` renders one `DiffBlock` per change; `DiffBlock`'s
`unifiedDiff` mode counts `+`/`-` lines for the stat and renders the colored hunk
view in its modal. `files` is retained for back-compat (paths only, no diff).

---

## Tool name mapping

Canonical tool names allow the client to render activity labels and diff views without knowing which agent is running. The Codex mapping covers both primary and alias tool names:

| Codex tool | Canonical tool | Notes |
|---|---|---|
| `shell` | `shell` | Primary command execution tool |
| `command` | `shell` | Alias for shell |
| `file_write` | `file_write` | Create/overwrite files |
| `file_read` | `file_read` | Read file contents |
| `file_edit` | `file_edit` | Edit existing files |
| `apply_diff` | `file_edit` | Structured diff application |
| `apply_patch` | `file_edit` | Patch-based file editing |

Defined in `src/server/agents/tool-map.ts`. The `canonicalizeTool("codex", toolName)` function is used by the client's `StreamingIndicator` and `MessageList` components.

---

## Capabilities

The `CodexAdapter` declares its capabilities so the server and UI can gracefully degrade features that Codex doesn't support:

```typescript
{
  supportsResume: true,         // thread/resume in the App Server protocol
  supportsImages: false,        // Codex App Server doesn't accept image input
  supportsSystemPrompt: true,   // Can be passed as turn context
  supportsPermissionModes: false, // No equivalent to Claude's plan/normal/auto modes
  supportedPermissionModes: [],
  toolNames: ["shell", "file_write", "file_read", "file_edit"],
  models: ["codex-mini-latest", "o4-mini", "o3", "gpt-4.1"],
}
```

### Graceful degradation

| Feature | Behavior with Codex |
|---|---|
| Image input | Attachment button disabled; images not sent |
| Permission modes | Mode picker hidden; all tools available |
| Cost tracking | Not reported by Codex; shows "N/A" in usage |
| Session resume | Supported via `thread/resume` |
| Token counts | Reported in `turn/completed` usage field when available |

---

## Authentication

Codex uses `OPENAI_API_KEY` as an environment variable. The adapter checks for this before spawning the process:

```typescript
if (!env.OPENAI_API_KEY) {
  this.emit("auth_required");
  return;
}
```

Auth errors detected from stderr (e.g. "Invalid API key", "unauthorized") also trigger `auth_required`, which the server relays to the client's `AuthOverlay`.

---

## Server integration

The `agentFactory` in `src/server/index.ts` dispatches on agent ID:

```typescript
const agentFactory = deps.agentFactory ?? ((agentId: AgentId) => {
  switch (agentId) {
    case "codex":
      return new CodexAdapter();
    case "claude":
    default:
      return new ClaudeAdapter(claudeFactory());
  }
});
```

The per-connection `activeAgentId` state (set via the `set_agent` WebSocket message) determines which adapter is instantiated for each `send_message`. The server event handling is fully agent-agnostic — it listens for `AgentEvent` and relays `agent_event` messages regardless of which adapter emitted them.

---

## Key files

| File | Purpose |
|---|---|
| `src/server/agents/agent-process.ts` | `AgentProcess` interface, `AgentEvent` types, `AgentCapabilities` |
| `src/server/agents/codex-adapter.ts` | Codex App Server JSON-RPC adapter (330 lines) |
| `src/server/agents/claude-adapter.ts` | Claude CLI adapter (thin wrapper, for comparison) |
| `src/server/agents/tool-map.ts` | Canonical tool name mapping for all agents |
| `src/server/index.ts` | `agentFactory` dispatch, `set_agent` handler, event relay |
| `src/server/agents/codex-adapter.test.ts` | 23 unit tests — protocol handshake, event mapping |
| `src/server/integration_tests/codex-agent.test.ts` | 10 integration tests — agent switching, message flow |

---

## Testing strategy

### Unit tests (`codex-adapter.test.ts`)

Mock `child_process.spawn` to return a `FakeChildProcess` with controllable stdin/stdout. Tests verify:

- JSON-RPC handshake sequence (initialize → initialized → thread/start → turn/start)
- Thread resume vs new thread creation
- Event mapping for all Codex item types (assistant messages, function calls, function call outputs, deltas)
- Turn completion with success and error statuses
- Token/usage data pass-through
- Auth detection (missing API key, stderr errors)
- Malformed JSON argument handling
- Process lifecycle (kill, done events)

### Integration tests (`codex-agent.test.ts`)

Use `FakeCodexProcess` (implementing `AgentProcess` directly) injected via `agentFactory` into `buildApp()`. Tests verify the full server flow:

- `set_agent` → `send_message` routes to correct adapter
- Invalid agent IDs return errors
- Agent events are relayed to WebSocket clients as `agent_event` messages
- Agent switching (Codex → Claude → Codex) works within a connection
- Error events are properly relayed
- Default agent is Claude when no `set_agent` is sent

---

## Design decisions

### Why spawn `codex app-server` instead of `codex` directly?

The Codex App Server is the official programmatic interface. Unlike the CLI's TUI mode, it provides a stable JSON-RPC protocol designed for integration — with structured thread management, streaming events, and no terminal escape codes to strip. All Codex surfaces (VS Code, desktop app, web) use this same protocol.

### Why kill the process after each turn?

ShipIt's architecture creates a fresh `AgentProcess` for each user message (matching the one-shot-per-turn pattern established by `ClaudeAdapter`). While the App Server supports multiple turns within a single process, keeping the lifecycle simple avoids state management complexity. Thread persistence means a future turn can `thread/resume` to continue the conversation.

### Why is `agent_init` synthetic?

The Codex App Server doesn't emit an explicit "session started" event like Claude's `system` event. The adapter emits `agent_init` after the handshake completes so the server's session-tracking logic (which keys on `agent_init` to store the agent session ID) works identically for both adapters.

### Why not use PTY for Codex?

Claude CLI requires a PTY because it detects piped stdin and changes behavior. The Codex App Server is designed for stdio pipe communication — PTY would add overhead and break the clean JSON-RPC framing.
