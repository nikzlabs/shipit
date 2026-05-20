---
status: planned
priority: low
description: Let users delete messages and compact conversation history into a summarized fork to genuinely reduce the agent's context window.
---
# 047 — Chat History Editing

## Summary

Let users manually edit their chat history to manage context: delete individual messages, delete ranges of messages, and compact old conversation turns into a summary. Because agent CLIs (Claude, Codex) maintain their own conversation context via resume mechanisms, UI deletions alone don't reduce what the agent sees. This feature bridges that gap by combining UI editing with session forking to produce genuinely trimmed context windows.

## Motivation

Long coding sessions accumulate context that becomes counterproductive:

- **Dead ends**: Early exploration messages that led nowhere but still consume tokens on every turn.
- **Verbose tool output**: Large file reads, grep results, and error logs that were useful once but are now noise.
- **Stale instructions**: Early messages describing requirements that have since changed.
- **Context pressure**: As the 200K token window fills, response quality degrades and costs increase.

The existing message editing feature (006) lets users edit and retry a single user message, but it can't remove arbitrary messages or reduce the actual context the agent sees. Threads (007) let users fork from checkpoints, but only at pre-created snapshot points — not by selectively pruning the conversation.

Users need a way to curate their conversation: remove what's no longer relevant, keep what matters, and have the agent actually operate on the trimmed context going forward.

## Core constraint

**The agent CLI owns the conversation context.** ShipIt supports multiple agent backends (Claude, Codex) via the `AgentProcess` interface. Both manage their own conversation history server-side:

- **Claude CLI**: `claude -p "..." --resume <sessionId>` loads full conversation from `~/.claude/` storage.
- **Codex CLI**: `codex app-server` with `thread/resume` loads the thread's full history from Codex's storage.

ShipIt's `ChatHistoryManager` is a separate, UI-only persistence layer — it controls what the user *sees*, not what the agent *remembers*.

This means:

| Action | UI effect | Agent context effect |
|---|---|---|
| Delete message from UI | Message disappears | No change — agent still sees it |
| Edit persisted chat history | Updated on reload | No change |
| Fork to new thread | New UI branch | New CLI session — context resets |
| Start new session | Clean slate | Clean slate |

This constraint applies identically to both Claude and Codex. Both have `supportsResume: true` in their `AgentCapabilities`, and both load their own conversation history from internal storage on resume.

**To actually reduce context, we must start a new agent session.** The design uses a "compact and fork" approach: the user edits the visible history, then the system creates a new CLI session seeded with a summary of the curated history.

## Design

### Two-tier editing model

#### Tier 1: UI-only editing (immediate, no context change)

Users can hide or delete messages from the chat display. These changes affect what's shown in the UI and what's saved in `ChatHistoryManager`, but the agent's context is unchanged. Useful for:

- Cleaning up visual clutter (long tool outputs, error dumps)
- Removing messages the user doesn't need to reference
- Preparing for a Tier 2 compaction

**Operations:**
- **Delete message**: Remove a single message (user or assistant) from the UI. If it's an assistant message with tool use, the preceding user message remains (and vice versa).
- **Delete range**: Select a start and end message, remove everything in between.
- **Collapse message**: Replace a message's content with a short label ("*Collapsed: file read output*") without deleting it. Expandable on click.

**Visual indicator:** When UI history diverges from the agent's actual context, show a subtle banner: "Chat history was edited. The agent may reference messages not shown here." This sets expectations and avoids confusion when the agent refers to deleted content.

#### Tier 2: Compact & fork (creates new context)

When the user wants the agent to actually operate on the trimmed history, they trigger a "compact" operation that:

1. Takes the current UI chat history (after any Tier 1 edits)
2. Generates a summary of the conversation so far
3. Creates a new thread (reusing the threads/checkpoints system from 007)
4. Starts a new CLI session with the summary injected as the opening system context
5. The user continues in the new thread with a genuinely smaller context window

This is the only way to reduce what the agent sees without losing all conversation context.

### UI: Edit mode

A toggle button in the chat header enters "edit mode" — a distinct visual state where messages become selectable and editable.

