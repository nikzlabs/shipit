# 021 — Interrupt and Redirect

## Summary

Add a "Stop" button that lets users interrupt Claude mid-turn, halting the current process. After stopping, users can send a new message to redirect Claude's approach without waiting for the (potentially wrong) turn to complete.

## Motivation

When Claude goes down the wrong path — installing the wrong package, restructuring the wrong file, or taking an approach the user didn't intend — there's currently no way to stop it. Users must wait for the turn to finish, consuming tokens and time, before they can correct course.

The Claude Code App supports interruption on every surface: click stop, type a correction, Claude adjusts. This is a basic UX expectation for any interactive agent and arguably the most impactful low-complexity feature in this analysis.

## How It Works

### Server-Side

#### Interrupt Mechanism

The `ClaudeProcess` class already has a `kill()` method that terminates the PTY process. We need a gentler `interrupt()` method and a new WebSocket message to trigger it.

```typescript
// src/server/claude.ts — additions

/** Send SIGINT to the running process (Ctrl+C equivalent). */
interrupt(): void {
  if (this.proc) {
    // Send Ctrl+C character to the PTY
    this.proc.write("\x03");
  }
}
```

Using `\x03` (ETX / Ctrl+C) through the PTY is the correct approach because:
- The Claude CLI handles SIGINT gracefully — it stops the current operation and exits cleanly
- PTY-based signal delivery matches how a user would interrupt in a terminal
- The process's `onExit` handler fires normally, triggering the existing cleanup flow (auto-commit, port scan, etc.)

If the gentle interrupt doesn't work (process doesn't exit within a timeout), fall back to `kill()`:

```typescript
/** Interrupt the running process. Falls back to kill after timeout. */
interrupt(): void {
  if (!this.proc) return;

  // Send Ctrl+C
  this.proc.write("\x03");

  // If process doesn't exit within 5 seconds, force kill
  const forceKillTimer = setTimeout(() => {
    if (this.proc) {
      console.warn("[claude] Force killing process after interrupt timeout");
      this.kill();
    }
  }, 5000);

  // Clear the force-kill timer when the process exits normally
  this.proc.onExit(() => {
    clearTimeout(forceKillTimer);
  });
}
```

#### New Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsInterruptClaude {
  type: "interrupt_claude";
}

// Server → Client
export interface WsClaudeInterrupted {
  type: "claude_interrupted";
  /** Partial output captured before interruption. */
  partialText?: string;
}
```

Add `WsInterruptClaude` to `WsClientMessage` union and `WsClaudeInterrupted` to `WsServerMessage` union.

#### Handler in `src/server/index.ts`

```typescript
if (msg.type === "interrupt_claude") {
  if (claude) {
    claude.interrupt();
    broadcastLog("server", "Claude process interrupted by user");
    // Note: The 'done' handler will fire when the process exits,
    // which handles auto-commit, queue dequeue, etc.
    // We send claude_interrupted immediately so the client can
    // update UI before the process fully exits.
    send({ type: "claude_interrupted" });
  } else {
    send({ type: "error", message: "No active Claude process to interrupt" });
  }
}
```

#### Interaction with `done` Handler

The existing `done` handler already handles process exit:
- Sets `claude = null`
- Runs auto-commit (captures any partial changes Claude made before interruption)
- Restarts Vite if needed
- Runs port scan
- Dequeues next message if prompt queuing (020) is implemented

After an interrupt, the `done` handler fires with a non-zero exit code. The existing `receivedResult` check handles the "no result event" case by sending an error. We should special-case this for interrupts to not show an error:

```typescript
currentClaude.on("done", async (code: number | null) => {
  // ... existing code ...

  // Don't show error for user-initiated interrupts
  if (!receivedResult && !wasInterrupted) {
    send({ type: "error", message: reason });
  }
});
```

Add a `wasInterrupted` flag to the per-connection state, set to `true` when `interrupt_claude` is received, reset when a new Claude process starts.

#### Interaction with Prompt Queuing (020)

If prompt queuing is implemented, interruption should:
1. Stop the current Claude process
2. **Not** dequeue the next message automatically (the user interrupted for a reason — they want to redirect)
3. Clear the queue and let the user send a fresh message

Alternatively, offer a choice: "Claude was interrupted. [Continue with queued messages] or [Clear queue and redirect]"

For simplicity, the recommended behavior: interrupt clears the queue. The user is interrupting because something is wrong; queued messages based on the wrong approach aren't useful.

### Client-Side

#### Stop Button

A prominent "Stop" button that appears when Claude is processing:

```typescript
// In App.tsx, add to the chat area (below MessageList, above MessageInput):
{isLoading && (
  <StopButton onClick={handleInterrupt} />
)}
```

**Visual design**: A red/orange circular button with a square "stop" icon, positioned prominently near the chat input or in the streaming indicator area:

```
┌─────────────────────────────────────────────┐
│ Claude: I'm going to install react-router   │
│ and restructure all your components...      │
│                                             │
│           [■ Stop]                          │
│                                             │
│ Type your message...                [Send]  │
└─────────────────────────────────────────────┘
```

Alternatively, replace the send button with a stop button during loading:

```
│ Type your redirect message...      [■ Stop] │
```

This is the more common pattern (VS Code, Claude.ai, ChatGPT all do this). The input is still enabled (from prompt queuing feature 020), and the send button becomes a stop button.

#### State Changes on Interrupt

```typescript
const handleInterrupt = useCallback(() => {
  send({ type: "interrupt_claude" });
  // Don't set isLoading = false yet — wait for server confirmation
}, [send]);

