---
status: planned
---
# 041 — Persistent Session Runners

## Problem

Today, all per-session runtime state (Claude process, terminal, message queue, accumulated text, auto-push timer) lives inside the WebSocket connection closure in `index.ts`. This creates three user-visible problems:

1. **Closing the browser tab kills the Claude process.** If the user closes the tab (or refreshes, or loses network), `socket.on("close")` fires and calls `claude.kill()`. Any in-flight work is lost.

2. **Switching sessions kills the previous session's agent.** Only one Claude process can exist per connection. When the user switches away, the old process is implicitly abandoned (and killed on the next `send_message` via "stale agent" cleanup).

3. **Only one session can be actively working at a time.** Because there is a single `claude` variable per connection, users cannot have multiple sessions running agents concurrently.

### Goal

Closing a tab, switching sessions, or navigating away should **never** affect running agents. Multiple sessions should be able to run agents simultaneously. When the user reconnects or switches back to a session, they should see the current state (streaming output, or completed results they missed).

---

## Design Overview

Introduce a **SessionRunner** — a per-session container that owns all runtime state currently scoped to the WebSocket connection. The WebSocket connection becomes a lightweight "viewer" that attaches to and detaches from SessionRunners.

```
Before (current):
  Connection ──owns──▶ claude, terminal, queue, accumulatedText, ...
  Connection ──owns──▶ activeSessionId

After (proposed):
  SessionRunner(sessionA) ──owns──▶ claude, terminal, queue, accumulatedText, ...
  SessionRunner(sessionB) ──owns──▶ claude, terminal, queue, accumulatedText, ...
  Connection ──views──▶ SessionRunner(sessionA)
  Connection ──can switch to──▶ SessionRunner(sessionB)
```

### Key Principles

- **SessionRunners are long-lived.** They survive connection drops and session switches.
- **Connections are short-lived viewers.** They subscribe to a runner's event stream and forward events to the WebSocket client.
- **Runners are created on demand** when a session first needs one (first `send_message`), and cleaned up after idle timeout or archive.
- **Multiple runners can be active simultaneously.** Each session gets its own independent runner.

---

## Detailed Design

### 1. SessionRunner class

New file: `src/server/session-runner.ts`

```typescript
import { EventEmitter } from "node:events";
import type { AgentProcess, AgentId, AgentEvent } from "./agents/agent-process.js";
import type { WsServerMessage, ImageAttachment, FileContextRef, PermissionMode } from "./types.js";
import type { TerminalProcess } from "./terminal.js";

interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

/**
 * Per-session container for runtime state. Owns the agent process,
 * terminal, message queue, and accumulated turn data. Survives
 * connection drops and session switches.
 *
 * Emits:
 * - "message" (WsServerMessage) — any message that should be forwarded to attached viewers
 * - "idle" — agent finished and no queued messages remain
 * - "disposed" — runner has been cleaned up
 */
export class SessionRunner extends EventEmitter {
  readonly sessionId: string;
  readonly sessionDir: string;

  // Agent state
  private agent: AgentProcess | null = null;
  private agentId: AgentId;
  private isRunning = false;
  private wasInterrupted = false;
  private accumulatedText = "";
  private accumulatedToolUse: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
  private turnSummary = "";

  // Message queue
  private messageQueue: QueuedMessage[] = [];

  // Terminal
  private terminal: TerminalProcess | null = null;

  // Auto-push timer
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  // Event buffer — stores messages from the current turn so that
  // a reconnecting client can catch up without re-running the agent.
  private turnEventBuffer: WsServerMessage[] = [];

  // Idle cleanup timer
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs: number;

  constructor(opts: {
    sessionId: string;
    sessionDir: string;
    defaultAgentId: AgentId;
    idleTimeoutMs?: number; // default: 10 minutes
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.sessionDir = opts.sessionDir;
    this.agentId = opts.defaultAgentId;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000;
    this.resetIdleTimer();
  }

  // --- Public API ---

  /** Whether the agent is currently processing a message. */
  get running(): boolean { return this.isRunning; }

  /** Get the current turn's buffered events for reconnection replay. */
  getTurnEventBuffer(): WsServerMessage[] { return [...this.turnEventBuffer]; }

  /** Get a snapshot of the queue for UI display. */
  getQueueSnapshot(): Array<{ text: string; position: number }> {
    return this.messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 }));
  }

  // ... agent lifecycle methods (run, interrupt, kill) ...
  // ... terminal lifecycle methods ...
  // ... queue management ...

  /**
   * Emit a message to all attached viewers and buffer it for reconnection.
   * This replaces the per-connection `send()` call.
   */
  private emitMessage(msg: WsServerMessage): void {
    this.turnEventBuffer.push(msg);
    this.emit("message", msg);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.isRunning && this.messageQueue.length === 0) {
        this.dispose();
      }
    }, this.idleTimeoutMs);
  }

  dispose(): void {
    if (this.agent) { this.agent.kill(); this.agent = null; }
    if (this.terminal) { this.terminal.kill(); this.terminal = null; }
    if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.messageQueue.length = 0;
    this.turnEventBuffer = [];
    this.emit("disposed");
    this.removeAllListeners();
  }
}
```

