
# Self-Update

ShipIt checks for upstream updates and applies them from the UI — no fork, no GitHub Actions deploy, no SSH keys for CI.

## How it works

### Check for updates

1. Server endpoint `POST /api/updates/check` runs `git fetch origin main` in `/opt/shipit` and compares `HEAD` vs `origin/main`
2. Returns: `{ available: boolean, currentCommit: string, latestCommit: string, behindBy: number, commitMessages: string[] }`
3. The orchestrator container has `/opt/shipit` bind-mounted (read-only for the git check)

### Apply update

1. Server endpoint `POST /api/updates/apply` writes the `.update-requested`
   trigger file
2. A systemd path unit picks it up and runs **on the host**
   (`deployment/vps/update.sh` — Option A below, as built), which:
   - `git fetch origin --tags --prune` (once, retried, time-bounded), then
     resolves the channel's target COMMIT and `git reset --hard`s to it
   - runs `deployment/vps/deploy.sh`: build the images, `docker compose up -d`,
     prune the build artifacts from an EXIT trap
3. The orchestrator container cannot rebuild itself from inside, which is why
   the script runs on the host rather than in a container

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

## Failure handling — a failed update must not leave a confusing/leaky box (issues #1047, #1050)

The original `update.sh` did `git reset --hard "$REF"` to advance the checkout
**before** `deploy.sh` rebuilt the image. If the build then failed, the checkout
pointed at the *new* commit while the orchestrator kept running the *old* image —
two contradictory states with no failure signal, and a plain "Just Restart"
re-resolved the version against the advanced checkout and made the failure look
like a success. Separately, `deploy.sh` pruned BuildKit cache / dangling images
only *after* a successful build, so a failing build (which aborts under
`set -euo pipefail`) leaked all its build artifacts, with no janitor backstop.

The invariant now enforced: **the on-disk checkout never points ahead of the
image the orchestrator is actually running**, and **build artifacts are reclaimed
regardless of build outcome**.

