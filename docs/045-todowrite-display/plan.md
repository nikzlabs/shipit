---
status: done
---

# 045: TodoWrite Tool Display

## Problem

When Claude uses the `TodoWrite` tool to track tasks during a session, the call falls through to a generic one-liner ("Using TodoWrite...") in the message list. The user cannot see the task list Claude is maintaining.

## Design

Render TodoWrite calls **inline in the message list**, at their natural position in the conversation. Only the **most recent** TodoWrite renders as a full task panel — all earlier ones collapse to a compact one-liner ("Updated task list"). This gives the user a persistent view of the current task state without a floating panel disconnected from the conversation flow.

### Why inline, not a floating panel

- The todo list appears exactly where it was last updated — the user sees it in context
- No new layout regions or z-index management
- Follows the existing pattern where tools (Edit, Write, AskUserQuestion) render inline with special UI
- "At most one visible" is enforced by only expanding the last TodoWrite

### No new store needed

The `TodoWrite` input (`todos` array) is already persisted in the message's `toolUse` blocks, which survive chat history load, thread fork/switch, and session resume. We derive which TodoWrite is "latest" at render time by scanning the messages array — no separate state to keep in sync.

## Implementation

### 1. `src/client/components/TodoPanel.tsx` (new, ~50 lines)

A pure presentational component that renders a todo list from a `todos` array:

```typescript
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

function TodoPanel({ todos }: { todos: TodoItem[] }) { ... }
```

Visual design:
- Header: "Tasks" + "X/Y completed" progress counter
- Each item shows a status icon + label:
  - `completed` — green checkmark, strikethrough, shows `content`
  - `in_progress` — blue spinner (reuse `tool-spinner` CSS class), shows `activeForm`
  - `pending` — gray circle, shows `content`
- `max-h-48 overflow-y-auto` to cap height for long lists
- Styled with existing dark-mode classes (`bg-gray-900`, `border-gray-700`, `text-xs`)

### 2. `src/client/components/MessageList.tsx` (edit)

**2a. Compute the last TodoWrite tool ID.**

In the `MessageList` component body, add a `useMemo` that scans `messages` in reverse to find the `id` of the last `TodoWrite` tool_use block:

```typescript
const lastTodoWriteId = useMemo(() => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = messages[i].toolUse;
    if (tools) {
      for (let j = tools.length - 1; j >= 0; j--) {
        if (tools[j].name === "TodoWrite") return tools[j].id;
      }
    }
  }
  return null;
}, [messages]);
```

Pass `lastTodoWriteId` down to `ToolUseItem`.

**2b. Render TodoWrite in `ToolUseItem`.**

Add a case after the `AskUserQuestion` block (line 100) and before the generic fallback (line 102):

```typescript
if (tool.name === "TodoWrite" && Array.isArray(tool.input.todos)) {
  if (tool.id === lastTodoWriteId) {
    return <TodoPanel todos={tool.input.todos as TodoItem[]} />;
  }
  // Older TodoWrite — compact one-liner
  return (
    <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 rounded px-2 py-1 font-mono">
      Updated task list
    </div>
  );
}
```

### 3. `src/client/components/StreamingIndicator.tsx` (edit, +3 lines)

Add a case to `activityFromTool()`:

```typescript
case "TodoWrite":
  return { label: "Updating tasks...", tool: toolName };
```

### 4. Tests

**`src/client/components/TodoPanel.test.tsx`** (new):
- Renders nothing / empty state when todos is empty
- Renders items with correct status indicators
- Shows progress counter ("2/5 completed")
- Uses `activeForm` for in_progress, `content` for others
- Strikethrough on completed items

**`src/client/components/MessageList.test.tsx`** (edit — add cases):
- TodoWrite renders full panel for the latest call
- TodoWrite renders compact one-liner for older calls
- Only one full panel when multiple TodoWrite calls exist

## Files

| File | Action |
|------|--------|
| `src/client/components/TodoPanel.tsx` | Create |
| `src/client/components/MessageList.tsx` | Edit — add `lastTodoWriteId` memo + TodoWrite case in `ToolUseItem` |
| `src/client/components/StreamingIndicator.tsx` | Edit — add activity label |
| `src/client/components/TodoPanel.test.tsx` | Create |

## Verification

1. `npm run typecheck` — no errors
2. `npm test` — all tests pass
3. Manual: trigger a TodoWrite → full panel renders inline at that position
4. Manual: trigger a second TodoWrite → first collapses to one-liner, second shows full panel
5. Manual: switch sessions/threads → correct TodoWrite state shown from history
6. Manual: session with no TodoWrite → nothing extra rendered