### 2. SessionRunnerRegistry

New addition in `src/server/session-runner.ts` (or separate file):

```typescript
/**
 * App-level registry of active SessionRunners. One runner per session.
 * Manages lifecycle (create, get, dispose) and enforces resource limits.
 */
export class SessionRunnerRegistry {
  private runners = new Map<string, SessionRunner>();
  private maxConcurrentRunners: number;

  constructor(opts?: { maxConcurrentRunners?: number }) {
    this.maxConcurrentRunners = opts?.maxConcurrentRunners ?? 10;
  }

  /** Get or create a runner for the given session. */
  getOrCreate(sessionId: string, sessionDir: string, defaultAgentId: AgentId): SessionRunner {
    let runner = this.runners.get(sessionId);
    if (!runner) {
      runner = new SessionRunner({ sessionId, sessionDir, defaultAgentId });
      runner.on("disposed", () => this.runners.delete(sessionId));
      this.runners.set(sessionId, runner);
    }
    return runner;
  }

  /** Get existing runner (if any). */
  get(sessionId: string): SessionRunner | undefined {
    return this.runners.get(sessionId);
  }

  /** List all sessions with active (running) agents. */
  listActive(): string[] {
    return [...this.runners.entries()]
      .filter(([, r]) => r.running)
      .map(([id]) => id);
  }

  /** Dispose a specific runner. */
  dispose(sessionId: string): void {
    this.runners.get(sessionId)?.dispose();
  }

  /** Dispose all runners (for full_reset / shutdown). */
  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
  }
}
```

### 3. Connection as viewer — attach/detach pattern

The WebSocket connection no longer owns runtime state. Instead it:

1. **Attaches** to a SessionRunner when activating a session
2. **Receives events** by listening to the runner's `"message"` event
3. **Detaches** when switching sessions or disconnecting (but the runner keeps going)

```typescript
// In the WebSocket route handler (index.ts):

let attachedRunner: SessionRunner | null = null;
let messageListener: ((msg: WsServerMessage) => void) | null = null;

const attachToRunner = (runner: SessionRunner) => {
  // Detach from previous runner
  detachFromRunner();

  attachedRunner = runner;
  messageListener = (msg: WsServerMessage) => send(msg);
  runner.on("message", messageListener);

  // Replay buffered events from the current turn so client catches up
  for (const buffered of runner.getTurnEventBuffer()) {
    send(buffered);
  }

  // Send current queue state
  if (runner.getQueueSnapshot().length > 0) {
    send({ type: "queue_updated", queue: runner.getQueueSnapshot() });
  }

  // Send running status so client shows the right UI state
  send({ type: "session_status", sessionId: runner.sessionId, running: runner.running });
};

const detachFromRunner = () => {
  if (attachedRunner && messageListener) {
    attachedRunner.off("message", messageListener);
  }
  attachedRunner = null;
  messageListener = null;
};

// On disconnect — just detach, don't kill anything
socket.on("close", () => {
  detachFromRunner();
  clients.delete(socket);
  // Runner keeps going!
});
```

