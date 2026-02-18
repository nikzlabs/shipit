---
status: done
---
# Streaming UX

Real-time visual feedback while Claude is working, built on three layers.

## Activity state machine

The `activity` state in `App.tsx` tracks what Claude is currently doing:

```
send_message → { label: "Thinking..." }
     │
     ▼
assistant (text only) → { label: "Thinking..." }
assistant (tool_use)  → { label: "Editing .../file.ts", tool: "Edit" }
     │
     ▼
user (tool result) → { label: "Processing results..." }
     │
     ▼
result → activity = undefined (idle)
```

The activity label is derived from the last `tool_use` block in each assistant event via `activityFromTool()` in `StreamingIndicator.tsx`.

## Visual indicators

| Location | Component | When shown |
|----------|-----------|------------|
| Chat | `ThinkingIndicator` (bouncing dots + label) | Loading, no assistant message yet |
| Chat | `TypingDots` (inline bouncing dots) | On streaming assistant messages |
| Chat | `ToolSpinner` (spinning border) | Tool is actively executing |
| Input bar | Bouncing dots + activity label | Claude is working (input disabled) |

## Code block rendering

Messages with fenced code blocks are split by `parseMessageSegments()` in `MessageList.tsx` into `TextSegment` and `CodeSegment` objects. `CodeBlock` component renders with `hljs.highlight()` (known language) or `hljs.highlightAuto()`. During streaming, unclosed code blocks render as plain text until the closing fence arrives.

## Tool result rendering

Tool results are displayed inline in chat beneath each tool invocation, collapsible by default.

| Renderer | Tools | Truncation |
|----------|-------|-----------|
| `BashResult` | Bash | 30 lines, red text for errors |
| `ReadResult` | Read | 20 lines, syntax highlighting |
| `GrepResult` | Grep, Glob | 20 lines, colored paths/line numbers |
| `GenericResult` | All others | 15 lines, monospace |

Outputs exceeding 1MB are truncated at parse time in `App.tsx`.

## Key files

- `src/client/components/StreamingIndicator.tsx` — `TypingDots`, `ThinkingIndicator`, `ToolSpinner`, `activityFromTool()`
- `src/client/components/MessageList.tsx` — Message rendering, `parseMessageSegments`, search highlights
- `src/client/components/ToolResult.tsx` — Tool-specific renderers
- `src/client/components/DiffBlock.tsx` — Inline file change diff display
- `src/client/App.tsx` — Activity state, tool result attachment
- `src/client/index.css` — Keyframe animations: `typing-bounce`, `spin-slow`
