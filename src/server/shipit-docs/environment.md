# Environment

You are running inside a Docker container managed by ShipIt.

## Filesystem layout

| Path | Description |
|------|-------------|
| `/workspace` | Project root. This is the git repo. Your working directory. |
| `/uploads` | User-uploaded files (outside git, never committed). |
| `/tmp` | Scratch space — use for temporary files, unpacking archives. |
| `/credentials` | OAuth tokens (read-only to you, managed by ShipIt). |
| `/dep-cache` | Shared npm/yarn/pnpm cache across sessions for the same repo. |

## Installed tools

- **Node.js 24** (with npm)
- **git**, **curl**
- **python3**, **make**, **g++** (for native npm addons)
- **Claude CLI** (`claude` command)
- **Playwright** with headless Chrome (available via browser tools)

## Automatic behaviors

**Git commits**: ShipIt auto-commits your changes after each turn. Do not run
`git commit`, `git add`, or `git push` — this is handled automatically. The
commit message is derived from your turn summary.

**Hot reload**: When you edit files, the preview picks up changes automatically.
No need to restart dev servers after code edits.

**Dependency detection**: Changes to lockfiles (`package-lock.json`,
`yarn.lock`, `pnpm-lock.yaml`) trigger an automatic install + preview restart
(debounced with a 30s cooldown).

## Resource limits

Containers have default limits (512 MB memory, 0.5 CPU, 256 PIDs) that can be
increased via `shipit.yaml`. See [shipit-yaml.md](shipit-yaml.md) for the
`resources` section.