### 4. Event buffering for reconnection

When a client reconnects to a session that has an active agent, it needs to see:

1. **The turn's events so far** — all `agent_event`/`claude_event` messages since the current turn started. These are buffered in `SessionRunner.turnEventBuffer`.
2. **Session metadata** — running state, queue, model info. Sent via `session_status` message.

The turn event buffer is cleared when a new turn starts (new `send_message`), so it only holds events for the current/most-recent turn. For older turns, the client loads persisted chat history as it does today.

**Buffer size limit**: Cap `turnEventBuffer` at ~1000 messages. If exceeded, keep the first few (init, model_info) and the most recent N. This prevents unbounded memory growth for very long agent turns.

### 5. New WebSocket messages

#### Client → Server

| Message | Purpose |
|---------|---------|
| `get_session_status { sessionId }` | Request current runtime status (running, queued messages, etc.) |

#### Server → Client

| Message | Purpose |
|---------|---------|
| `session_status { sessionId, running, queueLength }` | Current runtime state of a session |
| `session_agent_started { sessionId }` | Agent started running in a session (broadcast to all clients) |
| `session_agent_finished { sessionId }` | Agent finished in a session (broadcast to all clients) |

The `session_agent_started`/`session_agent_finished` messages are **broadcast** to all connected clients so that the sidebar can show activity indicators on sessions that have agents running, even if the client isn't currently viewing that session.

### 6. Preview and file watcher — per-session, ref-counted by viewers

Preview and file watcher are **not** global singletons (a single global would break multi-tab). They are also **not** always-running per-session resources (no value running a preview server for a session nobody is looking at). Instead they are **per-session, ref-counted by active viewers**.

A session's preview/file-watcher runs **if and only if** at least one connection is viewing that session.

**Behavior**:
- When a connection attaches to a session (view/switch), increment the session's viewer ref count. If going from 0→1, start preview and file watcher for that session.
- When a connection detaches (switch away, disconnect), decrement. If going from 1→0, stop preview and file watcher.
- Two tabs viewing the same session share one preview server and one file watcher.
- Two tabs viewing different sessions each get their own.

**Implementation**: `SessionRunner` holds optional `PreviewManager` and `FileWatcher` instances. They are lazily created when the first viewer attaches, and stopped when the last viewer detaches. The runner itself (agent, queue) lives independently of the viewer count.

```typescript
class SessionRunner {
  private viewerCount = 0;
  private preview: PreviewManager | null = null;
  private fileWatcher: FileWatcher | null = null;

  attachViewer(): void {
    this.viewerCount++;
    if (this.viewerCount === 1) {
      // First viewer — start preview and file watcher
      this.preview = new PreviewManager();
      this.preview.start(this.sessionDir);
      this.fileWatcher = new FileWatcher();
      this.fileWatcher.start(this.sessionDir);
    }
  }

  detachViewer(): void {
    this.viewerCount = Math.max(0, this.viewerCount - 1);
    if (this.viewerCount === 0) {
      // Last viewer left — stop preview and file watcher
      this.preview?.stop();
      this.preview = null;
      this.fileWatcher?.stop();
      this.fileWatcher = null;
    }
  }
}
```

**Port scanning**: Each session's preview runs on its own port(s). The port scanner tracks which ports belong to which session. Detected ports are sent to viewers of that session only, not broadcast globally.

**File change broadcast**: File watcher changes are sent to all viewers attached to that session's runner, not to all connected clients.

**Why ref-counted instead of always-on**: Preview servers consume ports and memory. File watchers consume OS file descriptors. Running them for sessions nobody is looking at wastes resources for zero benefit.

**On reattach after background agent finishes**: When the user switches back to a session whose agent finished while they were away, `attachViewer()` starts a fresh preview and triggers a port scan, so the user sees whatever the agent created.

### 7. Terminal persistence

Terminals move from per-connection to per-session (inside SessionRunner). When the user switches back to a session, the terminal is still there with its full scrollback.

The terminal's PTY output is buffered in SessionRunner (rolling buffer of recent output) so that reconnecting clients can see recent terminal content.

### 8. Changes to `HandlerContext`

