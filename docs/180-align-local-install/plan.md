---
description: Bring a one-line installer, a simple update script, and a stop script to the local install so it mirrors the VPS path; install to ~/.shipit.
---

# Align the local install with the VPS install

## Context

ShipIt has two install paths that have drifted apart:

- **VPS** (`deployment/vps/`): a one-line `curl … setup.sh | bash` installer that clones to
  `/opt/shipit`, tunes the host, installs systemd updater/restarter units, and runs **detached**.
  Updates and restarts are driven from the UI (managed mode).
- **Local** (`docker/local/prod.sh`): you clone the repo by hand and run a script that builds and
  runs ShipIt in the **foreground**. Updating means re-running the script. There is no installer,
  no stop script, and the UI's update buttons are disabled (manual mode → 503).

The goal is to give local the two genuinely useful affordances the VPS has — a **one-line install**
and a **simple update path** — while correctly dropping the things local doesn't need (Cloudflare,
Tailscale, Zero Trust, firewall, systemd). UI auto-update is **not** required for local; re-running a
script to update is acceptable. This sidesteps the systemd-vs-launchd problem entirely, so local
stays plain shell and works on **both macOS and Linux**.

Two further decisions:

- **Install location: `~/.shipit`.** Works on macOS and Linux (`~` expands on both, no sudo).
  Importantly, Docker Desktop on macOS shares `/Users` by default but **not** `/opt`, so a
  bind-mount from `~/.shipit` works out of the box whereas `/opt/shipit` would need a manual
  file-sharing entry. `~/.shipit` is the better choice for the cross-platform local path; `/opt`
  stays correct/idiomatic for the root-owned VPS install.
- **A stop script for both VPS and local** that fully shuts ShipIt down and cleans up session
  containers + networks (the teardown counterpart to the existing `restart.sh`).

### Why `~/.shipit` needs no orchestrator code changes

`release-channel.ts` hardcodes `HOST_REPO_DIR = "/opt/shipit"`. The local prod compose
(`docker/local/prod/compose.yml`) bind-mounts `../../..:/opt/shipit` — a path **relative to the
repo**. Cloning to `~/.shipit` still presents the repo at `/opt/shipit` *inside the container*, so
`HOST_REPO_DIR` and all update-check logic keep working unchanged. The host-side clone lives at
`~/.shipit`; the container view stays `/opt/shipit`.

## Approach

A `deployment/local/` directory mirrors `deployment/vps/`, running ShipIt **detached** (so a stop
script makes sense), reusing the existing `docker/local/prod/compose.yml` as the compose definition.
A stop script is added to each side. Docs and the manual-mode message are repointed.

### New files

**`deployment/local/lib.sh`** — small sourced helper (channel resolution + compose path + session
cleanup), used by `update.sh`, `stop.sh`, and the post-clone tail of `setup.sh`. Factors out the
channel→ref logic previously duplicated in `docker/local/prod.sh` and `deployment/vps/update.sh`.
- `COMPOSE_FILE="$SHIPIT_HOME/docker/local/prod/compose.yml"` (compose project `name: shipit-prod`).
- `resolve_ref()` — read `.release-channel` (default `stable`), map to `origin/stable`/`origin/main`,
  with the same stable→main fallback `docker/local/prod.sh` already implements.
- `local_build_and_up()` — channel-aware fetch+reset (skippable), build, `up -d`.
- `cleanup_sessions()` — remove orphan session containers and prune their networks.

**`deployment/local/setup.sh`** — the one-line bootstrap installer (curl|bash before the repo
exists, so the bootstrap part cannot source `lib.sh`). Mirrors `deployment/vps/setup.sh`, trimmed:
- OS detect via `uname -s` (Darwin vs Linux).
- Preflight **check-and-instruct** (do not auto-install): require `git`, `docker`,
  `docker compose`. If Docker is missing, print the Docker Desktop link on macOS / the
  `docker-compose-plugin` hint on Linux and exit non-zero. Stays cross-distro and non-root.
- Resolve repo URL (`SHIPIT_REPO_URL`, default `https://github.com/nicolasalt/shipit.git`) and home
  (`SHIPIT_HOME`, default `$HOME/.shipit`) — same precedence pattern as `vps/setup.sh`.
- Clone into `~/.shipit`, or channel-aware fetch+reset if already present. Fresh installs default to
  the `stable` channel (write `.release-channel`), matching VPS.
