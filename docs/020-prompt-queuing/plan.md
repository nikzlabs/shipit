---
status: planned
---
# 020 — Prompt Queuing

## Summary

Allow users to submit follow-up messages while Claude is still processing a previous request. Messages are queued and executed sequentially after the current turn completes. The chat input remains enabled during processing, and queued messages are shown in the chat with a visual "queued" indicator.

## Motivation

Currently, `MessageInput` is disabled (`disabled={isLoading}`) while Claude is processing. Users must wait for a turn to finish before sending the next message. This creates friction:

1. **Lost context**: Users think of follow-ups while watching Claude work but forget by the time Claude finishes
2. **Wasted time**: Users stare at a disabled input instead of queueing their next instruction
3. **No course correction**: If Claude starts going in the wrong direction, users can't queue "Actually, use approach X instead" (this is distinct from interruption, which is feature 021)

The Claude Code web app supports this: prompts are queued and executed after the current step. ShipIt should match this behavior.

## How It Works

### Server-Side

The server manages a per-connection message queue.

```typescript
// Per-connection state additions in index.ts WebSocket handler:
const messageQueue: Array<{
  text: string;
  images?: ImageAttachment[];
}> = [];
let isClaudeRunning = false;
```

**Queue logic in `send_message` handler:**

```typescript
if (msg.type === "send_message") {
  // ... existing auth checks ...

  if (isClaudeRunning) {
    // Queue the message instead of spawning a new Claude process
    messageQueue.push({ text: msg.text, images: msg.images });
    send({
      type: "message_queued",
      position: messageQueue.length,
      text: msg.text,
    });
    return;
  }

  isClaudeRunning = true;
  // ... existing Claude spawn logic ...
}
```

**Dequeue logic in `done` handler:**

```typescript
currentClaude.on("done", async (code: number | null) => {
  // ... existing auto-commit, port scan, etc. ...

  isClaudeRunning = false;

  // Process next queued message if any
  if (messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    // Trigger send_message handler with the queued message
    // (reuse the same session ID and context)
    const syntheticMsg = {
      type: "send_message" as const,
      text: next.text,
      sessionId: activeAppSessionId,
      images: next.images,
    };
    // Process it (recursive call to message handler logic)
    handleSendMessage(syntheticMsg);
  }
});
```

**Important**: The dequeue happens after auto-commit completes but before the client's loading state is cleared. From the client's perspective, it should look like Claude is continuously working through the queue.

#### New Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsCancelQueuedMessage {
  type: "cancel_queued_message";
  /** Position in queue (0-indexed) to cancel, or "all" to clear queue. */
  position: number | "all";
}

// Server → Client
export interface WsMessageQueued {
  type: "message_queued";
  /** Position in queue (1-indexed for display). */
  position: number;
  text: string;
}

export interface WsQueueUpdated {
  type: "queue_updated";
  /** Current queue contents after a cancel/reorder. */
  queue: Array<{ text: string; position: number }>;
}
```

### Client-Side

#### Chat Input Behavior

The key UX change: **the MessageInput component is no longer disabled during loading**.

```typescript
// In App.tsx, change:
<MessageInput onSend={handleSend} disabled={isLoading || status !== "open"} />
// To:
<MessageInput onSend={handleSend} disabled={status !== "open"} />
```

The `handleSend` callback already handles sending the WebSocket message; the server decides whether to execute immediately or queue.

#### Queued Message Display

Queued messages appear in the chat as user messages with a special "queued" visual treatment:

```
User: Build a React form component          ← executing (normal)
Claude: I'll create the form component...   ← streaming
User: Also add form validation              ← queued (dimmed, with badge)
User: And write tests for it                ← queued (dimmed, with badge)
```

```typescript
// New ChatMessage property
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  // ... existing fields ...
  queued?: boolean;      // true for messages waiting in queue
  queuePosition?: number; // 1-indexed position
}
```

**Visual treatment for queued messages:**
- Slightly dimmed text (`opacity-60`)
- Small badge: "Queued #1", "Queued #2"
- Right-click or hover reveals "Cancel" button to remove from queue
- When dequeued and executed, the `queued` flag is removed and the message appears normally

#### Queue Indicator

A small indicator near the chat input showing queue status:

```
┌─────────────────────────────────────────────┐
│ 2 messages queued [Clear Queue]             │
│                                             │
│ Type your message...                [Send]  │
└─────────────────────────────────────────────┘
```

#### State Management

```typescript
// New state in App.tsx
const [queuedMessages, setQueuedMessages] = useState<Array<{ text: string; position: number }>>([]);
```

**On `message_queued`**: Add the message to the chat (with `queued: true`) and update the queue counter.

**On `queue_updated`**: Sync the queue state (handles cancellations).

**On message execution** (when the next queued message starts): Update the corresponding chat message to remove the `queued` flag.

### Edge Cases

1. **WebSocket disconnect while queue has items**: Clear the queue on disconnect. Queued messages are lost (they weren't submitted to Claude yet, so no data loss). Show a notification: "Connection lost. 2 queued messages were cleared."

2. **Claude error exits**: If Claude crashes or errors, the queue should still process. The `done` handler fires on all exits; the dequeue logic runs regardless of exit code.

3. **Session switch while queue has items**: Clear the queue. Queued messages belong to the current session context.

4. **answer_question while queue has items**: Tool questions from Claude take priority. The queue pauses until the question is answered, then Claude continues, then the queue resumes.

5. **Cancel queued message**: Client sends `cancel_queued_message` with position. Server removes it from the queue and broadcasts `queue_updated`.

6. **Multiple images in queued messages**: Images are stored in the queue alongside text. No special handling needed — they're passed to Claude when the queued message executes.

## Testing

### Integration Tests (`src/server/integration_tests/prompt-queuing.test.ts`)
1. **Queue while busy**: Start Claude → send second message → verify `message_queued` received → Claude finishes → verify second message executes
2. **Multiple queued**: Queue 3 messages → verify they execute in order
3. **Cancel queued**: Queue message → cancel it → verify `queue_updated` with empty queue
4. **Error + dequeue**: Claude errors → next queued message still executes
5. **Session switch clears queue**: Queue messages → switch session → verify queue is cleared

### Component Tests
1. Chat input is enabled during loading
2. Queued messages render with dimmed style and badge
3. Queue indicator shows count
4. Cancel button removes queued message
5. Clear Queue button empties queue

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsCancelQueuedMessage`, `WsMessageQueued`, `WsQueueUpdated` |
| `src/server/index.ts` | Add queue array per connection, queue logic in `send_message`, dequeue in `done` handler, `cancel_queued_message` handler |
| `src/client/App.tsx` | Remove `isLoading` from MessageInput disabled prop, add queue state, handle `message_queued` and `queue_updated` events |
| `src/client/components/MessageList.tsx` | Render queued messages with dimmed style |
| `src/client/components/QueueIndicator.tsx` | New small component showing queue count |
| `src/server/integration_tests/prompt-queuing.test.ts` | Integration tests |

## Complexity

Low-medium. The core change is a FIFO queue on the server (a simple array) and keeping the client input enabled. The main complexity is in edge cases (disconnect, errors, session switch). Estimate: ~300-400 lines of new code.
