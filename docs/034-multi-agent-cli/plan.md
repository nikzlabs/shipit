
# 034 — Multi-Agent CLI Support (Codex, Gemini, etc.)

## Problem

ShipIt is hard-coupled to the Claude Code CLI. Every layer — process spawning, NDJSON parsing, event types, tool rendering, authentication, and session management — assumes Claude as the only agent backend. Users who prefer (or need) OpenAI Codex CLI, Google Gemini CLI, or future agent CLIs cannot use ShipIt at all.

## Goals

1. **Run any supported agent CLI** as the backend for a ShipIt session — user picks at session creation or from settings.
2. **Unified UX** — the chat, file diffs, tool activity indicators, and preview all work regardless of which agent is running.
3. **Preserve Claude as first-class** — no regressions; Claude Code CLI remains the default and best-supported backend.
4. **Incremental adoption** — the abstraction ships behind a flag; each new CLI adapter is added independently without touching the core.

## Non-goals

- Multi-agent orchestration (running two agents in the same session).
- Model routing / automatic agent selection.
- Supporting non-CLI agent backends (API-only SDKs, MCP servers) — future work.
- Feature parity across all agents on day one. Agents that lack certain capabilities (e.g. no image input, no session resume) gracefully degrade.

---

## Architecture overview

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Browser UI  │◄─ws──►│  Fastify server   │──────►│  AgentProcess    │ (interface)
│              │       │  (index.ts)       │       └────────┬─────────┘
│              │       │                   │                │
│ Normalized   │       │ Normalized        │     ┌──────────┼──────────┐
│ AgentEvent   │       │ AgentEvent        │     │          │          │
│ rendering    │       │ routing           │     ▼          ▼          ▼
└─────────────┘       └──────────────────┘  Claude     Codex      Gemini
                                            Adapter    Adapter    Adapter
                                            (pty)      (pty)      (pty)
```

The key idea: introduce a **normalized event protocol** between the server and client, and push all CLI-specific logic into **adapter classes** that translate raw CLI output into that protocol.

---

## Design

### 1. `AgentProcess` interface

Extract from the current `ClaudeProcess` a provider-agnostic interface. Every adapter implements this.

```typescript
// src/server/agent-process.ts

import type { EventEmitter } from "node:events";

export type AgentId = "claude" | "codex" | "gemini";

export interface AgentCapabilities {
  supportsResume: boolean;       // can resume a previous conversation
  supportsImages: boolean;       // accepts image attachments
  supportsSystemPrompt: boolean; // accepts an explicit system prompt
  supportsPermissionModes: boolean;
  supportedPermissionModes: PermissionMode[];
  toolNames: string[];           // tools the CLI exposes (for UI mapping)
  models: string[];              // known model identifiers
}

export interface AgentProcessEvents {
  event: [AgentEvent];
  done:  [exitCode: number];
  error: [Error];
  auth_required: [];
  log:   [source: string, text: string];
}

export interface AgentProcess extends EventEmitter<AgentProcessEvents> {
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;

  run(params: AgentRunParams): void;
  writeStdin(data: string): void;
  kill(): void;
}

export interface AgentRunParams {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd?: string;
  permissionMode?: PermissionMode;
}
```

### 2. Normalized event schema (`AgentEvent`)

The server and client speak only in terms of `AgentEvent`, never raw CLI output. This replaces `ClaudeEvent` at the WebSocket boundary.

```typescript
// src/server/types.ts  (additions)

/** Emitted once when the agent starts */
export interface AgentInitEvent {
  type: "agent_init";
  agentId: AgentId;
  sessionId: string;
  model?: string;
  tools?: string[];
}

/** An assistant turn — text and/or tool invocations */
export interface AgentAssistantEvent {
  type: "agent_assistant";
  content: AgentContentBlock[];
}

/** Tool results flowing back to the agent */
export interface AgentToolResultEvent {
  type: "agent_tool_result";
  content: unknown[];
}

/** Final result of a turn */
export interface AgentResultEvent {
  type: "agent_result";
  status: "success" | "error";
  sessionId: string;
  cost?: { totalUsd: number };
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  durationMs?: number;
  error?: string;
}

export type AgentEvent =
  | AgentInitEvent
  | AgentAssistantEvent
  | AgentToolResultEvent
  | AgentResultEvent;

/** Unified content blocks */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
```

The shapes are intentionally close to the existing `ClaudeEvent` types — the Claude adapter's mapping is nearly 1:1 — but the names are provider-neutral so the client never has to know which CLI is running.

### 3. Adapter classes

Each adapter lives in its own file under `src/server/agents/`.

```
src/server/agents/
  agent-process.ts        # AgentProcess interface + AgentId type
  claude-adapter.ts       # wraps current ClaudeProcess logic
  codex-adapter.ts        # OpenAI Codex CLI adapter
  gemini-adapter.ts       # Google Gemini CLI adapter
  tool-map.ts             # canonical tool name mapping
