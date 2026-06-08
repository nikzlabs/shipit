# Environment

You are running inside a Docker container managed by ShipIt.

## Filesystem layout

| Path | Description |
|------|-------------|
| `/workspace` | Project root. This is the git repo. Your working directory. |
| `/uploads` | User-uploaded files (outside git, never committed). |
| `/tmp` | Scratch space — use for temporary files, unpacking archives. |
| `/credentials` | OAuth tokens (managed by ShipIt). Holds **only the credentials for this session's agent** — a Claude session sees `~/.claude` but not `~/.codex`, and vice versa. The agent is pinned on the first message and can't be changed afterward. |
| `/dep-cache` | Shared npm/yarn/pnpm cache across sessions for the same repo. |

## Installed tools

- **Node.js 24** (with npm; `pnpm` and `yarn` are available via corepack — it reads the repo's `packageManager` field and fetches the pinned version)
- **git**, **curl**
- **python3**, **make**, **g++** (for native npm addons)
- **Agent CLIs** — both `claude` (Claude Code) and `codex` (Codex) are installed; ShipIt invokes whichever the user selected for the session

  Codex authentication has two modes — they are not interchangeable:

  - **ChatGPT subscription** (preferred). The user signs in with `Sign in with ChatGPT` in the UI; the credentials are written to `~/.codex/auth.json` (a symlink onto the credentials volume). Bills against their ChatGPT plan / Codex credits.
  - **`OPENAI_API_KEY` env var**. Bills against their OpenAI Platform account. ShipIt only injects this into the agent process when no ChatGPT login is present — when both are configured, the env var is stripped so the user isn't double-billed.
- **Playwright** with headless Chrome (available via browser tools)

## Automatic behaviors

**Git commits**: ShipIt auto-commits your changes after each turn. Do not run
`git commit`, `git add`, or `git push` — this is handled automatically. The
commit message is derived from your turn summary.

**Hot reload**: When you edit files, compose services with mounted volumes
pick up changes automatically. No need to restart dev servers after code edits.

**Dependency detection**: Changes to lockfiles (`package-lock.json`,
`yarn.lock`, `pnpm-lock.yaml`) trigger an automatic install + service restart
(debounced with a 30s cooldown).

**Compose services**: Project services (dev servers, databases, caches) run as
Docker Compose containers managed by ShipIt. Define them in
`docker-compose.yml`. See [compose.md](compose.md) for details.

## Resource limits

Agent containers have default limits (1536 MB memory, 0.5 CPU, 256 PIDs) that
can be increased via the `agent` section in `shipit.yaml`. See
[shipit-yaml.md](shipit-yaml.md) for details. Service containers have their
own resource limits set in `docker-compose.yml`.
