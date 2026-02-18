# 024 — Model & Context Display

## Summary

Surface the active model name, context window usage (tokens used / limit), and per-turn token counts in the ShipIt UI. Show a persistent status bar with the model name and a context usage meter, plus per-message token breakdowns in the existing usage modal.

## Motivation

Users currently have no visibility into:
- **Which model** Claude is using (Sonnet, Opus, Haiku) — important for understanding capability and cost
- **Context window consumption** — how much of the conversation context has been used, and when they're approaching the limit (which causes degraded responses or errors)
- **Token counts per turn** — input vs. output tokens, which directly drive cost

The cost badge (`$0.42`) exists but is opaque — users can't tell *why* a turn was expensive (large context? many tool calls? long output?). This feature makes the agent's resource consumption transparent.

## Data Sources

### Already Available

The Claude CLI `stream-json` output already includes most of this data:

1. **Model name**: `ClaudeSystemEvent` (type `"system"`, subtype `"init"`) includes `model?: string`. Currently parsed but not forwarded to the client.

2. **Cost & duration**: `ClaudeResultEvent` (type `"result"`) includes `total_cost_usd` and `duration_ms`. Already tracked by `UsageManager` and shown in the cost badge.

### Needs CLI Support or Estimation

3. **Token counts**: The CLI's `stream-json` output includes token usage in the `result` event. The exact fields depend on CLI version but typically include:
   - `input_tokens` — prompt tokens (system prompt + conversation + tool results)
   - `output_tokens` — completion tokens (assistant text + tool calls)

   If the CLI doesn't expose these directly, they can be **estimated** from the message content using a tokenizer approximation (~4 chars per token for English).

4. **Context window limit**: Known per model:
   - Claude Sonnet 4: 200K tokens
   - Claude Opus 4: 200K tokens
   - Claude Haiku 3.5: 200K tokens

   The limit can be looked up from the model name. Alternatively, track cumulative input tokens as a proxy for context consumption.

## How It Works

### Server-Side

#### Extended Result Event Tracking

Extend the `ClaudeResultEvent` type and `UsageManager` to capture token data:

```typescript
// src/server/types.ts — extend ClaudeResultEvent
export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  // New fields (from CLI stream-json output):
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}
```

#### Extended UsageTurn

```typescript
// src/server/types.ts — extend UsageTurn
export interface UsageTurn {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  // New:
  inputTokens?: number;
  outputTokens?: number;
}
```

#### New Server → Client Messages

```typescript
// src/server/types.ts — additions

/** Sent once after the Claude CLI init event, and on reconnect. */
export interface WsModelInfo {
  type: "model_info";
  model: string;                  // e.g. "claude-sonnet-4-20250514"
  contextWindowTokens: number;    // e.g. 200000
}

/** Sent after each turn completes, extending the existing usage_update. */
// Extend existing WsUsageUpdate:
export interface WsUsageUpdate {
  type: "usage_update";
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
  // New fields:
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  /** Estimated cumulative input tokens across all turns in this session. */
  cumulativeInputTokens?: number;
}
```

#### Model Info Forwarding

In the `system` event handler in `index.ts`, when the CLI sends the init event with a model name:

```typescript
if (event.type === "system" && event.subtype === "init") {
  // ... existing session ID tracking ...

  if (event.model) {
    send({
      type: "model_info",
      model: event.model,
      contextWindowTokens: getContextWindowSize(event.model),
    });
  }
}
```

```typescript
/** Map model identifiers to context window sizes. */
function getContextWindowSize(model: string): number {
  if (model.includes("opus")) return 200_000;
  if (model.includes("sonnet")) return 200_000;
  if (model.includes("haiku")) return 200_000;
  // Default conservative estimate
  return 200_000;
}
```

### Client-Side

#### Status Bar Component (`src/client/components/StatusBar.tsx`)

A thin status bar at the bottom of the chat panel (or integrated into the header) showing:

```
┌──────────────────────────────────────────────────────┐
│ Claude Sonnet 4  │  Context: 42K / 200K ████████░░░  │
└──────────────────────────────────────────────────────┘
```

**Elements:**
- **Model name**: Cleaned up display name (e.g., `claude-sonnet-4-20250514` → `Sonnet 4`)
- **Context meter**: Bar showing estimated context usage as a fraction of the window. Color-coded:
  - Green (0-60%): plenty of room
  - Yellow (60-80%): getting full
  - Orange (80-90%): context pressure, responses may degrade
  - Red (90-100%): near limit, may hit errors

**Positioning**: Below the MessageInput or as a thin bar between the chat and the input. Should be unobtrusive — small text, muted colors — but always visible.

#### Model Name Formatting