```
┌──────────────────────────────────────────────────────────┐
│  Session: My App  │  [Edit History]  │  Context: 82K/200K │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ☐ 👤 "Set up a React app with routing"                 │
│  ☐ 🤖 Created package.json, installed deps...           │  ← expandable
│  ☐ 👤 "Now add authentication"                          │
│  ☐ 🤖 I'll add auth using... [3 tool calls]             │
│  ☑ 👤 "Actually, use a different auth library"           │  ← selected
│  ☑ 🤖 Let me switch to... [error, wrong approach]       │  ← selected
│  ☐ 👤 "Never mind, go back to the first approach"       │
│  ☐ 🤖 OK, reverting to the original auth setup...       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 2 selected  [Delete] [Collapse] [Cancel]         │   │
│  │              [Compact & Fork — reduce context]    │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**Edit mode behavior:**
- Each message gets a checkbox for selection
- Multi-select via click, shift-click for range selection
- Toolbar appears at bottom with available actions
- Delete removes selected messages from UI + persisted history
- Collapse replaces content with a one-line summary (locally generated, no API call)
- "Compact & Fork" triggers the Tier 2 flow
- Escape or Cancel exits edit mode

### UI: Divergence banner

When messages have been deleted (Tier 1 only, no compact), show a dismissible banner:

```
┌──────────────────────────────────────────────────────────┐
│ ⚠ Some messages were removed from view. The agent's       │
│   context still includes them. [Compact & Fork] to trim.  │
│                                                     [×]  │
└──────────────────────────────────────────────────────────┘
```

This appears below the chat header and above the first message. It's dismissible per session (stored in component state, not persisted).

### Compact & fork flow

When the user clicks "Compact & Fork":

1. **Confirmation dialog**: "This will create a new conversation branch with a summarized history. The agent will lose detailed memory of individual messages but retain the key context. Continue?"

2. **Summary generation**: The server takes the current UI messages (post-editing) and generates a compact summary. The summary is generated via `ctx.generateText()`, which is already agent-agnostic (it uses whichever agent is currently active):
   ```
   Prompt: "Summarize the following conversation for context continuity.
   Focus on: decisions made, current state of the codebase, open tasks,
   and user preferences expressed. Be concise but preserve actionable detail.

   <conversation>
   {messages as user/assistant turns}
   </conversation>"
   ```

3. **Thread creation**: Uses the existing `fork_thread` mechanism (007) to:
   - Create a git checkpoint at current state
   - Create a new thread
   - Set the new thread's chat history to just the summary message

4. **New session**: The summary is injected as the first user message in the new thread. When the agent is next invoked, it starts a fresh session (no `--resume` for Claude, no `thread/resume` for Codex) with the summary as context. The system prompt includes a preamble: "The following is a summary of our prior conversation. Continue from where we left off."

5. **Context savings displayed**: After compaction, show the reduction: "Context reduced from ~82K to ~4K tokens. Continuing in new branch."

### Agent-specific behavior

The compact & fork flow is agent-agnostic — it works through the `AgentProcess` interface. But there are behavioral differences:

| Aspect | Claude | Codex |
|---|---|---|
| Resume mechanism | `--resume <sessionId>` | `thread/resume { threadId }` |
| New session | Omit `--resume` flag | `thread/start {}` (new thread) |
| Summary generation | Uses `ctx.generateText()` | Uses `ctx.generateText()` |
| Context storage | `~/.claude/` | Codex app-server internal |
| Token estimation | ~4 chars/token | ~4 chars/token (same heuristic) |

When forking, the handler checks `agent.capabilities.supportsResume` (both return `true` today). The key action is ensuring the new thread does NOT resume the old session — it starts fresh with the summary as the first message. The `AgentRunParams.sessionId` field is left `undefined` for the first turn in the compacted thread, which causes both adapters to create a new session.

### Server: New operations

#### HTTP endpoints (following the HTTP-first convention)

**POST /api/sessions/:sessionId/chat-history/delete**

Delete specific messages from persisted chat history by index.

```typescript
// Request body
{
  messageIndices: number[];  // 0-based indices into the messages array
}

// Response
{
  remainingCount: number;    // messages remaining after deletion
}
```

**POST /api/sessions/:sessionId/chat-history/compact**

Generate a summary of the current chat history and create a forked thread.

```typescript
// Request body
{
  threadId?: string;  // optional: fork from specific thread
}

// Response
{
  newThreadId: string;
  summary: string;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
}
```

The compact endpoint:
1. Loads current chat history via `ChatHistoryManager`
2. Calls `generateText()` (agent-agnostic, non-streaming) to generate the summary
3. Creates a new thread via `ThreadManager`
4. Saves the summary as the new thread's chat history
5. Returns the new thread ID so the client can switch to it

#### ChatHistoryManager additions

```typescript
// New methods on ChatHistoryManager

/** Remove messages at the given indices. Returns updated message list. */
deleteMessages(sessionId: string, indices: number[]): PersistedMessage[] {
  const messages = this.load(sessionId);
  const updated = messages.filter((_, i) => !indices.includes(i));
  this.save(sessionId, updated);
  return updated;
}

/** Replace the entire history (used after compact/fork). */
replace(sessionId: string, messages: PersistedMessage[]): void {
  this.save(sessionId, messages);
}
```

#### Service layer

```typescript
// src/server/services/chat-history-editing.ts

