# ShipIt

A browser-based AI editor — describe what you want in chat, the agent writes the code, and you see results live. Pluggable agent backend: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) is the default, [Codex CLI](https://github.com/openai/codex) is supported, and the architecture is agent-agnostic so additional backends can be added later. Authentication uses your existing subscription with the chosen provider — no per-call API keys required.

ShipIt is the surface: build, review, ship, and debug software inside one chat-shaped IDE. PRs, CI status, deploy status, diffs, commits, conversation history, terminal, and live preview all render inline — no jumping out to GitHub, your hosting dashboard, or a separate terminal.

## Features

### Build
- **Chat-driven development** — describe what you want in natural language; the agent writes the code, runs the commands, and reads the logs
- **Multi-agent backend** — Claude Code CLI by default, Codex CLI also supported; sign in with the subscription you already have
- **Live preview** — embedded iframe shows your app updating in real time, with HMR proxied through ShipIt and multi-port support
- **Project templates** — quick-start scaffolding for React, Vue, Next.js, Svelte, and more
- **File upload & image input** — drop files into the chat; the agent reads them as context
- **Interactive terminal** — full PTY (xterm.js) inside the session container for ad-hoc debugging
- **Monaco code editor** — read and edit files with syntax highlighting and diff view
- **MCP integration** — connect Model Context Protocol servers to extend the agent's tools

### Review & ship
- **Inline PR lifecycle card** — title, description, CI checks, deploy status, and merge state all render in chat; no GitHub tab required
- **AI PR descriptions** — generated from the actual diff when you open a PR
- **Cross-agent review** — have a second agent review the first agent's changes before merging
- **Inline diffs** — file changes displayed as collapsible red/green diff blocks in the chat
- **Auto-deploy on push** — deploy status surfaces inline on the PR card via the GitHub Deployments API
- **PR comment sync** — review threads from GitHub appear inline in the conversation
- **Auto-fix preview failures** — preview crashes are surfaced to the agent so it can fix them on the next turn

### Iterate safely
- **Git as undo** — every agent turn auto-commits; rewind to any previous state, and fork into a new branch from any point
- **Parallel sessions** — spawn separate workspaces with their own branch, container, and chat history; review each as its own PR
- **Worktree-backed sessions** — multiple sessions on the same repo share a bare cache and use git worktrees for isolation
- **Permission modes** — choose how much autonomy the agent has per session
- **Live steering** — interrupt and redirect the agent mid-turn without losing context
- **Session sidebar** — pinned sessions, AI-generated session names, status indicators

### Everywhere
- **Mobile responsive** — tab-based layout on small screens, resizable split panels on desktop
- **Android wrapper** — a thin WebView app under `android/` for native-feeling access on mobile
- **Background notifications** — tab title change and browser notification when the agent finishes
- **Self-update from UI** — pull the latest code, rebuild, and restart from Settings → Advanced

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

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (ShipIt always runs containerized — there is no bare-metal mode)
- A subscription with the AI provider whose CLI you'll use:
  - For Claude Code: [Claude Pro or Max](https://claude.ai/upgrade)
  - For Codex: an OpenAI account with Codex CLI access

For working on ShipIt's own source (not just running it), you also need:

- Node.js 20+ and npm
- git

## Install locally (Docker)

```bash
git clone https://github.com/nicolasalt/shipit.git
cd shipit

# Development (hot-reload, source mounted) — http://localhost:3000
docker/local/dev.sh

# Production (optimized build) — http://localhost:3000
docker/local/prod.sh
```

Both scripts build the orchestrator + session-worker images and start ShipIt with Docker Compose. On first run, ShipIt prompts you to authenticate with the agent provider you've chosen via an OAuth flow in the browser. Credentials are stored in a persistent Docker volume so you only need to do this once per provider.

## Install on a VPS

ShipIt ships with a one-command provisioning script for Ubuntu VPS hosts. It installs Docker, raises the inotify limits session containers need, and optionally puts ShipIt behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (with optional Zero Trust SSO) and/or exposes it over [Tailscale](https://tailscale.com/) — no open inbound ports required.

```bash
ssh root@<server-ip>

apt-get update -qq && apt-get install -y -qq git
git clone https://github.com/nicolasalt/shipit.git /opt/shipit
bash /opt/shipit/deployment/vps/setup.sh
```

The script asks whether you want Cloudflare, Tailscale, both, or neither, then takes care of everything else: installing Docker, configuring host limits, building the images, installing the self-updater + restarter systemd units, and bringing ShipIt up.

Once it's running, updates happen from inside the UI — **Settings → Advanced → Software Updates** — or via `bash /opt/shipit/deployment/vps/deploy.sh` on the host.

See [`deployment/README.md`](deployment/README.md) for the full guide: Hetzner sizing recommendations, Cloudflare Zero Trust access policies, wildcard preview DNS over Tailscale, and troubleshooting.

## Working on ShipIt itself

The hot-reload Docker workflow above is the recommended dev loop — `docker/local/dev.sh` mounts the source tree into the orchestrator container and restarts on change. If you want to run the orchestrator outside Docker (note: session containers still require Docker):

```bash
npm install
npm run dev          # Fastify orchestrator on :3000
npx vite             # Vite dev server with HMR on :5173 (separate terminal)
```

The Vite dev server proxies WebSocket connections to the backend at `localhost:3000`.

### Available Scripts

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

### Running a Single Test

```bash
npx vitest run src/server/git.test.ts
```

## How It Works

1. You type a prompt in the chat input
2. The React frontend sends a JSON message over the per-session WebSocket
3. The orchestrator spawns the configured agent CLI (e.g., `claude -p` for Claude Code, `codex` for Codex) inside that session's Docker container via the session worker's HTTP API
4. The agent CLI streams NDJSON events to stdout as it thinks, writes files, and runs commands
5. The session worker parses each line and streams events to the orchestrator over SSE, which relays them to the browser over WebSocket
6. The frontend updates in real time — streaming text, inline diffs, tool activity indicators
7. When the agent finishes, all file changes are auto-committed to git, debounced auto-push runs if a GitHub remote is wired up, and the PR lifecycle card updates inline
8. The dev server picks up file changes and the preview iframe hot-reloads through the orchestrator's preview proxy

Session continuity is maintained via the agent CLI's resume mechanism (e.g., Claude Code's `--resume` flag). Subsequent messages in the same session resume the conversation context.

## Project Structure

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

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | [Fastify](https://fastify.dev/) 5, @fastify/websocket, TypeScript |
| Frontend | [React](https://react.dev/) 19, [Vite](https://vite.dev/) 7, [Tailwind CSS](https://tailwindcss.com/) 4 |
| Agent backends | [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) — pluggable, more can be added |
| Runtime | Node.js 20, Docker |
| Testing | [Vitest](https://vitest.dev/) 4, @testing-library/react, jsdom |

## Docker Volumes

Persistent volumes survive container restarts:

| Volume | Mount Point | Purpose |
|--------|-------------|---------|
| `workspace` | `/workspace` | Project files that the agent reads and writes |
| `credentials` | `/credentials` | Agent CLI OAuth credentials + GitHub tokens (shared by all sessions) |

Session containers are ephemeral and rebuilt on demand; only the volumes above and the per-repo bare-cache directories on the host persist long-term state.

## Configuration

ShipIt uses environment variables for configuration:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listening port |
| `NODE_ENV` | — | Set to `production` in Docker |

### `shipit.yaml`

Each project can include a `shipit.yaml` at the workspace root to configure preview and dependency installation. All built-in templates ship with one pre-configured.

```yaml
install: npm install        # optional — shell command to install dependencies
preview:                    # required — how to show the live preview
  command: npm run dev      # either: shell command to start a dev server
  # html: index.html        # or: path to an HTML file for static serving
  ports: [5173]             # optional — ports to monitor for readiness
  directory: packages/app   # optional — subdirectory to run from (monorepos)
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `install` | string | No | Shell command run once before preview starts (e.g. `npm install`, `pip install -r requirements.txt`). Tracked via a marker file so it only runs once per session. |
| `preview` | object | Yes | Preview configuration. Must contain exactly one of `command` or `html`. |
| `preview.command` | string | One of `command`/`html` | Shell command that starts the dev server. |
| `preview.html` | string | One of `command`/`html` | Path to an HTML file served via ShipIt's bundled Vite with HMR. |
| `preview.ports` | integer array | No | Explicit ports to watch for server readiness. If omitted, ShipIt auto-detects from common ports. |
| `preview.directory` | string | No | Subdirectory (relative to workspace root) where install and preview commands run. |

**Resolution fallbacks** — when `shipit.yaml` is absent, ShipIt infers the config automatically:

1. `package.json` with a `scripts.dev` field → runs `<pm> run dev` and `<pm> install` (package manager detected from `packageManager` field, then lock files, defaulting to `npm`)
2. `index.html` at the workspace root → static HTML mode
3. Nothing found → no preview

**Examples:**

```yaml
# Static site — no dependencies, just serve a file
preview:
  html: index.html
```

```yaml
# React + Vite
install: npm install
preview:
  command: npm run dev
  ports: [5173]
```

```yaml
# Next.js on a custom port
install: npm install
preview:
  command: next dev --port 3001
  ports: [3001]
```

```yaml
# Python app
install: pip install -r requirements.txt
preview:
  command: python -m http.server 8000
  ports: [8000]
```

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

Apache 2.0 — see [LICENSE](LICENSE) for details.