```

#### 3a. Claude adapter (`claude-adapter.ts`)

This is a refactored version of today's `claude.ts`. The spawning, NDJSON parsing, and auth-keyword detection stay the same. The only new code is a `mapEvent()` method that converts `ClaudeEvent` → `AgentEvent`:

```typescript
private mapEvent(raw: ClaudeEvent): AgentEvent {
  switch (raw.type) {
    case "system":
      return { type: "agent_init", agentId: "claude", sessionId: raw.session_id, model: raw.model, tools: raw.tools };
    case "assistant":
      return { type: "agent_assistant", content: raw.message.content };
    case "user":
      return { type: "agent_tool_result", content: raw.message.content };
    case "result":
      return { type: "agent_result", status: raw.subtype, sessionId: raw.session_id, cost: raw.total_cost_usd != null ? { totalUsd: raw.total_cost_usd } : undefined, tokens: raw.input_tokens != null ? { input: raw.input_tokens, output: raw.output_tokens ?? 0 } : undefined, durationMs: raw.duration_ms };
  }
}
```

The existing test helpers (`FakeClaudeProcess`) continue to work because they emit events through the same `EventEmitter` interface.

#### 3b. Codex adapter (`codex-adapter.ts`) — sketch

OpenAI's Codex CLI (`codex`) uses a similar pattern: it can stream JSON events to stdout. Key differences:

| Aspect | Claude Code CLI | Codex CLI |
|---|---|---|
| Binary | `claude` | `codex` |
| Stream flag | `--output-format stream-json` | `--stream-json` (TBD — verify) |
| Resume | `--resume <id>` | Not supported (stateless) |
| Tools | `Write`, `Read`, `Edit`, `Bash`, etc. | `shell`, `file_write`, `file_read`, etc. |
| Auth | `claude /login` (OAuth) | `OPENAI_API_KEY` env var |
| Cost tracking | Built-in `total_cost_usd` | Not provided — estimate from token counts |

The adapter:
1. Spawns `codex` with the correct flags.
2. Parses its streaming output (format TBD — may be NDJSON or SSE).
3. Maps Codex tool names → canonical names via `tool-map.ts`.
4. Emits normalized `AgentEvent`s.
5. Reports `supportsResume: false`, `supportsImages: false` in capabilities.

#### 3c. Gemini adapter (`gemini-adapter.ts`) — sketch

Google's Gemini CLI is newer. Similar approach: spawn the binary, parse its output, normalize events.

Key differences to investigate:
- Output format and streaming protocol.
- Tool/function-calling naming conventions.
- Authentication mechanism (Google Cloud credentials vs API key).
- Session management and context window handling.

### 4. Canonical tool name mapping (`tool-map.ts`)

The client renders tool activity (spinner labels, diff views, file previews) based on tool names. Different CLIs use different names for equivalent operations. A mapping layer normalizes them.

```typescript
export type CanonicalTool =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell"
  | "glob"
  | "grep"
  | "web_fetch"
  | "web_search"
  | "ask_user";

const CLAUDE_TOOL_MAP: Record<string, CanonicalTool> = {
  Read: "file_read",
  Write: "file_write",
  Edit: "file_edit",
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  AskUserQuestion: "ask_user",
};

const CODEX_TOOL_MAP: Record<string, CanonicalTool> = {
  shell: "shell",
  file_write: "file_write",
  file_read: "file_read",
  // ... etc.
};

export function canonicalizeTool(agentId: AgentId, toolName: string): CanonicalTool | null;
```

The adapters call `canonicalizeTool()` inside `mapEvent()` so that by the time events reach the server/client, all tool names are canonical. The client's `activityFromTool()` and `MessageList` rendering switch on canonical names instead of Claude-specific ones.

### 5. `AppDeps` changes

```typescript
// Before
export interface AppDeps {
  claudeFactory?: () => ClaudeProcess;
  // ...
}