The HandlerContext currently exposes per-connection state via getters/setters. With SessionRunners, most of these move into the runner:

```typescript
// Before (per-connection):
ctx.getAgent()           // → runner.agent
ctx.getIsClaudeRunning() // → runner.running
ctx.getMessageQueue()    // → runner.messageQueue
ctx.getAccumulatedText() // → runner.accumulatedText

// After:
ctx.getRunner()          // → SessionRunner (or null if no session active)
ctx.getRunnerRegistry()  // → SessionRunnerRegistry (app-level)
```

The `send()` function on HandlerContext needs to be split:
- **`ctx.send()`** — sends directly to the requesting connection (for request-response like `session_list`, `error`)
- **`runner.emitMessage()`** — sends to all attached viewers of a session (for streaming events, status updates)

### 9. Changes to `activateSession()`

```typescript
// Current behavior:
activateSession(sessionId) → stops preview, clears logs, restarts file watcher

// New behavior:
activateSession(sessionId) → attaches connection to session's runner,
                              switches preview/file-watcher to session dir (phase 1),
                              sends turn buffer replay + session status
```

Critically: `activateSession` no longer kills the previous session's agent. It just detaches the viewer.

### 10. Changes to `socket.on("close")`

```typescript
// Current:
socket.on("close") → kill claude, kill terminal, clear queue

// New:
socket.on("close") → detach from runner, remove from clients set
// Runner and all its processes keep running
```

### 11. Changes to `send_message` / `runClaudeWithMessage`

Instead of creating an `AgentProcess` in the connection closure, `handleSendMessage` delegates to the SessionRunner:

```typescript
export async function handleSendMessage(ctx, msg) {
  // ... auth check, image validation ...

  const runner = ctx.getRunnerRegistry().getOrCreate(
    msg.sessionId, sessionDir, ctx.defaultAgentId
  );

  // Attach viewer if not already attached
  ctx.attachToRunner(runner);

  if (runner.running) {
    // Queue message on the runner (not the connection)
    runner.enqueue({ text: msg.text, images, files, permissionMode });
    ctx.send({ type: "message_queued", position: runner.queueLength, text: msg.text });
    return;
  }

  await runner.runAgent({ ... });
}
```

### 12. Sidebar activity indicators

The client needs to know which sessions have running agents, even for sessions not currently being viewed. The `session_agent_started` / `session_agent_finished` broadcast messages enable this.

The sidebar can show a pulsing dot or spinner next to sessions with active agents.

---

## Phased Implementation

### Phase 1: Agent persistence (core value)

**Goal**: Closing tab or switching session doesn't kill the agent. Users can have multiple sessions running simultaneously.

**Scope**:
- Implement `SessionRunner` and `SessionRunnerRegistry`
- Move agent process, message queue, accumulated state, auto-push timer into SessionRunner
- Implement attach/detach pattern for connections
- Implement turn event buffering for reconnection replay
- Add `session_status`, `session_agent_started`, `session_agent_finished` messages
- Change `socket.on("close")` to detach instead of kill
- Change `activateSession()` to attach instead of kill
- Add sidebar activity indicators for sessions with running agents
- Preview/file-watcher move into SessionRunner, ref-counted by attached viewers (start on first viewer, stop on last)
- Terminal stays per-connection for now

**Files to modify**:
- `src/server/session-runner.ts` — **new**: SessionRunner, SessionRunnerRegistry
- `src/server/index.ts` — registry creation, connection attach/detach, remove per-connection agent state, remove global PreviewManager/FileWatcher
- `src/server/ws-handlers/types.ts` — add runner methods to HandlerContext
- `src/server/ws-handlers/send-message.ts` — delegate to runner
- `src/server/ws-handlers/misc-handlers.ts` — interrupt via runner
- `src/server/ws-handlers/session-handlers.ts` — attach on switch, don't kill
- `src/server/types.ts` — new message types
- `src/client/App.tsx` — handle new messages, show activity indicators
- `src/client/components/Sidebar.tsx` — activity indicator UI
- Integration tests

### Phase 2: Terminal persistence

**Goal**: Terminal sessions survive tab close and session switch.