```typescript
/** Convert CLI model ID to display name. */
function formatModelName(model: string): string {
  if (model.includes("opus")) return "Opus 4";
  if (model.includes("sonnet-4")) return "Sonnet 4";
  if (model.includes("sonnet-3")) return "Sonnet 3.5";
  if (model.includes("haiku")) return "Haiku 3.5";
  // Fallback: show raw ID
  return model;
}
```

#### Extended Usage Modal

The existing `UsageModal` shows per-session aggregate cost. Extend it with per-turn token breakdowns:

```
┌──────────────────────────────────────────────┐
│  Session Usage                          [×]  │
├──────────────────────────────────────────────┤
│  Model: Sonnet 4                             │
│  Turns: 12                                   │
│  Total Cost: $0.42                           │
│  Total Duration: 8m 23s                      │
│                                              │
│  Context Usage: 42,180 / 200,000 tokens      │
│  ████████████████████░░░░░░░░░░ 21%          │
│                                              │
│  ── Per-Turn Breakdown ──────────────────── │
│                                              │
│  #12  In: 38.2K  Out: 1.2K  $0.05  12s     │
│  #11  In: 35.1K  Out: 3.4K  $0.08  45s     │
│  #10  In: 31.8K  Out: 0.8K  $0.04   8s     │
│  ...                                         │
│                                              │
│  ── Token Totals ────────────────────────── │
│  Input:  38,200 tokens                       │
│  Output: 12,400 tokens                       │
│  Cache reads: 28,100 tokens                  │
└──────────────────────────────────────────────┘
```

#### State Management

```typescript
// New state in App.tsx
const [modelInfo, setModelInfo] = useState<{ model: string; contextWindowTokens: number } | null>(null);
const [contextTokens, setContextTokens] = useState(0);

// In lastMessage handler:
if (data.type === "model_info") {
  setModelInfo({ model: data.model, contextWindowTokens: data.contextWindowTokens });
}

if (data.type === "usage_update") {
  // ... existing cost tracking ...
  if (data.cumulativeInputTokens) {
    setContextTokens(data.cumulativeInputTokens);
  }
}
```

#### Context Warning Toast

When context usage crosses 80%, show a non-blocking warning:

```
⚠️ Context is 82% full. Consider starting a new session for best results.
```

At 95%, show a more prominent warning:

```
🔴 Context is nearly full (95%). Responses may be truncated or degraded.
   [Start New Session]
```

### Context Usage Estimation

If exact token counts aren't available from the CLI, estimate from message content:

```typescript
/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate cumulative context from chat history. */
function estimateContextUsage(messages: ChatMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += estimateTokens(msg.text);
    if (msg.toolUse) {
      for (const tool of msg.toolUse) {
        tokens += estimateTokens(JSON.stringify(tool.input));
      }
    }
    if (msg.toolResults) {
      for (const result of msg.toolResults) {
        tokens += estimateTokens(result.content);
      }
    }
  }
  return tokens;
}
```

This is a rough estimate but good enough for the progress bar. The exact count (if available from the CLI) is preferred and should override the estimate.

## Testing

### Integration Tests (`src/server/integration_tests/model-context.test.ts`)
1. **Model info forwarded**: Claude init event with `model` → client receives `model_info` with correct window size
2. **Token tracking**: Claude result event with tokens → `usage_update` includes token counts
3. **Context window lookup**: Various model strings → correct context window sizes
4. **Missing model**: Init event without `model` field → no `model_info` sent (graceful)

### Component Tests

#### StatusBar (`src/client/components/StatusBar.test.tsx`)
1. Renders model name correctly (raw ID → display name)
2. Context meter shows correct percentage and color
3. Hidden when no model info available
4. Updates when context tokens change

#### Extended UsageModal
1. Shows per-turn token breakdown
2. Shows context usage bar
3. Handles missing token data gracefully (shows "—" instead of 0)

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Extend `ClaudeResultEvent` with token fields, add `WsModelInfo`, extend `WsUsageUpdate` and `UsageTurn` |
| `src/server/index.ts` | Forward `model_info` on system init, include token data in `usage_update` |
| `src/server/usage.ts` | Track `inputTokens`/`outputTokens` per turn |
| `src/client/components/StatusBar.tsx` | New component: model name + context meter |
| `src/client/components/StatusBar.test.tsx` | Component tests |
| `src/client/components/UsageModal.tsx` | Extend with per-turn token breakdown |
| `src/client/App.tsx` | Add `modelInfo` / `contextTokens` state, render StatusBar, handle `model_info` event |
| `src/server/integration_tests/model-context.test.ts` | Integration tests |

## Complexity

Low. Most of the data is already flowing through the system — this is primarily a display feature. The server changes are small (forward existing data, look up context window size). The client work is a new StatusBar component and extending the UsageModal. Estimate: ~300-500 lines of new code.