// In lastMessage handler:
if (data.type === "claude_interrupted") {
  setIsLoading(false);
  setActivity(undefined);
  // Mark any streaming assistant message as complete (but partial)
  setMessages((prev) => {
    const last = prev[prev.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          streaming: false,
          text: last.text + "\n\n_(Interrupted by user)_",
        },
      ];
    }
    return prev;
  });
}
```

#### Keyboard Shortcut

- **Escape** while Claude is processing: interrupt. This matches the terminal convention of Ctrl+C.
- Add to the keyboard shortcuts overlay.

### Partial Output Handling

When Claude is interrupted mid-turn:
1. Any text Claude has streamed so far remains in the chat (it's already rendered)
2. An "_(Interrupted by user)_" note is appended to the last assistant message
3. Any file changes Claude made before interruption are auto-committed (the `done` handler's auto-commit runs on the partial state)
4. The user can now send a new message. Since `--resume` preserves context, Claude knows what happened before the interruption.

### Git State After Interrupt

Claude may have partially applied changes when interrupted. The auto-commit captures whatever state the files are in. The user can:
- **Continue**: Send a new message. Claude picks up from the partial state.
- **Rollback**: Use the existing rollback UI to revert to the pre-turn commit.
- **Review**: Use the diff panel (017) to see what partial changes were made.

## Testing

### Integration Tests (`src/server/integration_tests/interrupt.test.ts`)
1. **Interrupt active process**: Start Claude → send `interrupt_claude` → verify process exits → verify `claude_interrupted` received
2. **Interrupt when idle**: Send `interrupt_claude` with no active process → verify error message
3. **Partial commit**: Start Claude → let it make some changes → interrupt → verify auto-commit captures partial changes
4. **Resume after interrupt**: Interrupt → send new message with same session → verify `--resume` works
5. **Queue clear on interrupt**: Queue messages → interrupt → verify queue is cleared (if prompt queuing is implemented)

### Component Tests
1. Stop button appears when `isLoading` is true
2. Stop button disappears when `isLoading` is false
3. Clicking stop calls interrupt handler
4. Escape key triggers interrupt during loading
5. "Interrupted by user" note appears on the last message

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsInterruptClaude`, `WsClaudeInterrupted` |
| `src/server/claude.ts` | Add `interrupt()` method with Ctrl+C + force-kill fallback |
| `src/server/index.ts` | Add `interrupt_claude` handler, `wasInterrupted` flag in `done` handler |
| `src/client/App.tsx` | Add interrupt handler, `claude_interrupted` event processing, Escape shortcut |
| `src/client/components/MessageInput.tsx` | Replace Send button with Stop button during loading (or add alongside) |
| `src/client/components/StopButton.tsx` | New component (optional — could be inline in MessageInput) |
| `src/server/integration_tests/interrupt.test.ts` | Integration tests |

## Complexity

Low. The core change is a single `\x03` write to the PTY and a new WebSocket message type. The existing `done` handler already handles process exit cleanup. Most of the work is UI (stop button, interrupted message styling). Estimate: ~200-300 lines of new code.