- **`update.sh`** captures `PRIOR_SHA` (the running image's commit) before
  touching the checkout, advances the checkout, then builds. An `EXIT` trap rolls
  the checkout back to `PRIOR_SHA` on any failure and writes a `.update-failed`
  JSON breadcrumb; on success it drops the breadcrumb. The window where the
  checkout is "ahead" lasts only as long as the build.
- **No step of a systemd-run update is unbounded.** (A manual
  `bash update.sh` gets the fetch bounds but no whole-run bound — the unit is
  what supplies that.) Each `git fetch` attempt runs under
  `timeout -k` (`SHIPIT_FETCH_TIMEOUT_SECONDS`, default 120, then SIGKILL after
  `SHIPIT_FETCH_KILL_GRACE_SECONDS`, default 15) so a stalled connection is
  retried like a refusal instead of hanging forever — the `-k` is what makes it
  a bound rather than a request, since plain `timeout` sends TERM and then waits
  on whatever ignored it. The run as a whole is bounded by
  `TimeoutStartSec=90min` on `shipit-updater.service`: `Type=oneshot` has NO
  start timeout by default, and a hung activation blocks every later one behind
  it, so one hang stopped the host updating at all. 90min is a backstop for a
  hang, not a build budget — it sits above the worst honest run because killing
  a legitimate slow build costs an update cycle.
- **A kill leaves a coherent host in the cases it can.** The timeout kill
  reaches the whole control group, and `update.sh` traps `TERM`/`INT` so it
  rolls back and records exit 143 (an untrapped kill ran the `EXIT` trap with
  `$?` of 0 and wrote a breadcrumb claiming "exit 0"). One exception, and it is
  the important one: `deploy.sh` writes a `.deploy-restarted` marker the moment
  `docker compose up -d` returns, because it keeps working after that (its EXIT
  trap prunes the build cache, which can run for minutes). A kill past that
  point must NOT roll back — the new container is already running, so rolling
  back would leave the checkout BEHIND it, the mirror of the bug the rollback
  exists to prevent. **The marker's presence, not the exit status, is what
  decides**, which is safe only because everything that can fail runs before the
  restart and the prune swallows its own failures. Two residuals, both
  deliberate: a kill in the millisecond between `compose up` returning and the
  marker appearing still rolls back (closing it would mean interrogating a
  possibly-wedged Docker from inside the cleanup path); and if the build is
  wedged deeply enough that SIGTERM does not reach it, systemd escalates to
  SIGKILL after `TimeoutStopSec` and no rollback runs at all. In that last case
  `resolveVersion()`'s `mismatch` flag reports the incoherence — it does not
  repair it.
- **`deploy.sh` re-installs drifted systemd units** (`deployment/lib/sync-systemd-units.sh`),
  because `setup.sh` copied them at provisioning only: every unit change since
  sat in the repo and never reached a host that was already running. Same
  reasoning as the hostname derivation — existing installs update through
  `update.sh` → `deploy.sh` and are asked nothing. It runs AFTER the restart, so
  a build that fails and rolls back cannot leave units from a commit that never
  shipped; it installs via a rename so a unit is never half-written; it reloads
  systemd unconditionally, since a reload that failed once would otherwise never
  be retried; and it is a silent no-op where the units cannot be written. The
  reload does not re-bound the RUNNING job — systemd keeps a running job on the
  config it started with — so a new unit setting applies from the next
  activation, which for the updater means the update after this one.
- **`deploy.sh`** moves the prune commands into `prune_build_artifacts()` fired
  from an `EXIT` trap, so a failed build still reclaims its cache. It also
  pre-flights a free-disk check (`SHIPIT_MIN_FREE_GB`, default 5) and fails fast
  with a clear "out of space" message instead of dying inside an apt step (a full
  disk otherwise surfaces as a misleading GPG "invalid signature" error).
- **`resolveVersion()`** now derives the displayed "Current version" from the
  **baked `SHIPIT_BUILD_ID`** (the running image's identity) rather than re-reading
  checkout HEAD, and sets `VersionInfo.mismatch` when the two disagree — an
  in-process backstop so the badge stays honest even if the checkout is ahead.
- **`checkForUpdates()`** reads `.update-failed` and returns it as
  `UpdateStatus.lastUpdateError`; Settings → Advanced renders a "Last update
  failed — still running <sha>" banner and a mismatch note on the version label.

## Key files

| File | Purpose |
|------|---------|
| `src/server/orchestrator/services/updates.ts` | Check + request update logic; reads `.update-failed` → `lastUpdateError` |
| `src/server/orchestrator/build-id.ts` | `resolveVersion()`/`composeVersion()` — version anchored on baked build id, `mismatch` flag |
| `src/server/orchestrator/release-channel.ts` | `HOST_REPO_DIR`, `UPDATE_FAILED_FILE` path constants |
| `src/server/orchestrator/api-routes-updates.ts` | HTTP endpoints |
| `src/server/orchestrator/api-routes.ts` | Route registration |
| `src/client/components/Settings.tsx` | UI in Advanced tab — version label, mismatch note, failure banner |
| `deployment/vps/update.sh` | Host-side update script — rollback-on-failure trap + failure breadcrumb, bounded+retried fetch |
| `deployment/vps/deploy.sh` | Build + restart — prune-on-EXIT trap, pre-flight disk check, unit sync, restart marker |
| `deployment/lib/sync-systemd-units.sh` | Re-install units that drifted from the checkout (tested: `sync-systemd-units.test.ts`) |
| `deployment/vps/shipit-updater.service` | Systemd oneshot service — `TimeoutStartSec=90min` backstop |
| `deployment/vps/shipit-updater.path` | Systemd path watcher |
| `deployment/vps/setup.sh` | Install systemd units |
| `deployment/vps/docker-compose.yml` | Bind-mount /opt/shipit |
| `deployment/README.md` | Simplified setup guide |

## Related

- [docs/200-self-update-ssh-origin](../200-self-update-ssh-origin/plan.md) — the
  in-container update check fetches over the configured origin, which fails if
  that origin is an SSH remote (the orchestrator image has no SSH key/known_hosts).
  Doc 200 adds a global `insteadOf` rewrite so github.com SSH URLs resolve to
  HTTPS + the credential-helper token.