import type { ChatHistoryManager } from "../chat-history.js";
import type { ThreadManager } from "../threads.js";
import type { PersistedMessage } from "../chat-history.js";
import { ServiceError } from "./types.js";

/** Delete messages by index from a session's chat history. */
export function deleteMessages(
  chatHistoryManager: ChatHistoryManager,
  sessionId: string,
  indices: number[],
): { remaining: PersistedMessage[]; removedCount: number } {
  if (!sessionId) throw new ServiceError(400, "sessionId is required");
  if (!indices.length) throw new ServiceError(400, "indices must not be empty");

  const current = chatHistoryManager.load(sessionId);
  const outOfRange = indices.filter((i) => i < 0 || i >= current.length);
  if (outOfRange.length) {
    throw new ServiceError(400, `Indices out of range: ${outOfRange.join(", ")}`);
  }

  const remaining = chatHistoryManager.deleteMessages(sessionId, indices);
  return { remaining, removedCount: indices.length };
}

/** Generate a summary and fork to a new thread with compacted context. */
export async function compactAndFork(
  chatHistoryManager: ChatHistoryManager,
  threadManager: ThreadManager,
  generateText: (prompt: string) => Promise<string>,
  sessionId: string,
  sessionDir: string,
): Promise<{
  newThreadId: string;
  summary: string;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
}> {
  const messages = chatHistoryManager.load(sessionId);
  if (messages.length < 2) {
    throw new ServiceError(400, "Not enough messages to compact");
  }

  // Format messages for summarization
  const formatted = messages
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n\n");

  const prompt = `Summarize the following coding conversation for context continuity. Focus on: decisions made, current state of the codebase, files modified, open tasks, and user preferences. Be concise but preserve all actionable detail needed to continue the work.\n\n<conversation>\n${formatted}\n</conversation>`;

  const summary = await generateText(prompt);

  // Estimate tokens (rough: ~4 chars per token)
  const originalTokenEstimate = Math.ceil(formatted.length / 4);
  const compactedTokenEstimate = Math.ceil(summary.length / 4);

  // Create checkpoint and fork thread
  const threads = threadManager.listThreads(sessionId);
  const activeThread = threads.find((t) => t.id === threads[0]?.id);
  const messageIndex = messages.length - 1;

  // Fork via thread manager
  const newThreadId = threadManager.forkThread(sessionId, {
    messageIndex,
    commitHash: "", // Will be filled by the handler with actual git state
    label: "Compacted context",
  });

  // Replace new thread's chat history with summary
  const compactedHistory: PersistedMessage[] = [
    {
      role: "user",
      text: "[Context summary from previous conversation]\n\n" + summary,
    },
  ];
  chatHistoryManager.replace(`${sessionId}_${newThreadId}`, compactedHistory);

  return {
    newThreadId,
    summary,
    originalTokenEstimate,
    compactedTokenEstimate,
  };
}
```

### Client: Components

#### ChatHistoryEditor (new component)

```
src/client/components/ChatHistoryEditor.tsx
src/client/components/ChatHistoryEditor.test.tsx
```

Renders the edit mode overlay on top of `MessageList`. Manages selection state, toolbar actions, and the compact confirmation dialog.

**Props:**
```typescript
interface ChatHistoryEditorProps {
  messages: ChatMessage[];
  onDelete: (indices: number[]) => void;
  onCompact: () => void;
  onCancel: () => void;
  isCompacting: boolean;  // loading state during compact API call
}
```

**State:**
```typescript
const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
const [showCompactConfirm, setShowCompactConfirm] = useState(false);
```

#### DivergenceBanner (new component)

Small banner component shown when `historyEdited && !compacted`.

```typescript
interface DivergenceBannerProps {
  onCompact: () => void;
  onDismiss: () => void;
}
```

#### Integration with existing components

- **MessageList.tsx**: Add `editMode` prop. When true, render checkboxes beside each message and suppress hover edit/retry buttons.
- **App.tsx** (or relevant hook): Add `isEditMode` state, `handleDeleteMessages`, `handleCompactAndFork` callbacks. Wire the "Edit History" button in the chat header.
- **useApi.ts**: Add `apiPost` calls for the new HTTP endpoints.

### Client state flow

```
User clicks "Edit History"
  → isEditMode = true
  → MessageList renders with checkboxes

User selects messages, clicks "Delete"
  → POST /api/sessions/:id/chat-history/delete { messageIndices }
  → Response: updated message count
  → setMessages(filtered)
  → historyDiverged = true
  → DivergenceBanner appears

User clicks "Compact & Fork" (from toolbar or banner)
  → Confirmation dialog
  → POST /api/sessions/:id/chat-history/compact
  → Response: { newThreadId, summary, tokenSavings }
  → Switch to new thread (reuses existing thread switching)
  → isEditMode = false
  → historyDiverged = false
  → Toast: "Context reduced from ~82K to ~4K tokens"
