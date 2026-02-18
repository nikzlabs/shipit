# 026 — Interactive Terminal

## Summary

Replace the passive log viewer (`TerminalPanel`) with a split-pane terminal that keeps the existing log view and adds a real interactive shell via xterm.js + server-side PTY. Users can run commands directly (npm test, git status, curl, etc.) without asking Claude.

## Motivation

The current `TerminalPanel` (`src/client/components/TerminalPanel.tsx`) is a styled log viewer — it renders `LogEntry[]` entries from Claude's stderr/stdout, server events, and preview output. But it's **not interactive**: users cannot type commands, run tests, or inspect the filesystem.

This is a critical gap for an IDE:
- **Testing**: Users must ask Claude to run `npm test` instead of running it themselves
- **Debugging**: Can't manually inspect files, check `node_modules`, or run one-off commands
- **Package management**: Can't `npm install` a dependency on their own
- **Git operations**: Can't `git status` or `git diff` without Claude

Every web IDE (Replit, StackBlitz, Gitpod, CodeSandbox) includes an interactive terminal. ShipIt has the server infrastructure for PTY (it already uses `node-pty` for Claude CLI) — this feature surfaces it to the user.

## How It Works

### Architecture

```
┌──────────────┐        WebSocket         ┌──────────────┐
│   Browser     │  ← terminal_output ──── │   Server      │
│   xterm.js    │  ── terminal_input ──→  │   node-pty    │
│               │  ── terminal_resize ──→ │   (bash/sh)   │
└──────────────┘                          └──────────────┘
```

The terminal is a separate PTY process from Claude. They coexist independently:
- Claude CLI runs in its own PTY (managed by `ClaudeProcess`)
- The user terminal runs in a separate PTY (managed by new `TerminalProcess`)
- Both share the same workspace directory

### Server-Side

#### TerminalProcess (`src/server/terminal.ts`)

```typescript
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";

export class TerminalProcess extends EventEmitter {
  private proc: IPty | null = null;

  /**
   * Spawn an interactive shell in the given directory.
   * Emits "data" for output and "exit" when the shell closes.
   */
  start(cwd: string, cols = 80, rows = 24): void {
    if (this.proc) return; // Already running

    const shell = process.env.SHELL || "/bin/bash";
    this.proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, HOME: "/root", TERM: "xterm-256color" } as Record<string, string>,
    });

    this.proc.onData((data: string) => {
      this.emit("data", data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.emit("exit", exitCode);
      this.proc = null;
    });
  }

  /** Write user input to the shell. */
  write(data: string): void {
    if (this.proc) {
      this.proc.write(data);
    }
  }

  /** Resize the terminal. */
  resize(cols: number, rows: number): void {
    if (this.proc) {
      this.proc.resize(cols, rows);
    }
  }

  /** Kill the shell process. */
  kill(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
```

#### New Message Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsTerminalInput {
  type: "terminal_input";
  data: string;
}

