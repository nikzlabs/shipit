---
status: planned
---

# Self-Update

ShipIt checks for upstream updates and applies them from the UI — no fork, no GitHub Actions deploy, no SSH keys for CI.

## How it works

### Check for updates

1. Server endpoint `POST /api/updates/check` runs `git fetch origin main` in `/opt/shipit` and compares `HEAD` vs `origin/main`
2. Returns: `{ available: boolean, currentCommit: string, latestCommit: string, behindBy: number, commitMessages: string[] }`
3. The orchestrator container has `/opt/shipit` bind-mounted (read-only for the git check)

### Apply update

1. Server endpoint `POST /api/updates/apply` triggers the update
2. The update runs **on the host** via a helper script (`deployment/hetzner/update.sh`) that:
   - `git fetch origin main && git reset --hard origin/main`
   - `docker compose build session-worker shipit`
   - `docker compose up -d --no-build shipit`
   - `docker image prune -f`
3. The orchestrator container cannot rebuild itself from inside — the script runs on the host via a lightweight sidecar or `docker exec` on the host

### The restart problem

The orchestrator container is the thing being replaced. Two approaches:

**Option A — Host-side systemd timer/script**: A small systemd service watches a "please update" flag file on a shared volume. The API endpoint writes the flag, the host service picks it up and runs the update. Simple, no extra containers.

**Option B — Sidecar updater container**: A minimal container with Docker socket access that watches for an update signal (file, HTTP, etc.) and runs the compose commands. More Dockery, but another moving part.

**Recommendation: Option A** — a single `shipit-updater.sh` script installed as a systemd path unit during `setup.sh`. It watches for `/opt/shipit/.update-requested` and runs the rebuild + restart.

## Implementation plan

### Server side

1. **`services/updates.ts`** — `checkForUpdates()` and `requestUpdate()` service functions
   - `checkForUpdates()`: shells out to `git fetch` + `git log` on `/opt/shipit`
   - `requestUpdate()`: writes a trigger file to the shared volume, returns immediately
2. **`api-routes-updates.ts`** — `POST /api/updates/check`, `POST /api/updates/apply`
3. Register routes in `api-routes.ts`

### Host side

4. **`deployment/hetzner/update.sh`** — the actual update script (fetch, build, restart, prune)
5. **Systemd path unit** — watches for the trigger file, runs `update.sh`
6. **`setup.sh`** — installs the systemd units during provisioning

### Client side

7. **Settings "Advanced" tab** — add "Software Updates" section with:
   - "Check for Updates" button
   - Shows current version (commit short hash) and update status
   - "Update Now" button when an update is available
   - Status text during update ("Updating... ShipIt will restart momentarily")

### Deployment changes

8. **Bind-mount `/opt/shipit`** read-only into the orchestrator container (for `git fetch`)
9. **Shared volume or bind-mount** for the trigger file
10. **Remove GitHub Actions deploy workflow** — or make it optional/secondary
11. **Simplify README** — remove fork requirement, remove deploy key for CI, remove GitHub secrets step

## Key files

| File | Purpose |
|------|---------|
| `src/server/orchestrator/services/updates.ts` | Check + request update logic |
| `src/server/orchestrator/api-routes-updates.ts` | HTTP endpoints |
| `src/server/orchestrator/api-routes.ts` | Route registration |
| `src/client/components/Settings.tsx` | UI in Advanced tab |
| `deployment/hetzner/update.sh` | Host-side update script |
| `deployment/hetzner/shipit-updater.service` | Systemd oneshot service |
| `deployment/hetzner/shipit-updater.path` | Systemd path watcher |
| `deployment/hetzner/setup.sh` | Install systemd units |
| `deployment/hetzner/docker-compose.yml` | Bind-mount /opt/shipit |
| `deployment/README.md` | Simplified setup guide |
