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
| `types.ts` | Shared TypeScript types for all WebSocket and Claude event payloads |

The server is intentionally thin — it's a bridge between the browser and the Claude CLI. No database, no auth, no REST API.

### Frontend (`src/client/`)

| File | Role |
|------|------|
| `App.tsx` | Root component — chat state, session tracking, event dispatch |
| `hooks/useWebSocket.ts` | WebSocket lifecycle (connect, reconnect, send/receive JSON) |
| `components/MessageList.tsx` | Renders chat messages, tool invocations, loading indicator |
| `components/MessageInput.tsx` | Auto-resizing textarea, Enter-to-send, disabled while streaming |

### Claude CLI Events (NDJSON)

| Event type | When | Key data |
|-----------|------|----------|
| `system` (init) | Session start | `session_id`, model, available tools |
| `assistant` | Claude responds | Text blocks + tool_use blocks |
| `user` | Tool results | Tool execution output |
| `result` | Turn complete | `session_id`, `total_cost_usd`, `duration_ms` |

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

## What's Not Here Yet

Planned for future phases (see `DESIGN.md`):
- [x] Live preview iframe (Vite dev server manager)
- [x] Git integration (auto-commit, history panel, rollback)
- [ ] OAuth flow detection
- [ ] Session list/resume UI
- [ ] File change diffs
- [ ] Cost/duration display