export interface WsTerminalResize {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface WsTerminalStart {
  type: "terminal_start";
}

// Server → Client
export interface WsTerminalOutput {
  type: "terminal_output";
  data: string;
}

export interface WsTerminalExit {
  type: "terminal_exit";
  exitCode: number | null;
}
```

Add to `WsClientMessage` and `WsServerMessage` unions respectively.

#### Handler in `src/server/index.ts`

Per-connection terminal instance:

```typescript
let terminal: TerminalProcess | null = null;

// Start terminal when requested (lazy — don't spawn until user opens terminal tab)
if (msg.type === "terminal_start") {
  if (!terminal) {
    terminal = new TerminalProcess();
    terminal.on("data", (data: string) => {
      send({ type: "terminal_output", data });
    });
    terminal.on("exit", (code: number | null) => {
      send({ type: "terminal_exit", exitCode: code });
      terminal = null;
    });
    terminal.start(activeSessionDir);
  }
}

if (msg.type === "terminal_input") {
  if (terminal) {
    terminal.write(msg.data);
  }
}

if (msg.type === "terminal_resize") {
  if (terminal) {
    const cols = typeof msg.cols === "number" ? Math.max(1, Math.min(500, msg.cols)) : 80;
    const rows = typeof msg.rows === "number" ? Math.max(1, Math.min(200, msg.rows)) : 24;
    terminal.resize(cols, rows);
  }
}

// Clean up on disconnect
socket.on("close", () => {
  if (terminal) {
    terminal.kill();
    terminal = null;
  }
  // ... existing cleanup ...
});
```

### Client-Side

#### InteractiveTerminal Component (`src/client/components/InteractiveTerminal.tsx`)

Uses xterm.js to render a real terminal:

```typescript
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export interface InteractiveTerminalProps {
  /** Write function to send input to the server. */
  onInput: (data: string) => void;
  /** Resize handler to notify server of terminal size changes. */
  onResize: (cols: number, rows: number) => void;
  /** Called when component mounts to request terminal start. */
  onStart: () => void;
}
```

**Features:**
- Full terminal emulation (colors, cursor positioning, scrollback)
- Auto-fit to container size via `FitAddon`
- Clickable URLs via `WebLinksAddon`
- Copy/paste support
- Search within terminal output (Ctrl+Shift+F)
- 1000-line scrollback buffer

**Data flow:**
1. Component mounts → sends `terminal_start` to server
2. Server spawns shell, sends output via `terminal_output`
3. Component writes output to xterm.js Terminal instance
4. User types → xterm.js `onData` fires → sends `terminal_input` to server
5. Container resizes → FitAddon recalculates → sends `terminal_resize` to server

#### TerminalPanel Split Layout

Replace the current Terminal tab with a split view:

```
┌──────────────────────────────────────────────┐
│  Terminal    [Logs │ Shell]                   │
├──────────────────────────────────────────────┤
│                                              │
│  user@shipit:/workspace $ npm test           │
│  ✓ auth.test.ts (3 tests)                    │
│  ✓ api.test.ts (5 tests)                     │
│  8 tests passed                              │
│  user@shipit:/workspace $ _                  │
│                                              │
└──────────────────────────────────────────────┘
```

The tab content has two sub-tabs:
- **Logs**: The existing `TerminalPanel` (agent logs, preview errors, etc.)
- **Shell**: The new `InteractiveTerminal` (real shell)

This preserves the existing log viewer while adding the interactive terminal.

#### State Management in App.tsx

```typescript
// New state
const [terminalMode, setTerminalMode] = useState<"logs" | "shell">("logs");

// Handler for terminal input
const handleTerminalInput = useCallback(
  (data: string) => {
    send({ type: "terminal_input", data });
  },
  [send],
);

const handleTerminalResize = useCallback(
  (cols: number, rows: number) => {
    send({ type: "terminal_resize", cols, rows });
  },
  [send],
);

const handleTerminalStart = useCallback(() => {
  send({ type: "terminal_start" });
}, [send]);

// Process terminal output in lastMessage handler
if (data.type === "terminal_output") {
  // Forward to InteractiveTerminal via ref
  terminalRef.current?.write(data.data);
}

if (data.type === "terminal_exit") {
  // Shell exited — show message, offer restart
}
```

#### Terminal Output Forwarding

Terminal output (`terminal_output`) goes directly to the xterm.js instance via a ref, **not** through React state. This is important for performance — terminal output can be very high frequency (hundreds of messages per second during `npm install`), and routing through React state would cause excessive re-renders.

```typescript
const terminalInstanceRef = useRef<Terminal | null>(null);

// In InteractiveTerminal component:
useEffect(() => {
  // Register write function for parent to call
  terminalInstanceRef.current = term;
}, [term]);
```

### Session Lifecycle

- **Shell per session**: Each session gets its own shell process, cwd set to the session workspace
- **Session switch**: Kill current shell, start new one in new workspace
- **Reconnect**: On WebSocket reconnect, start a new shell (previous shell state is lost — this is expected for web terminals)
- **Tab visibility**: Shell starts lazily when the user first clicks the "Shell" sub-tab (avoids wasting resources if the user never uses it)

### Security Considerations

The terminal gives users full shell access to the session workspace. This is by design — ShipIt runs in a sandboxed container environment where:
- Each session has an isolated workspace directory
- The user is expected to have full control over their workspace
- The Claude CLI already has `Bash` in its tool list, so arbitrary command execution is already possible

No additional sandboxing is needed beyond what the host environment provides.

## Testing

### Integration Tests (`src/server/integration_tests/interactive-terminal.test.ts`)
1. **Start terminal**: Send `terminal_start` → verify shell spawns → verify prompt output received
2. **Input/output**: Send `terminal_input` with "echo hello\n" → verify `terminal_output` contains "hello"
3. **Resize**: Send `terminal_resize` → verify no errors (hard to assert resize took effect)
4. **Exit**: Send `terminal_input` with "exit\n" → verify `terminal_exit` received
5. **Multiple starts**: Send `terminal_start` twice → verify no duplicate shells
6. **Cleanup on disconnect**: Start terminal → close WebSocket → verify process killed

### Component Tests (`src/client/components/InteractiveTerminal.test.tsx`)
1. Mounts and calls onStart
2. Writes received data to terminal instance
3. User input triggers onInput callback
4. Container resize triggers onResize callback
5. Unmount cleans up terminal instance

## Dependencies

New npm packages:
- `@xterm/xterm` (~200KB min+gzip) — terminal emulator
- `@xterm/addon-fit` (~5KB) — auto-resize to container
- `@xterm/addon-web-links` (~5KB) — clickable URLs

Server-side: `node-pty` is already a dependency (used by `ClaudeProcess`).

Total added (client): ~210KB min+gzip.

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsTerminalInput`, `WsTerminalResize`, `WsTerminalStart`, `WsTerminalOutput`, `WsTerminalExit` |
| `src/server/terminal.ts` | New: `TerminalProcess` class |
| `src/server/index.ts` | Add terminal message handlers, per-connection lifecycle |
| `src/client/components/InteractiveTerminal.tsx` | New: xterm.js terminal component |
| `src/client/components/InteractiveTerminal.test.tsx` | Component tests |
| `src/client/components/TerminalPanel.tsx` | Add Logs/Shell sub-tab switcher |
| `src/client/App.tsx` | Add terminal state, handlers, output forwarding |
| `src/server/integration_tests/interactive-terminal.test.ts` | Integration tests |
| `package.json` | Add xterm.js dependencies |

## Complexity

Medium. The PTY infrastructure already exists (node-pty in ClaudeProcess). The main work is:
- New `TerminalProcess` class (simple — ~60 lines)
- xterm.js integration (well-documented, ~150 lines)
- WebSocket message plumbing (~100 lines)
- Performance considerations for high-frequency output

Estimate: ~500-700 lines of new code + dependency additions.
