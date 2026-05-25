# ShipIt

A browser-based AI editor — describe what you want in chat, the agent writes the code, and you see results live. Pluggable agent backend: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) is the default, [Codex CLI](https://github.com/openai/codex) is supported, and the architecture is agent-agnostic so additional backends can be added later. Authentication uses your existing subscription with the chosen provider — no per-call API keys required.

Three things set ShipIt apart from other AI editors:

- **Container-isolated sessions** — every agent turn runs in its own Docker container, so concurrent sessions can't step on each other's files, processes, or installed dependencies.
- **Self-hostable on a remote server** — ShipIt is Docker-based end to end. Run it on a VPS and your laptop doesn't need to be open for the agent to keep working.
- **First-class previews from Docker Compose** — declare your dev server (and anything else: databases, queues, log tailers) in `docker-compose.yml`; ShipIt surfaces each service as an automatic or manual preview inside the app.

Around that core, ShipIt is the surface: build, review, ship, and debug software inside one chat-shaped IDE. PRs, CI status, deploy status, diffs, commits, conversation history, terminal, and live preview all render inline — no jumping out to GitHub, your hosting dashboard, or a separate terminal.

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

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose v2 plugin (`docker compose`). Docker Desktop bundles it; on Linux install `docker-compose-plugin` alongside `docker-ce`. ShipIt always runs containerized — there is no bare-metal mode.
- A subscription with the AI provider whose CLI you'll use:
  - For Claude Code: [Claude Pro or Max](https://claude.ai/upgrade)
  - For Codex: an OpenAI account with Codex CLI access

If you want to hack on ShipIt itself, see [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, dev loop, and module layout.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture, dev loop, code conventions, and how to submit a PR.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
