# Design Doc 004: Inline Tool Result Rendering

## Status: Implemented

## Problem

When Claude uses tools, the ShipIt UI shows only the *invocation* side (tool name + arguments) but not the *results*. The `ClaudeUserEvent` events contain tool results (Bash output, file contents from Read, search results from Grep/Glob, etc.), but the client ignores them entirely — `event.type === "user"` sets the activity label to "Processing results..." and discards all content.

This creates a major visibility gap:

1. **Bash commands are opaque** — users see "Bash: `npm test`" but not the test output. They must switch to the Terminal tab to see logs (which are interleaved and hard to correlate with specific commands).
2. **Read/Grep/Glob results are invisible** — users can't see what Claude found when searching the codebase, forcing them to mentally reconstruct what Claude knows.
3. **WebSearch/WebFetch results are invisible** — when Claude searches the web, users can't see the results or verify the information.
4. **Debugging is harder** — when Claude makes a mistake, users can't see what went wrong because the error output from failed commands is hidden.

## Goals

1. Parse tool results from `ClaudeUserEvent` content blocks.
2. Display tool results inline in the chat, paired with their corresponding tool invocations.
3. Make results collapsible to avoid overwhelming the conversation with long output.
4. Prioritize rendering for the most common tools: Bash, Read, Grep, Glob.

## Non-Goals

- Editing tool results retroactively.
- Re-running tools from the UI.
- Rendering every possible tool result format — start with the top 5 tools.

## Design

### Understanding the Data Flow

Claude CLI's NDJSON stream alternates between:
1. `assistant` events — Claude's text + tool_use blocks (what we already render)
2. `user` events — tool results (what we currently ignore)

A `user` event's `message.content` is an array of `tool_result` blocks:

```json
{
  "type": "user",
  "message": {
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_abc123",
        "content": "npm test output here..."
      }
    ]
  }
}
```

Each `tool_result` has a `tool_use_id` that matches a `tool_use` block from the preceding `assistant` event. This is the key to pairing invocations with results.

### Data Model Changes

```typescript
// Extend ChatMessage to carry tool results
export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];  // NEW
  streaming?: boolean;
  isError?: boolean;
}
```

### Server Changes

No server changes needed. The `claude_event` relay already sends `user` events to the client. The change is entirely in how the client processes and renders them.

### Client Changes

#### `App.tsx` — process `user` events

Currently:
```typescript
if (event.type === "user") {
  setActivity({ label: "Processing results..." });
}
```

New behavior:
```typescript
if (event.type === "user") {
  setActivity({ label: "Processing results..." });

  // Extract tool results from the user event
  const results: ToolResultBlock[] = [];
  for (const block of (event.message?.content ?? []) as any[]) {
    if (block.type === "tool_result" && block.tool_use_id) {
      results.push({
        toolUseId: block.tool_use_id,
        content: typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content),
        isError: block.is_error ?? false,
      });
    }
  }

  if (results.length > 0) {
    // Attach results to the last assistant message's tool_use blocks
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, toolResults: results },
        ];
      }
      return prev;
    });
  }
}
```

#### `MessageList.tsx` — render tool results

Each `ToolUseItem` component receives an optional `result` prop. The result is matched by `tool_use_id`:

```tsx
function ToolUseItem({ tool, result, ... }) {
  const [collapsed, setCollapsed] = useState(true);
  const hasResult = !!result;

  return (
    <div>
      {/* Existing tool invocation rendering */}
      <div className="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1">
        <span>{tool.name}</span>
        {/* ... existing args display */}

        {/* Result toggle button */}
        {hasResult && (
          <button onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? "Show output" : "Hide output"}
          </button>
        )}
      </div>

      {/* Collapsible result */}
      {hasResult && !collapsed && (
        <ToolResult tool={tool.name} result={result} />
      )}
    </div>
  );
}
```

#### Tool-specific result renderers

```tsx
function ToolResult({ tool, result }: { tool: string; result: ToolResultBlock }) {
  if (tool === "Bash") {
    return <BashResult content={result.content} isError={result.isError} />;
  }
  if (tool === "Read") {
    return <ReadResult content={result.content} />;
  }
  if (tool === "Grep") {
    return <GrepResult content={result.content} />;
  }
  // Default: monospace text block
  return <GenericResult content={result.content} isError={result.isError} />;
}
```

**BashResult**: Monospace text block with a dark background, max height with scroll. Error output highlighted in red.

```
┌──────────────────────────────────────────────┐
│ $ npm test                                   │
│ ────────────────────────────────────────────  │
│  ✓ src/server/git.test.ts (5 tests) 120ms    │
│  ✓ src/server/sessions.test.ts (3 tests) 8ms │
│  ✗ src/server/auth.test.ts (1 test) 45ms     │
│                                              │
│  Tests: 8 passed, 1 failed                   │
│  [Show more ↓]                               │
└──────────────────────────────────────────────┘
```

- Truncated at 30 lines by default, expandable with "Show more".
- Error exit codes highlighted with red border.

**ReadResult**: Shows the first ~20 lines of file content with syntax highlighting, collapsible.

**GrepResult**: Shows matching files and lines, preserving the ripgrep-style format.

**GenericResult**: Plain monospace text block for any other tool.

### Result Sizing and Truncation

Tool results can be very large (full file reads, long Bash output). Client-side truncation rules:

| Tool | Default collapsed | Max preview lines | Expandable |
|------|-------------------|-------------------|------------|
| Bash | Yes | 30 | Yes (show full) |
| Read | Yes | 20 | Yes |
| Grep/Glob | Yes | 20 | Yes |
| WebSearch | No (short) | 10 | No |
| Other | Yes | 15 | Yes |

### Chat History Persistence

Tool results are NOT persisted in the chat history. Rationale:
- They can be very large (megabytes of Bash output).
- They're ephemeral — what matters is Claude's response to them.
- The Terminal tab already has log history for Bash output.

If we later want persistence, we can add it as a separate feature.

### File Layout

| File | Change |
|------|--------|
| `src/client/App.tsx` | Process `user` events, extract and attach tool results |
| `src/client/components/MessageList.tsx` | Pass results to `ToolUseItem`, add collapse/expand |
| `src/client/components/ToolResult.tsx` | New — tool-specific result renderers |
| `src/client/components/ToolResult.test.tsx` | New — component tests |

### Quality Checklist

- [x] Input validation: Tool results come from Claude CLI (trusted). Client-side truncation prevents memory issues.
- [x] Component tests: Render `BashResult` with normal output, error output, empty output. Render `ReadResult` with syntax highlighting. Test collapse/expand toggle.
- [x] Edge cases: Handle missing `tool_use_id` match (orphan results), handle binary/non-UTF8 content gracefully, handle extremely long output (>1MB).
- [x] Performance: Virtualize or truncate results to prevent DOM bloat with large outputs. Lazy-render syntax highlighting.
- [x] Accessibility: Expand/collapse buttons have proper aria labels. Error results have role="alert".