// After
export interface AppDeps {
  agentFactory?: (agentId: AgentId) => AgentProcess;
  defaultAgentId?: AgentId;
  // ...
}
```

The factory now takes an `AgentId` parameter and returns the corresponding adapter. The server calls it when a session starts (or when the user switches agents). Existing tests pass a factory that returns `FakeClaudeProcess` (which now implements `AgentProcess`).

### 6. Server changes (`index.ts`)

#### Message handler

The `send_message` handler currently creates a `ClaudeProcess`, attaches listeners for `"event"`, `"done"`, etc., and forwards `ClaudeEvent`s to the client as `WsClaudeEvent`.

Changes:
1. Replace `claudeFactory()` → `agentFactory(agentId)`.
2. Replace `ClaudeEvent` listener logic with `AgentEvent` listener logic (structurally similar, just different type names).
3. The `WsClaudeEvent` wrapper becomes `WsAgentEvent`:
   ```typescript
   { type: "agent_event", event: AgentEvent }
   ```
4. For backward compatibility during migration, the server can emit both `claude_event` (deprecated) and `agent_event` if needed. A feature flag (`MULTI_AGENT_ENABLED`) controls whether the new types are used.

#### Agent selection

A new WebSocket message lets the client set the agent for a session:

```typescript
interface WsSetAgentMessage {
  type: "set_agent";
  agentId: AgentId;
}
```

The server stores `agentId` in per-connection state alongside `activeSessionDir`. If not set, falls back to `defaultAgentId` (which defaults to `"claude"`).

### 7. Client changes

#### `App.tsx`

- Process `agent_event` messages instead of (or in addition to) `claude_event`.
- Store `activeAgentId` in state.
- Pass `agentId` to components that need it (mostly for display labels).

#### `StreamingIndicator.tsx`

- `activityFromTool()` switches on `CanonicalTool` names instead of Claude tool names.
- Activity labels become generic: "Editing file" instead of "Claude is editing".

#### `MessageList.tsx`

- Tool-use rendering (diff blocks, file previews, shell output) keyed on `CanonicalTool` names.
- The `AskUserQuestion` / `ask_user` tool rendering is agent-agnostic (it already renders based on the `questions` field in `input`).

#### `AuthOverlay.tsx`

- Shows agent-specific auth instructions. Claude: OAuth flow. Codex: "Set your `OPENAI_API_KEY`". Gemini: Google Cloud auth.
- The server's `auth_required` event now carries `agentId` so the client knows which overlay to show.

#### Agent picker (new component)

A small dropdown or segmented control in the sidebar/header that lets users choose which agent to use. Only shown when `MULTI_AGENT_ENABLED` is true.

```
┌──────────────────────┐
│ ▼ Claude Code        │
│   Codex CLI          │
│   Gemini CLI         │
└──────────────────────┘
```

### 8. Authentication

Each agent has its own auth mechanism. The current `AuthManager` becomes `ClaudeAuthManager` and new auth managers are added:

```
src/server/auth/
  auth-manager.ts         # AuthManager interface
  claude-auth.ts          # current auth.ts logic (OAuth flow)
  codex-auth.ts           # OPENAI_API_KEY env check
  gemini-auth.ts          # Google Cloud credentials check
```

The interface:

```typescript
export interface AuthManager {
  checkAuth(): Promise<AuthStatus>;
  initiateAuth(): Promise<void>;  // start login flow
  onAuthOutput?(line: string): boolean;  // detect auth prompts in CLI output
}

export type AuthStatus =
  | { authenticated: true }
  | { authenticated: false; reason: string; instructions: string };