```

## Edge cases

1. **Deleting all messages**: Disallow — at least one message must remain. Show validation error.
2. **Deleting while agent is running**: Disable edit mode while `isLoading` is true. The button is grayed out with a tooltip: "Stop the agent before editing history."
3. **Compact fails** (summary generation error): Show error toast, keep the user in edit mode. No thread is created.
4. **Empty selection + delete**: Delete button is disabled when `selectedIndices.size === 0`.
5. **Thread interactions**: Compacting creates a new thread. Switching back to the original thread shows the full unedited history. The compacted thread is independent.
6. **Session reload after Tier 1 delete**: Deleted messages stay deleted (persisted history was modified). The divergence banner reappears because the agent's context still has them.
7. **Agent switch after compact**: If the user compacts while using Claude, then switches to Codex (or vice versa), the compacted thread works fine — the summary is a plain text message that any agent can consume. The new agent starts a fresh session regardless.
8. **Codex auth not configured**: If the active agent is Codex and `OPENAI_API_KEY` is not set, the compact endpoint's `generateText()` call will fail. The endpoint should detect this and return a clear error: "Cannot generate summary — agent auth not configured."

## Alternatives considered

### Server-side conversation history manipulation

Directly modifying the Claude CLI's conversation storage (`~/.claude/projects/`) to remove messages. Rejected because:
- The CLI's storage format is internal and undocumented
- It could corrupt the conversation state
- It creates a tight coupling to CLI internals that may change

### Re-sending the entire conversation

Instead of using `--resume`, replay all visible messages as a single long prompt. Rejected because:
- Loses tool use history (file edits, bash commands) that the CLI tracks internally
- Much more expensive (re-processes all input tokens)
- Complex to reconstruct the exact conversation format the CLI expects

### "Forget" command via system prompt

Inject instructions like "Ignore messages 3-7 from the conversation" into the system prompt. Rejected because:
- Unreliable — models don't consistently ignore context when told to
- Still consumes the full token budget
- Creates confusing behavior when the agent sometimes references "forgotten" content

### Per-agent context manipulation

Each agent CLI could theoretically support direct history editing — Claude CLI could add a `--drop-messages` flag, Codex could add a `thread/edit` RPC method. Rejected because:
- Neither CLI currently supports this
- Would require feature requests to two different teams (Anthropic, OpenAI)
- Tightly couples ShipIt to CLI implementation details
- The compact-and-fork approach works uniformly across all agents via the existing `AgentProcess` interface

## Testing

### Integration tests (`src/server/integration_tests/chat-history-editing.test.ts`)

1. **Delete messages**: POST delete with valid indices → history file updated, correct count returned
2. **Delete out-of-range**: POST delete with bad indices → 400 error
3. **Delete empty list**: POST delete with `[]` → 400 error
4. **Compact and fork**: POST compact → summary generated, new thread created, compacted history saved
5. **Compact with too few messages**: POST compact on 1-message history → 400 error

### Component tests

#### ChatHistoryEditor (`src/client/components/ChatHistoryEditor.test.tsx`)

1. Renders checkboxes for each message
2. Selecting messages enables delete button
3. Shift-click selects a range
4. Delete calls `onDelete` with correct indices
5. "Compact & Fork" shows confirmation dialog
6. Confirming compact calls `onCompact`
7. Cancel exits edit mode
8. Loading state during compact disables buttons

#### DivergenceBanner (`src/client/components/DivergenceBanner.test.tsx`)

1. Renders warning text and "Compact & Fork" button
2. Dismiss button calls `onDismiss`
3. "Compact & Fork" calls `onCompact`

## Key files

| File | Change |
|---|---|
| `src/server/chat-history.ts` | Add `deleteMessages()` and `replace()` methods |
| `src/server/services/chat-history-editing.ts` | New service: `deleteMessages()`, `compactAndFork()` |
| `src/server/api-routes.ts` | Add POST `/api/sessions/:sessionId/chat-history/delete` and `/compact` |
| `src/client/components/ChatHistoryEditor.tsx` | New component: edit mode UI with selection, delete, compact |
| `src/client/components/ChatHistoryEditor.test.tsx` | Component tests |
| `src/client/components/DivergenceBanner.tsx` | New component: divergence warning banner |
| `src/client/components/DivergenceBanner.test.tsx` | Component tests |
| `src/client/components/MessageList.tsx` | Add `editMode` prop for checkbox rendering |
| `src/client/App.tsx` | Add `isEditMode` state, wire edit/delete/compact handlers |
| `src/server/integration_tests/chat-history-editing.test.ts` | Integration tests |
