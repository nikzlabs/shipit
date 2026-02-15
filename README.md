# ShipIt

A browser-based IDE for vibe coding — you talk to Claude in a chat interface and it writes code in real time. Powered by [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and your existing Claude subscription. No API keys needed.

Think of it as a hosted Claude Code session with a web UI: chat panel on the left, live preview on the right, git history as your undo stack.

## Features

- **Chat-driven development** — describe what you want in natural language, Claude writes the code
- **Live preview** — embedded iframe shows your app updating in real time via Vite HMR
- **Git as undo** — every Claude turn auto-commits, roll back to any previous state with one click
- **Session persistence** — conversations survive page reloads and browser restarts
- **Inline diffs** — file changes displayed as collapsible red/green diff blocks in the chat
- **File browser** — read-only file tree with syntax-highlighted content viewer
- **Markdown docs** — browse and read project documentation without leaving the app
- **Terminal output** — Claude CLI stderr/stdout in a terminal-like panel for debugging
- **Project templates** — quick-start scaffolding for React, Vue, Next.js, Svelte, and more
- **Port auto-detection** — preview pane works with any dev server, not just Vite
- **Search in chat** — Ctrl+F / Cmd+F to find text across the conversation
- **Mobile responsive** — tab-based layout on small screens, resizable split panels on desktop
- **Background notifications** — tab title change and browser notification when Claude finishes

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 Docker Container                     │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │      Node.js Backend (Fastify + WebSocket)   │    │
│  │  - Spawns claude -p per message              │    │
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

The server is intentionally thin — it's a bridge between the browser and the Claude CLI. No database, no REST API. All client-server communication happens over a single WebSocket connection at `/ws`.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A [Claude Pro or Max](https://claude.ai/upgrade) subscription (for Claude Code CLI authentication)

For local development without Docker:

- Node.js 20+
- npm
- git
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally (`npm install -g @anthropic-ai/claude-code`)

## Quick Start (Docker)

```bash
git clone https://github.com/anthropics/shipit.git
cd shipit
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

On first run, ShipIt will prompt you to authenticate with your Claude account via an OAuth flow in the browser. Credentials are stored in a persistent Docker volume so you only need to do this once.

## Local Development

```bash
# Install dependencies
npm install

# Start the backend (Fastify on :3000)
npm run dev

# In a separate terminal, start Vite for frontend HMR (:5173)
npx vite
```

The Vite dev server proxies WebSocket connections to the backend at `localhost:3000`.

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the backend dev server (tsx) |
| `npm run build:client` | Build the frontend with Vite |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint `src/` with ESLint |
| `npm run typecheck` | Type-check with `tsc --noEmit` |

### Running a Single Test

```bash
npx vitest run src/server/git.test.ts
```

## How It Works

1. You type a prompt in the chat input
2. The React frontend sends a JSON message over WebSocket
3. The Fastify server spawns `claude -p` (Claude Code CLI in print mode) as a child process
4. Claude CLI streams NDJSON events to stdout as it thinks, writes files, and runs commands
5. The server parses each line and relays events to the browser over WebSocket
6. The frontend updates in real time — streaming text, inline diffs, tool activity indicators
7. When Claude finishes, all file changes are auto-committed to git
8. The Vite dev server picks up changes via HMR and the preview iframe updates

Session continuity is maintained via Claude Code's `--resume` flag. Subsequent messages in the same session resume the conversation context.

## Project Structure

```
src/
├── server/                 # Fastify backend
│   ├── index.ts            # Entry point — buildApp() with dependency injection
│   ├── claude.ts           # Spawns Claude CLI, parses NDJSON stream
│   ├── git.ts              # Git operations — init, auto-commit, log, rollback
│   ├── sessions.ts         # Session CRUD, JSON file persistence
│   ├── chat-history.ts     # Per-session message persistence
│   ├── auth.ts             # Claude CLI OAuth flow detection
│   ├── vite-manager.ts     # Vite dev server lifecycle
│   ├── file-tree.ts        # Workspace directory scanner
│   ├── markdown.ts         # Markdown file discovery
│   ├── port-scanner.ts     # Dev server port auto-detection
│   ├── templates.ts        # Project scaffolding templates
│   └── types.ts            # Shared TypeScript types
│
└── client/                 # React 19 SPA
    ├── App.tsx             # Root component — state, layout, WebSocket dispatch
    ├── index.css           # Tailwind CSS imports + animations
    ├── hooks/              # useWebSocket, useSearch, useResizablePanel, etc.
    └── components/         # MessageList, PreviewFrame, FileTree, GitHistory, etc.
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | [Fastify](https://fastify.dev/) 5, @fastify/websocket, TypeScript |
| Frontend | [React](https://react.dev/) 19, [Vite](https://vite.dev/) 6, [Tailwind CSS](https://tailwindcss.com/) 4 |
| AI Engine | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) |
| Runtime | Node.js 20, Docker |
| Testing | [Vitest](https://vitest.dev/) 4, @testing-library/react, jsdom |

## Docker Volumes

Two named volumes persist data across container restarts:

| Volume | Mount Point | Purpose |
|--------|-------------|---------|
| `workspace` | `/workspace` | Project files that Claude reads and writes |
| `claude-auth` | `/root/.claude` | Claude CLI OAuth credentials |

## Configuration

ShipIt uses environment variables for configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listening port |
| `NODE_ENV` | — | Set to `production` in Docker |

## Testing

Tests use [Vitest](https://vitest.dev/) with two project configurations:

- **Server tests** (`src/server/**/*.test.ts`) — run in Node environment
- **Client tests** (`src/client/**/*.test.{ts,tsx}`) — run in jsdom with React Testing Library

The backend uses dependency injection (`buildApp()` accepts an `AppDeps` object) so integration tests can inject stubs instead of spawning real processes.

```bash
npm test                              # Run everything
npx vitest run src/server/git.test.ts # Run a specific file
npm run test:watch                    # Watch mode
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the quality checks:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```
5. Submit a pull request

### Code Conventions

- ESM throughout — use `.js` extensions in relative imports
- Type-only imports: `import type { X } from "./path.js"`
- Node built-ins with `node:` prefix: `import fs from "node:fs"`
- Functional React components only, hooks for all state and effects
- Tailwind CSS utility classes for styling (dark-mode-only color scheme)

## License

MIT
