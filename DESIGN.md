# Vibe — A Vibe Coding IDE Powered by Claude Code CLI

## Vision

A browser-based IDE for vibe coding: you talk, Claude codes, you watch the result in real time. Powered by your existing Claude subscription via Claude Code CLI — no API keys, no extra costs.

Think "Claude.ai chat but with multi-file project support, live preview, and git history."

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Docker Container                     │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │      Node.js Backend (Fastify + WebSocket)   │    │
│  │  - Spawns `claude -p` per message            │    │
│  │  - Streams NDJSON events → WebSocket         │    │
│  │  - Manages Vite dev server (child process)   │    │
│  │  - Auto-commits after each Claude turn       │    │
│  └──────────┬──────────────────────────────┬────┘    │
│             │                              │         │
│  ┌──────────▼──────────┐  ┌───────────────▼──────┐  │
│  │  Claude Code CLI     │  │  Vite Dev Server     │  │
│  │  (uses subscription) │  │  (:5173)             │  │
│  │  reads/writes files  │  │  HMR, live preview   │  │
│  └──────────┬──────────┘  └───────────────┬──────┘  │
│             │                              │         │
│  ┌──────────▼──────────────────────────────▼──────┐  │
│  │              /workspace (project files)         │  │
│  │              Git repo, source code, assets      │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Exposed ports: 3000 (app UI), 5173 (preview)       │
└─────────────────────────────────────────────────────┘
```

## Core Concepts

### Pure Vibe Coding
The user never edits code directly. All code changes happen through natural language conversation with Claude. The UI is optimized for steering, not editing.

### Claude Code CLI as Engine
We don't call the Anthropic API directly. Instead, we spawn `claude -p` (print mode) with `--output-format stream-json --verbose`. This uses the user's existing Claude subscription (Pro/Max). No API key needed.

### Session Continuity
Each conversation maintains state via Claude Code's `--resume <session_id>`. The user can continue previous conversations or start new ones.

### Git as Undo
Every Claude turn auto-commits to git. The commit history is your undo stack. You can roll back to any previous state with one click.

## Tech Stack

- **Language**: TypeScript (backend and frontend)
- **Backend**: Fastify with @fastify/websocket
- **Frontend**: React + Vite + Tailwind CSS
- **CLI Engine**: Claude Code CLI (`claude -p --output-format stream-json --verbose`)
- **Git**: simple-git
- **File watching**: chokidar
- **Containerization**: Docker + Docker Compose

## UI Layout

Two-column layout. Chat is the primary interaction surface.

```
┌─────────────────────┬─────────────────────┐
│                     │  [Preview] [Docs]   │
│                     │                     │
│       Chat          │  ┌───────────────┐  │
│                     │  │               │  │
│  Claude's responses │  │   Live        │  │
│  with inline diffs  │  │   Preview     │  │
│  and file changes   │  │   (iframe)    │  │
│                     │  │               │  │
│                     │  │   — or —      │  │
│  ┌───────────────┐  │  │               │  │
│  │ Git history   │  │  │   Docs tab    │  │
│  │ (collapsible) │  │  │   (markdown)  │  │
│  └───────────────┘  │  │               │  │
│                     │  └───────────────┘  │
│  [input box    ] 🔘 │                     │
└─────────────────────┴─────────────────────┘
```

### Left Column — Chat
- Message input at the bottom
- Streaming responses from Claude (markdown rendered)
- File changes shown inline as collapsible diff blocks (data from tool_use events)
- Collapsible git history panel (list of commits = list of Claude actions, with rollback buttons)
- Session selector (start new / resume previous)

### Right Column — Tabbed
- **Preview tab** (default): iframe pointing to Vite dev server. Auto-refreshes via HMR.
- **Docs tab**: Markdown renderer for design documents. Shows any `.md` file from the project. User can select which doc to view.

### No File Tree, No Code Editor
This is intentional. In vibe coding, you steer with words. File changes appear inline in the chat as collapsible diffs. The Docs tab covers the case where you want to reference design docs or specs.

## Backend Design

Single Fastify server with @fastify/websocket. Six responsibilities:

### 1. Claude CLI Process Manager
Spawns `claude -p` as a child process per user message. Parses NDJSON from stdout and relays events over WebSocket. Uses `--resume <session_id>` for conversation continuity. Uses `--allowedTools Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch` to pre-approve tool permissions.

Key event types from Claude CLI (NDJSON, one JSON object per line):
- `system` (subtype: `init`) — session start, contains session_id, tools list
- `assistant` — Claude's response, contains text blocks and tool_use blocks
- `user` — tool results, includes structured patches with file path, content, and diffs
- `result` — turn complete, contains total_cost_usd, duration_ms, session_id

### 2. WebSocket Server
Single WebSocket connection per client. Bidirectional messaging:

**Client → Server**: send message (with optional sessionId for resume), rollback to commit, request git log, request doc content, list sessions.

**Server → Client**: claude events (streamed), file change notifications, git log, rollback confirmations, doc content, session list, auth URL (for OAuth flow), errors.

### 3. Vite Dev Server Manager
Spawns Vite as a child process serving `/workspace`. Auto-starts with the backend. The preview iframe in the browser points to the Vite port.

### 4. Git Manager
Uses simple-git. Initializes repo in /workspace if not exists. Auto-commits all changes after each Claude turn (on `result` event). Commit messages generated from Claude's response summary. Provides log and hard-reset for rollback.

### 5. File Watcher
Uses chokidar to watch `/workspace`. Notifies browser via WebSocket so the docs tab stays current. Debounced to avoid flooding during Claude's file operations.

### 6. OAuth Flow Handler
On first run, Claude CLI needs authentication:

1. Backend spawns `claude` interactively (not `-p` mode)
2. Captures the verification URL from stdout/stderr
3. Sends the URL to browser via WebSocket
4. Browser shows it as a clickable link — user authenticates
5. Claude CLI receives token, writes to `~/.claude/`
6. Credentials persist in Docker volume — one-time flow

## Frontend Design

React SPA with minimal dependencies: React, a markdown renderer, a syntax highlighter for inline diffs, and Tailwind CSS. State managed with React's built-in useState/useReducer — no external state library.

### Component Structure
```
App
├── ChatPanel
│   ├── MessageList
│   │   ├── UserMessage
│   │   └── AssistantMessage (text blocks + collapsible file change diffs)
│   ├── GitHistory (collapsible panel with rollback buttons)
│   ├── SessionSelector
│   └── MessageInput
├── RightPanel
│   ├── TabBar (Preview | Docs)
│   ├── PreviewFrame (iframe to Vite dev server)
│   └── DocsViewer (markdown renderer)
└── AuthOverlay (shown when OAuth is needed)
```

## Docker Setup

### Dockerfile
Based on `node:20-slim`. Installs git and Claude Code CLI globally. Copies app, installs dependencies, builds frontend. Exposes ports 3000 (app) and 5173 (preview).

### docker-compose.yml
Single service with two named volumes:
- `workspace` → `/workspace` — project files persist across restarts
- `claude-auth` → `/root/.claude` — CLI credentials persist across restarts

On first run, OAuth flow triggers via the web UI. After authentication, credentials are retained in the volume.

## Project Structure

```
vibe/
├── DESIGN.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── src/
│   ├── server/
│   │   ├── index.ts           # Fastify entry point
│   │   ├── claude.ts          # CLI process manager
│   │   ├── git.ts             # Git operations
│   │   ├── vite-manager.ts    # Vite dev server lifecycle
│   │   ├── watcher.ts         # File watcher
│   │   ├── sessions.ts        # Session persistence
│   │   ├── auth.ts            # OAuth flow detection
│   │   └── types.ts           # Shared types for CLI events, WS messages
│   └── client/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── hooks/
│       │   └── useWebSocket.ts
│       └── components/
│           ├── ChatPanel.tsx
│           ├── MessageList.tsx
│           ├── MessageInput.tsx
│           ├── AssistantMessage.tsx
│           ├── FileChangeBlock.tsx
│           ├── GitHistory.tsx
│           ├── SessionSelector.tsx
│           ├── RightPanel.tsx
│           ├── PreviewFrame.tsx
│           ├── DocsViewer.tsx
│           └── AuthOverlay.tsx
├── vite.config.ts
└── .gitignore
```

## Implementation Plan

### Phase 1: Skeleton (get it running end-to-end)
1. Docker setup — Dockerfile, docker-compose.yml
2. Fastify backend with WebSocket — spawn Claude CLI, parse NDJSON, relay events
3. Minimal React frontend — chat input, message display, WebSocket connection
4. Verify: type message → Claude responds → see response in browser

### Phase 2: Preview
5. Vite dev server manager — spawn as child process serving /workspace
6. Preview iframe in frontend
7. Test: ask Claude to create a React app → see it live in preview

### Phase 3: Git & History
8. Git integration — auto-commit after each turn
9. Git history panel in UI
10. Rollback functionality

### Phase 4: Polish
11. OAuth flow detection and browser redirect
12. Session management (list, resume, new)
13. Docs tab (markdown viewer)
14. Inline file change display in chat (diff blocks)
15. Streaming UX polish (typing indicators, partial renders)

### Phase 5: Nice-to-haves
- Cost display per turn (from result.total_cost_usd)
- Duration display
- Dark/light theme
- Resizable panels
- Search in chat history
- Export conversation

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Type safety for CLI event parsing, better DX |
| Engine | Claude Code CLI | Uses subscription, no API key, built-in tools |
| Backend | Fastify + @fastify/websocket | Modern, fast, first-class WS + TS support |
| Frontend | React + Tailwind | Simple, fast to build |
| Deployment | Docker | Portable, consistent, easy cleanup |
| Chat model | Stateless `claude -p` + `--resume` | Robust, no zombie processes |
| Preview | Vite as child process in container | HMR works, proven, simple |
| File editing | Claude-only (pure vibe coding) | Simpler UI, cleaner UX |
| Git strategy | Auto-commit per Claude turn | Undo stack for free |
| Auth | Intercept CLI OAuth URL in web UI | Seamless, reuses existing flow |

## Open Questions

- **Multiple projects**: For now, one workspace per container. Multiple projects = multiple containers or workspace selection later.
- **Hot reload for non-Vite projects**: MVP assumes Vite/React. Later, could detect project type and adapt preview.
- **Container resources**: Claude CLI is lightweight (HTTP calls). Vite + Node need modest resources. 1GB RAM should suffice.

## Reference: Claude CLI Stream JSON Format

Validated via testing. The output from `claude -p --output-format stream-json --verbose`:

- Output is newline-delimited JSON (NDJSON), one event per line
- The `system.init` event contains: session_id, available tools, model, claude_code_version
- The `assistant` events contain message.content arrays with `text` and `tool_use` blocks
- The `user` events contain tool results with structured data including file paths, content, and patches
- The `result` event contains: session_id, total_cost_usd, duration_ms, usage breakdown, permission_denials
- Tool permissions are handled via `--allowedTools` flag (e.g. `Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch`)