- **Linux only**, best-effort: raise inotify limits if running as root / `sudo` is available; skip
  silently otherwise and on macOS (Docker Desktop's VM manages its own). No Docker address-pool
  tuning — unnecessary for a single-user local box.
- Build images and start **detached** via `lib.sh`. Drops the `--no-cache` that
  `docker/local/prod.sh` used (same rationale `deploy.sh` dropped it — the agent CLIs install from a
  committed lockfile, so a cached build is correct and much faster).
- Print `http://localhost:4123` and the `update.sh` / `stop.sh` commands.

**`deployment/local/update.sh`** — the "specific script to update". Cross-platform.
- `cd "$SHIPIT_HOME"`; refuse if `git status --porcelain` is non-empty (mirror `prod.sh`).
- Channel-aware fetch + `reset --hard`, rebuild, `up -d` (via `lib.sh`).

**`deployment/local/stop.sh`** — full shutdown + session cleanup.
- `docker compose -f "$COMPOSE_FILE" down` (removes orchestrator container + network; **keeps** the
  `workspace` / `credentials` named volumes so user data survives).
- `cleanup_sessions()`: `docker rm -f` containers matching `label=shipit-parent-session` and
  `label=shipit-stack=shipit-prod`, then `docker network prune -f`. These are the exact labels
  `docker/local/prod.sh` and `restart.sh` already sweep (`compose-generator.ts:535`,
  `session-container.ts:243`).
- Optional `--purge` flag → append `--volumes` to `down` to also drop `workspace`/`credentials`
  (wipes local data); **off by default**.

**`deployment/vps/stop.sh`** — VPS teardown counterpart to `restart.sh`.
- `docker compose -f deployment/vps/docker-compose.yml down`.
- Sweep `label=shipit-parent-session` + `label=shipit-stack=shipit` containers, `network prune -f`
  (same cleanup block as `restart.sh`, but `down` instead of `up --force-recreate`).
- `--purge` flag for `--volumes`, off by default.

### Modified files

- **`docker/local/prod.sh`** — kept working (referenced by `docs/091` and existing muscle memory),
  reduced to delegate to the new path so there is a single build/run code path.
- **`src/server/orchestrator/services/updates.ts`** (`requireManagedUpdates`) — the 503 message
  repointed from "Re-run docker/local/prod.sh" to `~/.shipit/deployment/local/update.sh`.
- **`README.md`** — "Try it locally" switches to the one-liner; "Software updates" bullet mentions
  `deployment/local/update.sh`.
- **`deployment/README.md`** — a "Local install" section (one-liner, update, stop) plus the
  `~/.shipit` location and `SHIPIT_HOME` / `SHIPIT_REPO_URL` overrides.

### Out of scope (intentionally)

- No UI managed-update for local (no systemd/launchd watcher).
- No Cloudflare / Tailscale / Zero Trust / firewall on local.
- No change to `release-channel.ts` / `HOST_REPO_DIR` (the relative bind-mount keeps `/opt/shipit`
  valid inside the container).

## Key files

| File | Role |
|---|---|
| `deployment/local/setup.sh` | New one-line local installer (clone → build → `up -d`) |
| `deployment/local/update.sh` | New manual update (fetch/reset → rebuild → `up -d`) |
| `deployment/local/stop.sh` | New full shutdown + session cleanup |
| `deployment/local/lib.sh` | New shared helper (channel ref, build+up, cleanup) |
| `deployment/vps/stop.sh` | New VPS teardown counterpart to `restart.sh` |
| `docker/local/prod/compose.yml` | Existing compose definition reused by the new scripts |
| `docker/local/prod.sh` | Reduced to delegate to `deployment/local/update.sh` |
| `src/server/orchestrator/services/updates.ts` | Manual-mode 503 message repointed |
| `README.md`, `deployment/README.md` | Local install / update / stop instructions |

## Verification

- `bash -n` (syntax) and `shellcheck` on all new/changed scripts.
- Trace the cleanup label filters against the codebase to confirm they match what the orchestrator
  stamps (`shipit-parent-session`, `shipit-stack=shipit-prod` / `=shipit`).
- `npm run typecheck` after the message change in `updates.ts`.
- End-to-end (requires a real Docker host):
  1. **macOS + Linux:** run the `setup.sh` one-liner → ShipIt comes up detached at
     `localhost:4123`; confirm the clone landed in `~/.shipit` and the container sees the repo at
     `/opt/shipit` (the update check in Settings works).
  2. `deployment/local/update.sh` on a behind checkout → fetches, rebuilds, restarts; refuses on a
     dirty tree.
  3. `deployment/local/stop.sh` → orchestrator + session containers gone, `workspace`/`credentials`
     volumes still present; `--purge` also drops them.
  4. `deployment/vps/stop.sh` on a VPS → same teardown for the `shipit` stack.
