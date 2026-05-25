# Contributing to ShipIt

Thanks for your interest in ShipIt! This file covers everything you need to work on ShipIt itself: the architecture, the dev loop, and how the pieces talk to each other.

**Heads up:** ShipIt isn't accepting pull requests right now. Bug reports, feature requests, and design discussion are welcome — please [open an issue](https://github.com/nicolasalt/shipit/issues).

For installing and using ShipIt, see the [README](README.md). For platform docs that the agent reads from inside session containers, see `src/server/shipit-docs/`. For per-feature design notes, see `docs/NNN-feature-name/plan.md`.

## Architecture

Three-layer system: browser → orchestrator → session containers.

```
┌──────────────┐     ┌──────────────────────────────┐     ┌─────────────────────────┐
│   Browser    │     │     Orchestrator Container    │     │  Session Container(s)   │
│  (React SPA) │◄───►│  Fastify + WebSocket + SSE   │◄───►│  Agent CLI, terminal,   │
│              │     │  Routes, services, managers   │     │  preview server, files  │
└──────────────┘     └──────────────────────────────┘     └─────────────────────────┘
     WS + SSE              HTTP proxy to containers            HTTP + SSE back
```

- **Browser** — React 19 SPA with Zustand stores, dual-channel communication (per-session WebSocket + global SSE)
- **Orchestrator** — Fastify server handling auth, session management, git repos, and proxying to containers
- **Session containers** — isolated Docker containers running the AI agent CLI (Claude Code or Codex), terminal PTY, preview dev server, and file watcher

### How a turn flows

1. You type a prompt in the chat input
2. The React frontend sends a JSON message over the per-session WebSocket
3. The orchestrator spawns the configured agent CLI (e.g., `claude -p` for Claude Code, `codex` for Codex) inside that session's Docker container via the session worker's HTTP API
4. The agent CLI streams NDJSON events to stdout as it thinks, writes files, and runs commands
5. The session worker parses each line and streams events to the orchestrator over SSE, which relays them to the browser over WebSocket
6. The frontend updates in real time — streaming text, inline diffs, tool activity indicators
7. When the agent finishes, all file changes are auto-committed to git, debounced auto-push runs if a GitHub remote is wired up, and the PR lifecycle card updates inline
8. The dev server picks up file changes and the preview iframe hot-reloads through the orchestrator's preview proxy

Session continuity is maintained via the agent CLI's resume mechanism (e.g., Claude Code's `--resume` flag). Subsequent messages in the same session resume the conversation context.

### Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | [Fastify](https://fastify.dev/) 5, @fastify/websocket, TypeScript |
| Frontend | [React](https://react.dev/) 19, [Vite](https://vite.dev/) 7, [Tailwind CSS](https://tailwindcss.com/) 4 |
| Agent backends | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) — pluggable, more can be added |
| Runtime | Node.js 20, Docker |
| Testing | [Vitest](https://vitest.dev/) 4, @testing-library/react, jsdom |

## Development setup

**Prerequisites:**

- Node.js 20+ and npm
- git
- Docker (session containers always run containerized)
- At least one agent CLI installed globally if you want to drive the agent locally:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm install -g @anthropic-ai/claude-code`
  - [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`

**Getting started:**

```bash
git clone https://github.com/nicolasalt/shipit.git
cd shipit
npm install
```

## Dev loop

The recommended workflow is the hot-reload Docker script — it mounts the source tree into the orchestrator container and restarts on change:

```bash
docker/local/dev.sh
```

If you want to run the orchestrator outside Docker (note: session containers still require Docker):

```bash
npm run dev          # Fastify orchestrator on :3000
npx vite             # Vite dev server with HMR on :5173 (separate terminal)
```

The Vite dev server proxies WebSocket connections to the backend at `localhost:3000`.

### Available scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the backend dev server (tsx) |
| `npm run build` | Build the frontend with Vite |
| `npm run test:dev` | Run changed tests + smoke tests (fast local iteration) |
| `npm run test:smoke` | Run only smoke tests (core startup/connectivity) |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint `src/` with ESLint |
| `npm run typecheck` | Type-check with `tsc --noEmit` |

## Testing

Tests use [Vitest](https://vitest.dev/) with two project configurations:

- **Server tests** (`src/server/**/*.test.ts`) — run in Node environment
- **Client tests** (`src/client/**/*.test.{ts,tsx}`) — run in jsdom with React Testing Library

The backend uses dependency injection (`buildApp()` accepts an `AppDeps` object) so integration tests can inject stubs instead of spawning real processes.

```bash
npm run test:dev                      # Preferred during development (fast)
npm run test:smoke                    # Smoke coverage only
npm test                              # Full suite
npx vitest run src/server/git.test.ts # Run a specific file
npm run test:watch                    # Watch mode
```

Always run `npm run lint` and `npm run typecheck` before submitting a PR and fix any errors.

## Project structure

```
src/
├── server/
│   ├── orchestrator/       # Main process — HTTP routes, services, DI, WebSocket handlers
│   ├── session/            # Session container worker — agent CLI, terminal, preview, file watcher
│   ├── shared/             # Code shared between orchestrator and session (types, git, utils)
│   └── shipit-docs/        # Platform docs served to the agent inside containers
│
└── client/                 # React 19 SPA
    ├── components/         # UI components (MessageList, FileTree, PreviewFrame, etc.)
    ├── hooks/              # Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    ├── stores/             # Zustand state stores
    └── themes/             # Theme CSS files
```

For the full module-level map and the per-subsystem skills (server architecture, client architecture, session lifecycle, git architecture, etc.), see [`CLAUDE.md`](CLAUDE.md) and `.claude/skills/`.

## Submitting changes

ShipIt isn't accepting pull requests right now. If you've found a bug, have a feature idea, or want to discuss a design, please [open an issue](https://github.com/nicolasalt/shipit/issues) instead.

If you're hacking on your own fork, the quality checks the project gates on are:

```bash
npm run typecheck
npm run lint
npm run test:dev
```

## Code conventions

- **ESM throughout** — use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`)
- **Type imports** — `import type { X } from "./path.js"` for type-only imports
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`)
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE
- **React** — functional components only, hooks for all state and effects
- **Styling** — Tailwind CSS v4 utility classes, dark-mode-only color scheme
- **Icons** — use `@phosphor-icons/react`, never hardcode `<svg>` elements
- **Tests** — co-located with source files (`foo.ts` → `foo.test.ts`)

## Where to start

- Check [open issues](https://github.com/nicolasalt/shipit/issues) for tasks labeled `good first issue`
- Read the feature docs in `docs/NNN-feature-name/plan.md` before modifying a feature
- Look at existing tests near the code you're changing to understand the expected patterns

## Reporting bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser and OS version
- Relevant console output or screenshots