```

### 9. Session metadata

The `SessionManager` metadata gains an `agentId` field:

```typescript
interface SessionMetadata {
  id: string;
  name: string;
  createdAt: string;
  agentId: AgentId;        // new
  agentSessionId?: string; // CLI's own session ID (if applicable)
  // ...
}
```

This ensures sessions are resumed with the correct agent. The session sidebar shows an agent icon/label next to each session.

### 10. Graceful degradation

Not all agents support all features. The `AgentCapabilities` object drives this:

| Feature | Behavior when unsupported |
|---|---|
| Session resume | Start a fresh conversation; inject prior messages as system prompt context |
| Image input | Disable image attachment button; show tooltip "Not supported by {agent}" |
| System prompt | Silently omit; log a warning |
| Permission modes | Default to auto-approve; disable mode picker |
| Cost tracking | Show "N/A" instead of dollar amounts |
| Thread checkpoints | Create git-based checkpoints only (no agent session branching) |

---

## Migration plan

### Phase 1: Extract the interface (no user-facing changes)

1. Create `src/server/agents/agent-process.ts` with the `AgentProcess` interface and `AgentEvent` types.
2. Create `src/server/agents/claude-adapter.ts` — move `ClaudeProcess` logic here, implement `AgentProcess`, add `mapEvent()`.
3. Create `src/server/agents/tool-map.ts` with canonical tool names and the Claude mapping.
4. Update `AppDeps` to use `agentFactory` (keep `claudeFactory` as a deprecated alias).
5. Update server event handlers to process `AgentEvent` instead of `ClaudeEvent`.
6. Update client to handle `agent_event` messages (keep `claude_event` handling for compat).
7. Update `FakeClaudeProcess` in test helpers to implement `AgentProcess`.
8. All existing tests must still pass — this is a pure refactor.

### Phase 2: Client normalization

1. Update `StreamingIndicator.tsx` to use canonical tool names.
2. Update `MessageList.tsx` to use canonical tool names.
3. Add `agentId` to session metadata.
4. Add agent picker component (hidden behind feature flag).

### Phase 3: Second adapter (Codex)

1. Research Codex CLI's exact streaming output format.
2. Implement `CodexAdapter` in `src/server/agents/codex-adapter.ts`.
3. Implement `CodexAuthManager` in `src/server/auth/codex-auth.ts`.
4. Add Codex tool mapping to `tool-map.ts`.
5. Integration tests for the Codex adapter.
6. Enable feature flag for beta testing.

### Phase 4: Third adapter (Gemini) + polish

1. Implement `GeminiAdapter` and `GeminiAuthManager`.
2. Add Gemini tool mapping.
3. Polish agent picker UX — show capabilities, model info, auth status per agent.
4. Remove feature flag; ship to all users.

---

## Key files to modify

| File | Change |
|---|---|
| `src/server/claude.ts` | Refactor into `src/server/agents/claude-adapter.ts` |
| `src/server/types.ts` | Add `AgentEvent`, `AgentId`, `AgentCapabilities`, `WsAgentEvent`, `WsSetAgentMessage` |
| `src/server/index.ts` | `AppDeps.agentFactory`, event handler refactor, `set_agent` handler |
| `src/server/auth.ts` | Extract interface, move impl to `src/server/auth/claude-auth.ts` |
| `src/server/sessions.ts` | Add `agentId` to `SessionMetadata` |
| `src/client/App.tsx` | Handle `agent_event`, store `activeAgentId`, agent picker |
| `src/client/components/StreamingIndicator.tsx` | Switch to canonical tool names |
| `src/client/components/MessageList.tsx` | Switch to canonical tool names |
| `src/client/components/AuthOverlay.tsx` | Agent-specific auth UI |
| `src/server/integration_tests/test-helpers.ts` | `FakeAgentProcess` implementing `AgentProcess` |

## New files

| File | Purpose |
|---|---|
| `src/server/agents/agent-process.ts` | `AgentProcess` interface, `AgentId`, `AgentCapabilities` |
| `src/server/agents/claude-adapter.ts` | Claude Code CLI adapter |
| `src/server/agents/codex-adapter.ts` | Codex CLI adapter |
| `src/server/agents/gemini-adapter.ts` | Gemini CLI adapter |
| `src/server/agents/tool-map.ts` | Canonical tool name mapping |
| `src/server/auth/auth-manager.ts` | `AuthManager` interface |
| `src/server/auth/claude-auth.ts` | Claude OAuth auth |
| `src/server/auth/codex-auth.ts` | OpenAI API key auth |
| `src/server/auth/gemini-auth.ts` | Google Cloud auth |
| `src/client/components/AgentPicker.tsx` | Agent selection UI |

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Codex/Gemini CLI output formats change between releases | Adapter breaks | Pin supported CLI versions; adapter includes version detection and warns on unknown versions |
| Event normalization loses CLI-specific information | Features degrade | Allow adapters to attach `raw` field to `AgentEvent` for debugging; progressively add fields to the normalized schema as needed |
| Increased maintenance burden (3 adapters) | Slower iteration | Phase 1 refactor is a pure win regardless — clean interface even with one adapter. Add adapters only when there's user demand |
| Different CLIs have incompatible permission/sandbox models | Security gaps | Default to most restrictive mode; adapter declares capabilities; UI disables features that can't be safely offered |
| Test matrix explosion (3 agents x N features) | CI slows down | Integration tests run against `FakeAgentProcess` (fast); per-adapter tests run against the real CLI in a separate slower suite |

---

## Open questions

1. **Codex CLI streaming format** — Does Codex CLI support NDJSON streaming? Need to verify the exact output format and available flags.
2. **Gemini CLI maturity** — Is the Gemini CLI stable enough to build against, or should we wait for a stable release?
3. **Per-session vs global agent selection** — Should users be able to switch agents mid-session, or only at session creation time? (Starting with session-creation-only is simpler.)
4. **Cost normalization** — Different providers report costs differently (or not at all). How should the usage tracker handle this?
5. **Agent-specific system prompts** — The current system prompt is tailored to Claude Code CLI's behavior. Each agent may need its own default system prompt. Where should these live?

---

## Status note

Phases 1–3 (abstraction layer, Codex adapter, container setup, agent picker UI) are complete. Phase 4 (Gemini adapter) is **postponed** — the Gemini CLI does not currently support session management, which is required for meaningful integration with ShipIt's session-based architecture. The Gemini adapter will be revisited when the Gemini CLI adds session management capabilities.
