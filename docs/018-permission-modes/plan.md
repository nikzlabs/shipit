---
status: done
---
# 018 — Permission Modes

## Summary

Add three permission modes to ShipIt: **Auto-Accept** (current default behavior), **Plan Mode** (read-only exploration — Claude can search and read but cannot write, edit, or execute), and **Normal Mode** (Claude asks permission before each write/edit/command). Users select the mode via a dropdown in the chat input area.

## Motivation

ShipIt currently runs Claude CLI with full permissions — all changes are applied immediately, and the only safety net is git rollback. This is fine for experienced users who trust the agent, but it creates problems:

1. **No exploration mode**: Users can't ask Claude to analyze a codebase and propose a plan without it immediately executing changes. This is especially valuable for unfamiliar codebases.
2. **No approval gate**: Some users want to review each tool call before it executes, especially for destructive operations (deleting files, running arbitrary bash commands).
3. **No "dry run"**: There's no way to see what Claude *would* do without actually doing it.

The Claude Code CLI supports `--permission-mode plan` natively. ShipIt should expose this and add the Normal (approval) mode.

## How It Works

### Modes

| Mode | Behavior | CLI Flag | Use Case |
|---|---|---|---|
| **Auto-Accept** | All tool calls execute immediately (current behavior) | (none — default) | Fast iteration, trusted agent |
| **Plan** | Claude can only read/search. Write/Edit/Bash are blocked by the CLI. Claude outputs what it *would* do. | `--permission-mode plan` | Codebase exploration, planning, architecture review |
| **Normal** | Each tool call is surfaced to the user for approval before executing | Custom (see below) | Careful review, learning, sensitive code |

### Plan Mode — Implementation

Plan mode is the simplest to implement because it's a native CLI feature.

**Server changes:**
- `ClaudeProcess.run()` accepts a new `permissionMode?: "auto" | "plan" | "normal"` parameter
- When `permissionMode === "plan"`, add `--permission-mode plan` to the CLI args
- When plan mode is active, the `--allowedTools` list is restricted to read-only tools: `Read, Glob, Grep, WebFetch, WebSearch`

**Client changes:**
- The `send_message` payload gains an optional `permissionMode` field
- A mode selector appears in or near the MessageInput component (dropdown or segmented control)
- When Plan mode is active, a visual indicator appears (e.g., blue "Plan Mode" badge in header or chat input)

**UX flow:**
1. User selects "Plan" mode from the mode selector
2. User types: "How would you restructure the auth module to use JWT?"
3. Claude explores the codebase (reads files, searches), then outputs a detailed plan
4. Chat shows the plan as a normal assistant message
5. User can switch to "Auto-Accept" and say "Go ahead with this plan" — Claude executes

**Plan → Execute shortcut:** Add a "Execute Plan" button on plan-mode messages. Clicking it:
1. Switches mode to Auto-Accept
2. Sends the plan text as a follow-up prompt: "Execute the plan you just described. Here's the plan for reference: [plan text]"

### Normal Mode — Implementation

Normal mode requires intercepting tool calls and waiting for user approval. This is more complex because it requires a new approval flow.

**Architecture:**

The Claude CLI doesn't have a built-in "ask the host for permission" mode in stream-json output. Instead, ShipIt implements this at the application layer:

1. Claude CLI runs in auto-accept mode (as today)
2. The server intercepts `assistant` events containing `tool_use` blocks
3. For write/edit/bash tools, the server **pauses** before the tool executes:
   - Actually, in the streaming model, the tool has already been dispatched by the CLI when we see the `tool_use` event. So we can't truly intercept before execution.

**Alternative approach — post-hoc review:**

