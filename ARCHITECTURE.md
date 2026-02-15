# Vibe — High-Level Architecture

## What Is This?

Vibe is a browser-based IDE for "vibe coding" — you talk to Claude in a chat interface and it writes code in real-time inside a Docker container. Think of it as a hosted Claude Code session with a React frontend.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React App (Vite-built, served as static files)   │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌────────────────────────────┐  │  │
│  │  │ MessageInput│  │ MessageList                │  │  │
│  │  │  (textarea) │  │  (chat bubbles + tool use) │  │  │
│  │  └─────────────┘  └────────────────────────────┘  │  │
│  └──────────────┬────────────────────────────────────┘  │
│                 │ WebSocket (JSON)                       │
└─────────────────┼───────────────────────────────────────┘
                  │
┌─────────────────┼───────────────────────────────────────┐
│  Docker         │                                       │
│  Container      ▼                                       │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Fastify Server (:3000)                          │   │
│  │  ├── /ws          → WebSocket endpoint           │   │
│  │  └── /*           → Static files (SPA fallback)  │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │ child_process.spawn                        │
│             ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Claude Code CLI                                 │   │
│  │  claude -p <prompt> --output-format stream-json  │   │
│  │                                                  │   │
│  │  Tools: Write, Read, Edit, Bash, Glob, Grep,    │   │
│  │         WebFetch, WebSearch                      │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │ file I/O                                  │
│             ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  /workspace                                      │   │
│  │  (persistent Docker volume, git-initialized)     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

```
1. User types prompt → MessageInput
2. React sends JSON over WebSocket:  { type: "send_message", text, sessionId? }
3. Fastify spawns Claude CLI as child process (or resumes session)
4. Claude CLI streams NDJSON to stdout
5. Server parses line-by-line → sends { type: "claude_event", event } over WS
6. React updates MessageList in real-time (streaming text + tool use blocks)
7. On "result" event → turn is done, UI unlocks input
```

## Key Components

### Backend (`src/server/`)

| File | Role |
|------|------|
| `index.ts` | Fastify server — WebSocket route, static file serving, SPA fallback |
| `claude.ts` | `ClaudeProcess` class — spawns CLI, parses NDJSON stream, emits events |
| `git.ts` | `GitManager` class — auto-commit after turns, git log, rollback |
| `auth.ts` | `AuthManager` class — OAuth flow detection, credential checking, auth URL capture |
| `types.ts` | Shared TypeScript types for all WebSocket and Claude event payloads |

The server is intentionally thin — it's a bridge between the browser and the Claude CLI. No database, no REST API.

### Frontend (`src/client/`)

| File | Role |
|------|------|
| `App.tsx` | Root component — chat state, session tracking, tab management, event dispatch |
| `hooks/useWebSocket.ts` | WebSocket lifecycle (connect, reconnect, send/receive JSON) |
| `components/MessageList.tsx` | Renders chat messages, tool invocations, loading indicator |
| `components/MessageInput.tsx` | Auto-resizing textarea, Enter-to-send, disabled while streaming |
| `components/PreviewFrame.tsx` | iframe pointing to Vite dev server with reload button |
| `components/DocsViewer.tsx` | Markdown file browser and renderer (using `marked`) |
| `components/GitHistory.tsx` | Collapsible git commit list with rollback buttons |
| `components/SessionSelector.tsx` | Session management — list, resume, new, delete |
| `components/AuthOverlay.tsx` | Full-screen overlay for OAuth authentication flow |

### Claude CLI Events (NDJSON)

| Event type | When | Key data |
|-----------|------|----------|
| `system` (init) | Session start | `session_id`, model, available tools |
| `assistant` | Claude responds | Text blocks + tool_use blocks |
| `user` | Tool results | Tool execution output |
| `result` | Turn complete | `session_id`, `total_cost_usd`, `duration_ms` |

## WebSocket Message Protocol

All client-server communication uses JSON over a single WebSocket connection at `/ws`. Types are defined in `src/server/types.ts`.

### Client → Server Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `send_message` | `text`, `sessionId?` | Send a user message to Claude CLI |
| `get_git_log` | — | Request git commit history |
| `rollback` | `commitHash` | Roll back workspace to a specific commit |
| `list_sessions` | — | List all saved sessions |
| `new_session` | — | Clear current session, start fresh |
| `delete_session` | `sessionId` | Delete a saved session |
| `list_docs` | — | List `.md` files in /workspace |
| `get_doc` | `path` | Request content of a markdown file |

### Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `claude_event` | `event` | Relayed Claude CLI NDJSON event |
| `error` | `message` | Error description |
| `preview_status` | `running`, `port`, `url` | Vite dev server status |
| `git_log` | `commits[]` | Full git commit history |
| `git_committed` | `hash`, `message` | New auto-commit after Claude turn |
| `rollback_complete` | `commitHash` | Rollback succeeded |
| `auth_required` | `url` | OAuth URL for user to authenticate |
| `auth_complete` | — | OAuth flow finished |
| `session_list` | `sessions[]` | List of saved sessions |
| `session_started` | `session` | Session created or resumed |
| `doc_list` | `files[]` | List of markdown file paths |
| `doc_content` | `path`, `content` | Raw markdown file content |

### Adding a New Message Type

1. Add the interface to `src/server/types.ts` (both `WsClientMessage` and/or `WsServerMessage` unions)
2. Add the handler in `src/server/index.ts` inside the `socket.on("message")` callback
3. Add the client-side handler in the `useEffect` in `src/client/App.tsx` that processes `lastMessage`
4. Wire up the UI component to call `send()` with the new message type

## Session Management

- The `session_id` comes from the first `system.init` event
- Subsequent messages include it so the server passes `--resume <id>` to the CLI
- This preserves full conversation context across turns
- Sessions live as long as the container's Claude auth is valid

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Fastify 5, `@fastify/websocket`, `@fastify/static`, TypeScript |
| Frontend | React 19, Vite 6, Tailwind CSS 4, TypeScript |
| AI | Claude Code CLI (globally installed in container) |
| Runtime | Node 20, Docker |
| Dev | `tsx` (dev server), Vite dev proxy for WebSocket |

## Docker Setup

Two persistent volumes:
- **`workspace`** → `/workspace` — the project files Claude reads/writes
- **`claude-auth`** → `/root/.claude` — CLI OAuth credentials

The Dockerfile installs Claude Code CLI globally, pre-builds the React frontend, and initializes a git repo in `/workspace`.

## Build & Run

```bash
# Development (no Docker)
npm run dev          # tsx runs Fastify, serves pre-built client

# Development (with Vite HMR)
npx vite             # Port 5173, proxies /ws → localhost:3000

# Production (Docker)
docker compose up --build   # Builds + runs on port 3000
```