**Scope**:
- Move terminal into SessionRunner
- Buffer recent PTY output (rolling 10K characters) for reconnection replay
- Terminal switch on session switch shows existing terminal

Note: Preview/file-watcher are handled in Phase 1 as part of the SessionRunner design (ref-counted by viewers). See section 6.

---

## Resource Management

### Idle cleanup

SessionRunners that have no active agent and no attached viewers are disposed after an idle timeout (default 10 minutes). This prevents unbounded memory growth from accumulated runners.

### Concurrent runner limit

The registry enforces a maximum number of concurrent runners (default 10). When the limit is reached, the oldest idle runner is disposed to make room. If all runners are active (running agents), the new request is rejected with an error.

### Memory bounds

- Turn event buffer: capped at 1000 messages per runner
- Terminal output buffer: capped at 10K characters per runner
- Message queue: capped at 50 messages per runner (matches existing implicit limit)

---

## Migration / Backward Compatibility

The WebSocket protocol remains backward compatible. Existing messages continue to work. New messages (`session_status`, `session_agent_started`, `session_agent_finished`) are additive — old clients that don't handle them simply ignore them.

The client will need updates to:
1. Handle reconnection replay (deduplicate if messages arrive that match persisted history)
2. Show activity indicators in the sidebar
3. Not clear streaming UI state on reconnect if the agent is still running

---

## Edge Cases

### 1. User sends message to session A, switches to session B, switches back to A

Session A's runner is still running. On switch back, the connection attaches to runner A and replays buffered events. The client sees the streaming output from where it left off (or the completed result if the agent finished while they were away).

### 2. User refreshes the page mid-stream

Connection closes → detach (runner keeps going). New connection opens → client loads chat history → calls `get_session_status` → if runner is active, attaches and replays turn buffer.

### 3. Two browser tabs viewing the same session

Both connections attach to the same SessionRunner. Both receive the same event stream. One tab sending `interrupt_claude` interrupts the shared agent — both tabs see the interruption.

### 4. Agent finishes while no client is connected

The runner completes the turn: auto-commit, port scan, queue processing all happen normally. Results are persisted to chat history. When the client reconnects, they see the completed conversation from chat history.

### 5. Idle timeout fires while agent is running

The idle timer only fires when `!isRunning && queue.length === 0`. A running agent resets the timer on completion. So this case cannot happen.

### 6. Archive session with running agent

Archiving a session should stop its runner. `handleArchiveSession` calls `registry.dispose(sessionId)` which kills the agent and cleans up.

---

## Testing Strategy

### Unit tests for SessionRunner
- Agent lifecycle (start, interrupt, finish, queue processing)
- Event buffering (messages buffered, cap enforced, cleared on new turn)
- Idle timeout (fires when idle, doesn't fire when running)
- Dispose (all resources cleaned up, listeners removed)

### Unit tests for SessionRunnerRegistry
- Get-or-create semantics
- Concurrent runner limit
- Dispose removes from registry
- DisposeAll cleans everything

### Integration tests
- `persistent-sessions.test.ts`:
  - Agent keeps running after connection close
  - Reconnection replays buffered events
  - Session switch doesn't kill previous session's agent
  - Multiple concurrent agents across sessions
  - Interrupt works via runner
  - Archive kills runner
  - Queue persists across connection drops
  - Sidebar activity broadcast messages

---

## Key Files

| File | Role |
|------|------|
| `src/server/session-runner.ts` | SessionRunner + registry (new) |
| `src/server/index.ts` | WebSocket route, attach/detach, registry wiring |
| `src/server/ws-handlers/types.ts` | HandlerContext additions |
| `src/server/ws-handlers/send-message.ts` | Delegate to runner |
| `src/server/ws-handlers/session-handlers.ts` | Attach on switch |
| `src/server/ws-handlers/misc-handlers.ts` | Interrupt via runner |
| `src/server/types.ts` | New message type definitions |
| `src/client/App.tsx` | Handle new messages, reconnection replay |
| `src/client/components/Sidebar.tsx` | Activity indicators |
| `docs/040-session-lifecycle-analysis/plan.md` | Prior art / context |