Since the CLI executes tools as part of its agentic loop (we can't intercept mid-loop), Normal mode in ShipIt works differently than in the CLI:

1. Claude runs normally (auto-accept)
2. After each tool call completes, the server checks if it was a write/edit/bash tool
3. If so, the server sends an `approval_required` event to the client with the tool details
4. The client shows a confirmation dialog: "Claude wants to [edit src/App.tsx / run `npm install`] — Allow / Reject / Allow All"
5. **Allow**: No action needed (change already applied). Continue.
6. **Reject**: Revert the specific change (git checkout for file changes, no undo for bash). Send feedback to Claude.
7. **Allow All**: Switch to Auto-Accept for the rest of this turn.

This is a **post-hoc approval model** — changes happen first, then are reviewed. It's less ideal than true pre-approval but works within the streaming CLI architecture. The diff review panel (017) complements this: Normal mode provides immediate per-tool-call review, while the diff panel provides holistic post-turn review.

**Better alternative — AskUserQuestion interception:**

Actually, there's a cleaner approach. The CLI's `AskUserQuestion` tool is already in the allowed tools list. We can leverage this:

1. Remove destructive tools from `--allowedTools` in Normal mode
2. Instead, add a system prompt instruction: "Before making any file changes, use AskUserQuestion to describe what you plan to change and ask for approval."
3. Claude will naturally ask before each change
4. The user approves via the existing `answer_question` flow
5. Only then does Claude proceed with the edit

This is simpler and works within the existing architecture. The tradeoff is that Claude may not always follow the instruction perfectly, but with a strong system prompt it's reliable.

**Recommended hybrid approach:**

Use **restricted tools + system prompt** for Normal mode:

```typescript
const NORMAL_MODE_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion";
const NORMAL_MODE_INSTRUCTION = `IMPORTANT: You are in supervised mode. Before making ANY file changes or running commands:
1. Describe what you plan to do
2. Use AskUserQuestion to get approval first
3. Only proceed after the user approves
Never skip the approval step.`;
```

When Claude asks for approval via AskUserQuestion, the existing approval UI in the chat handles it naturally.

### New Types

```typescript
// src/server/types.ts — additions

// Extend WsSendMessage
export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  permissionMode?: "auto" | "plan" | "normal";
}
```

### Client UI

**Mode Selector** — a segmented control or dropdown near the MessageInput:

```
┌─────────────────────────────────────────────┐
│ [Auto ▪ Plan ▪ Normal]                      │
│                                             │
│ Type your message...                [Send]  │
└─────────────────────────────────────────────┘
```

- **Auto** (default): Current behavior. No badge.
- **Plan**: Blue badge/indicator. Label: "Read-only — Claude will explore and plan without making changes"
- **Normal**: Yellow badge/indicator. Label: "Supervised — Claude will ask before each change"

Mode persists per-session (saved in localStorage alongside session ID) so users don't need to re-select it each time.

**Plan mode message formatting**: When Claude responds in plan mode, format the output distinctly — perhaps in a bordered card with a "Plan" header and the "Execute Plan" button at the bottom.

## Testing

### Integration Tests (`src/server/integration_tests/permission-modes.test.ts`)
1. **Plan mode**: Send message with `permissionMode: "plan"` → Claude CLI spawned with `--permission-mode plan` → verify restricted tool list in args
2. **Normal mode**: Send message with `permissionMode: "normal"` → verify restricted tool list and system prompt injection
3. **Auto mode**: Default behavior unchanged (no extra args)
4. **Mode switch mid-session**: Switch from plan to auto within the same session → verify CLI args change

### Component Tests
1. Mode selector renders three options
2. Selecting a mode updates local state and persists to localStorage
3. Plan mode badge appears when plan is selected
4. Send button passes permissionMode to the send handler

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `permissionMode` to `WsSendMessage` |
| `src/server/claude.ts` | Accept `permissionMode` in `run()`, adjust CLI args + tools |
| `src/server/index.ts` | Pass `permissionMode` from message to `claude.run()` |
| `src/client/components/ModeSelector.tsx` | New component |
| `src/client/components/ModeSelector.test.tsx` | Component tests |
| `src/client/components/MessageInput.tsx` | Integrate mode selector |
| `src/client/App.tsx` | Add mode state, pass to send handler |
| `src/server/integration_tests/permission-modes.test.ts` | Integration tests |

## Complexity

Low-medium. Plan mode is trivially a CLI flag. Normal mode requires the system prompt approach + restricting the tool list. No new server-side infrastructure needed. Estimate: ~300-500 lines of new code.
