---
description: A reduced-root VPS install that runs ShipIt against Rootless Docker under ~/.shipit, reusing the local install model instead of the systemd-managed root path.
---

# Rootless VPS install

## Context

ShipIt has two install paths today:

- **VPS** (`deployment/vps/`) — runs as **root**: clones to `/opt/shipit`, `apt`-installs
  Docker, tunes host sysctls, installs systemd updater/restarter units, mounts the host Docker
  socket into the orchestrator, and self-updates from the UI (managed mode). See
  [`docs/180-align-local-install/plan.md`](../180-align-local-install/plan.md) for the VPS↔local
  split.
- **Local** (`deployment/local/`) — runs **unprivileged** under `~/.shipit`, detached, updated by
  re-running `update.sh`. No systemd, no Cloudflare/Tailscale, no host tuning. Added in docs/180.

This doc proposes a third path: a **reduced-root VPS install** that runs ShipIt against
[Rootless Docker](https://docs.docker.com/engine/security/rootless/) so the orchestrator and all
session containers run under an unprivileged user, with only a **minimal one-time root bootstrap**.

### Why this is "reduced-root", not "zero-root"

Be honest up front: a *truly* zero-root install is **not achievable on a bare VPS**. A handful of
prerequisites are host-global and root-only no matter what. The realistic shape is **minimal root
bootstrap → rootless steady-state**: a few one-time `sudo` lines to prep the host, after which
*everything ongoing* (clone, build, run, update, Docker address pools) is unprivileged and lives
under `~`.

### The core architecture fact

ShipIt's model is "the orchestrator container drives the **host** Docker daemon to spawn session
containers." The orchestrator reaches Docker only through the mounted socket:

- `deployment/vps/docker-compose.yml` mounts `/var/run/docker.sock:/var/run/docker.sock` into the
  orchestrator.
- `src/server/orchestrator/session-container.ts:503` —
  `new Docker({ socketPath: opts.socketPath ?? "/var/run/docker.sock" })`.

So "rootless ShipIt" does **not** mean "ShipIt without Docker root" — it means **ShipIt against
Rootless Docker** (dockerd running as an unprivileged user, socket at `/run/user/$UID/docker.sock`).
There is no other way to get container orchestration without the `docker` group, which is
root-equivalent anyway.

Crucially, the hardcoded `/var/run/docker.sock` is the **in-container** path. The compose mount
remaps the host socket onto it, so we change the mount **source**, not the in-container target — the
orchestrator code barely changes.

## Root-dependency inventory

Walking `deployment/vps/setup.sh` top to bottom, every root action and its rootless fate:

| Step | Today (root) | Rootless |
|---|---|---|
| Clone repo | `/opt/shipit` | ✅ `~/.shipit` — rootless *revives* the `~/.shipit` argument that docs/180 made for local |
| Install Docker | `apt-get install docker-ce` | ⚠️ `curl -fsSL https://get.docker.com/rootless \| sh` installs static binaries to `~/bin`, but only if `uidmap` + subuid/subgid are present (see bootstrap) |
| Docker address pools | `/etc/docker/daemon.json` + `systemctl restart docker` | ✅ Rootless daemon reads `~/.config/docker/daemon.json` — user-writable, no root |
| inotify limits | `/etc/sysctl.d/99-shipit-inotify.conf` + `sysctl --system` | ❌ `fs.inotify.max_user_watches` is a host-global sysctl, **root-only**. Cannot move. |
| Updater/restarter units | `/etc/systemd/system/` + `systemctl enable` | ⚠️ Dropped in favor of manual `update.sh` (the local model) — sidesteps user-unit lingering entirely |
| Orchestrator socket mount | `/var/run/docker.sock` | ✅ `${XDG_RUNTIME_DIR}/docker.sock` → one-line compose change |
| Cloudflare / Tailscale | apt + system services | ⚠️ Out of scope for v1; rootless tunnels exist but are their own story |

## The irreducible root bootstrap

These one-time, host-global prerequisites are root-only. The installer's job is to **check and
instruct** (like `deployment/local/setup.sh` does for Docker) — detect what's missing and print the
exact `sudo` lines, never silently auto-`sudo`:

1. **`uidmap` package** (`newuidmap`/`newgidmap`) — needed for user namespaces; usually a one-time
   `apt install uidmap`.
2. **`/etc/subuid` + `/etc/subgid`** ranges for the user — typically pre-populated for the default
   cloud-image user, but a bare VPS may need them set.
3. **`fs.inotify.max_user_watches`** (and `max_user_instances`) — the one that genuinely cannot
   move; it's global kernel state. ShipIt's per-subdirectory `fs.watch` recursion across many
   sessions blows past the Ubuntu default (~65k) fast, so the admin must bump it once. Reuse the
   exact values from `deployment/vps/setup.sh` (524288 watches / 512 instances).

Everything past this bootstrap is unprivileged.

## Approach

Frame the rootless VPS install as **"the local install model, detached, on a remote Linux box,
pointed at Rootless Docker."** This reuses `deployment/local/lib.sh` heavily rather than forking the
heavyweight systemd path in `deployment/vps/`.

The deltas from the local install are exactly three:

1. Rootless dockerd socket path (`$XDG_RUNTIME_DIR/docker.sock`) instead of the Docker Desktop /
   stock socket.
2. Docker address-pool tuning via `~/.config/docker/daemon.json` (local skips it as single-user; a
   VPS runs many concurrent sessions and needs the `172.16.0.0/12` pool expansion, same as the
   rootful VPS).
3. The inotify caveat surfaced as a bootstrap instruction rather than an automatic `sysctl`.

### New directory: `deployment/vps-rootless/`

Mirrors `deployment/local/`, sourcing `deployment/local/lib.sh` for channel resolution, checkout
sync, and build/up. New/overridden pieces:

**`setup.sh`** — the one-line installer:
- `uname`/OS detect (Linux-only; refuse on macOS — rootless-on-Mac is meaningless, Docker Desktop is
  already a VM).
- **Bootstrap preflight (check-and-instruct):** verify `newuidmap` exists, `/etc/subuid` has an
  entry for `$USER`, and `fs.inotify.max_user_watches` is ≥ a threshold. For each missing item,
  print the precise `sudo` line and exit non-zero. Never auto-`sudo`.
- Install Rootless Docker if absent (`get.docker.com/rootless`), enable `DOCKER_HOST` /
  `XDG_RUNTIME_DIR` for the session.
- Clone to `~/.shipit` (honor `SHIPIT_HOME` / `SHIPIT_REPO_URL`), default **stable** channel — reuse
  `shipit_sync_checkout` from `lib.sh`.
- Write `~/.config/docker/daemon.json` with the `172.16.0.0/12` size-24 pool (merge via `jq` if the
  file exists, mirroring the rootful logic).
- Build + `up -d` against the rootless-variant compose.

**`compose.yml`** (or a small override on the existing prod compose) — identical to the VPS prod
compose except the socket mount source:
```yaml
    volumes:
      - workspace:/workspace
      - credentials:/credentials
      - ${XDG_RUNTIME_DIR}/docker.sock:/var/run/docker.sock   # rootless socket → in-container path unchanged
      - ${SHIPIT_HOME}:/opt/shipit                            # host repo at ~/.shipit, container view stays /opt/shipit
```
The in-container `/opt/shipit` view is preserved (same trick docs/180 used for local), so
`HOST_REPO_DIR` and all update-check logic in `src/server/orchestrator/services/updates.ts` keep
working unchanged.

**`update.sh` / `stop.sh`** — thin wrappers over `deployment/local/`'s, with `SHIPIT_HOME` defaulted
to `~/.shipit` and the rootless `DOCKER_HOST` exported. No systemd self-update; updates are manual,
exactly like local.

### Orchestrator code change (minimal)

Option A (preferred): **no code change.** Keep remapping via the compose mount source; the
in-container path stays `/var/run/docker.sock`, so `session-container.ts` is untouched.

Option B (if we want host-path flexibility later): wire a `DOCKER_SOCKET_PATH` env var through
`app-di.ts` into the `SessionContainerManager` `socketPath` option (currently constructed without
it, so it falls through to the default). Not required for v1.

The ops-session / docker-socket-proxy path (docs/128, `OPS_DOCKER_HOST`,
`SESSION_WORKER_DOCKER_IMAGE`) works unchanged against a rootless daemon — it all flows through the
same socket abstraction.

## Known limitations (call out in README, do not paper over)

- **Not zero-root.** The bootstrap (`uidmap`, subuid/subgid, inotify sysctl) needs `sudo` once.
- **inotify ceiling is the admin's.** If the host admin won't raise `max_user_watches`, file
  watching degrades under many sessions — unavoidable in a rootless model.
- **No UI self-update.** Updates are manual via `update.sh` (same tradeoff local accepts).
- **Rootless Docker performance caveats** apply (e.g. `slirp4netns` networking overhead unless
  `RootlessKit` is configured with `bypass4netns`); acceptable for small teams, documented.
- **Cloudflare/Tailscale** exposure is out of scope for v1 — install ShipIt, expose it separately.

## Visual / reference

No load-bearing UI in this feature — it's install tooling. The reference artifact is the
`deployment/vps-rootless/` script set itself.

## Key files

- `deployment/vps-rootless/setup.sh`, `compose.yml`, `update.sh`, `stop.sh` (new)
- `deployment/local/lib.sh` (reused — channel resolution, checkout sync, build/up)
- `deployment/vps/setup.sh`, `deployment/vps/docker-compose.yml` (reference for pool/inotify values)
- `src/server/orchestrator/session-container.ts` (socket path default; only touched for Option B)
- `src/server/orchestrator/services/updates.ts` (`HOST_REPO_DIR` = `/opt/shipit`, unchanged)
- `README.md`, `deployment/README.md` (document the reduced-root path + bootstrap)
