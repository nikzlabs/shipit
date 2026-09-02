#!/bin/bash
# Build and (re)start ShipIt in production.
# Called by setup.sh, update.sh, or manually:
#   bash /opt/shipit/deployment/vps/deploy.sh
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"

cd "$SHIPIT_DIR"

# Load persisted operator env (e.g. SESSION_EGRESS_ENFORCE=0 written by the
# egress preflight in setup.sh). Exported here so the `docker compose up`
# ${VAR:-} substitutions below see it on every deploy — setup.sh and update.sh
# both call this script, and the host shell env doesn't persist between them.
# Lives outside the git checkout so it survives resets/rebuilds.
SHIPIT_ENV_FILE="${SHIPIT_ENV_FILE:-/etc/shipit/shipit.env}"
if [ -f "$SHIPIT_ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SHIPIT_ENV_FILE"
  set +a
fi

# planning#378 — the hostname the orchestrator answers to.
#
# api-origin-guard.ts refuses a request whose `Host` it cannot prove is ShipIt's
# own, which closes DNS rebinding. Every hostname docs/254 supports proves itself
# from its own shape (an IP literal, `*.ts.net`, an sslip.io name), so a loopback
# or tailnet install configures nothing. A **public domain** cannot: nothing about
# `shipit.example.com` distinguishes it from a name an attacker bought.
#
# So it is derived from the domain the operator already gave setup.sh /
# cloudflare.sh, rather than asked for a second time. Deriving it HERE rather
# than writing it once at setup time is what covers the installs that already
# exist: they update through update.sh -> deploy.sh and would otherwise start
# refusing their own domain, having never been asked anything. An explicit
# SHIPIT_ALLOWED_ORIGINS in the env file always wins.
if [ -z "${SHIPIT_ALLOWED_ORIGINS:-}" ] && [ -f /etc/shipit/setup.conf ]; then
  SHIPIT_SETUP_DOMAIN="$(sed -n 's/^DOMAIN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/shipit/setup.conf | tail -n1)"
  if [ -n "$SHIPIT_SETUP_DOMAIN" ]; then
    export SHIPIT_ALLOWED_ORIGINS="https://$SHIPIT_SETUP_DOMAIN"
  fi
fi

# docs/113 Phase 1 — do NOT kill session-worker or compose service containers
# here. Updates replace ONLY the orchestrator; running sessions (and any agent
# turns mid-flight inside them) survive and the new orchestrator re-adopts them
# at boot: `rediscoverContainers()` rebuilds the container map,
# `reattachInFlightTurns()` (docs/240) re-adopts live turns, and
# `cleanupOrphanContainers()` / `cleanupOrphanComposeResources()` reap anything
# that no longer maps to an active session. The `docker rm -f` sweep that used
# to live here was the single thing forcing operators to wait for all sessions
# to finish before updating.
#
# What happens to the OLD worker containers (docs/242): the boot sweep reclaims
# every stale one that is genuinely idle — no live turn, no self-woken turn, no
# outstanding background task, no viewer, no always-on reservation — by
# destroying its agent container and NOT recreating it, so the update actually
# gives that memory back. Its Compose stack keeps serving. A worker that is busy
# survives on its old image until it is next reclaimed, so the wire contract
# stays additive-only, guarded by
# src/server/shared/types/worker-wire-contract.test.ts.

# NO `docker network prune -f` here. It used to sit at this line to reclaim
# per-session address space, arguing it was safe because prune only removes
# networks with nothing attached and a live session's containers are attached
# to its network. That holds in steady state. It does NOT hold during an update:
#
#   - a session created inside the build window has had its network created
#     (`createContainer` makes it before the container joins) but not yet
#     joined, so the prune deletes it out from under the session. Every child
#     container it later spawns then logs
#     `joinSessionNetwork failed: network shipit-session-<id> not found`.
#     On the 2026-08-10 update this removed 18 session networks in one shot;
#   - an idle-EVICTED session's network is deliberately kept for warm resume
#     (`sweepOrphanSessionNetworks` preserves any session whose `diskTier` is
#     not `evicted`) and has nothing attached, so a blind prune reclaims exactly
#     what the janitor is holding on to.
#
# Nothing is leaked by dropping it: `sweepOrphanSessionNetworks`
# (`startup-janitor.ts`) does this job properly on the boot that immediately
# follows this deploy — same `dangling=true` set, but cross-referenced against
# the live session list first.

# Reclaim dangling images + stale BuildKit cache. Defined as a function and
# fired from an EXIT trap (below) so it runs REGARDLESS of build outcome.
#
# Why a trap and not a plain tail call (issue #1050): this script runs under
# `set -euo pipefail`, so a failing `docker compose build` aborts the script
# immediately. If the prune lived only at the end, a failed build would skip it
# and the dangling images + BuildKit cache from the failed attempt would never
# be reclaimed. Repeated failed updates then snowball cache until the disk fills
# — which itself causes more build failures. The disk-janitor deliberately does
# NOT manage build cache (it documents that build cache is "pruned by deploy.sh
# right after each successful build"), so this trap is the only backstop.
prune_build_artifacts() {
  # IMPORTANT: do NOT use `-a` on `image prune`. `docker image prune -a`
  # deletes any image without a running container, and the session-worker
  # image only runs on-demand (no container between sessions) — so `-a`
  # deletes the image the orchestrator needs to spawn new sessions. `-f`
  # alone prunes only dangling (untagged) images, which is what we want:
  # when a fresh build takes the `:prod` tag, the prior image becomes
  # dangling automatically and is reclaimed.
  docker image prune -f || true
  #
  # DO use `-a` on `builder prune`. Without it BuildKit only reclaims
  # cache entries unreferenced by any image — most of the accumulated
  # cache (entries reachable from prior builds' intermediate stages) is
  # skipped and the cache snowballs across deploys.
  #
  # Cap the cache at 15 GB via a size-based filter. Time-based filters
  # (`--filter until=72h` / `--filter unused-for=72h`) do NOT work in our
  # build → prune flow: both translate to BuildKit's `KeepDuration`,
  # which is checked against `last_used`, and the build we just ran
  # refreshed `last_used` on every layer it touched. Tested on prod:
  # 0 B reclaimed against 83 GB of reclaimable cache. See the BuildKit
  # source at moby/buildkit's cache/manager.go for the comparison logic.
  #
  # On the 15 GB number: a measured prod cache totalled 9.115 GB — 2.66 GB
  # of records from the build that had just run, 6.45 GB of older ones.
  # That left only ~0.9 GB under the previous 10 GB cap. The margin matters
  # more than it looks, because eviction is oldest-by-`last_used` over a set
  # the just-finished build refreshed all at once, so once the cap bites,
  # what it takes is near-arbitrary — as easily the 1.444 GB
  # Playwright/Chrome layer or the 1.637 GB `/root/.npm` cache mount (`-a`
  # prunes cache mounts too) as something genuinely stale. 15 GB restores
  # real headroom while still bounding the disk. Note ~0.94 GB of that
  # measured total was a DUPLICATED build prefix that a Dockerfile.prod fix
  # has since removed, so the steady-state figure should be lower; re-measure
  # with `docker buildx du` and revisit if totals climb back toward the cap.
  #
  # `--max-used-space` is the semantically-correct flag (caps total
  # cache size, prunes oldest-by-last-used to stay under) but requires
  # BuildKit v0.17+. `--keep-storage` is the deprecated alias for
  # `--reserved-space` that works on every version: when used alone it
  # also acts as a cap (keepBytes = max(MaxUsedSpace, ReservedSpace) in
  # the GC, with MaxUsedSpace=0 when unset). The final unfiltered
  # `-af` is the nuke fallback if neither flag is recognized.
  docker builder prune -af --max-used-space 15GB \
    || docker builder prune -af --keep-storage 15GB \
    || docker builder prune -af \
    || true
}
# Fire the prune on EVERY exit — success OR the `set -e` abort of a failed
# build. This is what makes a failed rebuild reclaim its own cache (#1050).
trap prune_build_artifacts EXIT

# Pre-flight: fail fast with a clear message when the disk is too low to build,
# rather than letting the rebuild die deep inside an apt step. On a full disk
# the session-worker build's `apt-get`/`playwright install-deps` surfaces a
# misleading "GPG error: ... At least one invalid signature was encountered"
# (apt can't write its lists), which sent issue #1047's reporter chasing a
# signing problem that was really "out of space". A 5 GB floor (override with
# SHIPIT_MIN_FREE_GB) catches that before the build starts. The EXIT trap above
# still prunes on this early exit, which may itself free enough to retry.
MIN_FREE_GB="${SHIPIT_MIN_FREE_GB:-5}"
# Check the filesystem holding Docker's data root (images + BuildKit cache live
# there); fall back to / when we can't resolve it.
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT="/"
# `df -BG --output=avail` is GNU coreutils (present on the Ubuntu VPS); strip to
# digits. If df is unavailable or returns nothing, skip the check rather than
# blocking a legitimate deploy on a parse failure.
AVAIL_GB="$(df -BG --output=avail "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -lt "$MIN_FREE_GB" ]; then
  echo "ERROR: only ${AVAIL_GB} GB free on the Docker filesystem (${DOCKER_ROOT}); need at least ${MIN_FREE_GB} GB to rebuild." >&2
  echo "Free up disk space (e.g. 'docker builder prune -af', 'docker image prune -f') and retry the update." >&2
  exit 1
fi

# Build the images (session-worker + egress-sidecar are build-only profiles, must be
# named explicitly). egress-sidecar (shipit-egress-sidecar:prod) is the planning#92 egress
# firewall image — built every deploy so a docker/egress-sidecar/ change ships in lockstep
# with main instead of lagging a stale manual build. It's independent of session-worker
# (no FROM dependency), so it builds here alongside it. Egress containment is ON by default
# (the compose orchestrator service sets SESSION_EGRESS_SIDECAR_IMAGE); the setup.sh egress
# preflight persists SESSION_EGRESS_ENFORCE=0 for hosts that can't run the NET_ADMIN sidecar.
# Reuses Docker's build cache by default; set FORCE_REBUILD=1 (or "true",
# "yes", "on") to bypass it.
#
# The agent CLIs (Claude/Codex/Playwright-MCP) are no longer refreshed by a
# per-deploy cache-bust. They install from a committed lockfile
# (docker/agent-cli/package-lock.json) with `npm ci`, so the shipped versions
# are deterministic and only change when that lockfile changes (bumped by the
# Renovate GitHub App with a cooldown, gated on the CLI contract test — see
# docs/141-cli-version-strategy). Docker's content hash of the COPYed lockfile
# invalidates the install layer automatically when versions change; nothing
# time-based is needed.
SHIPIT_BUILD_ID="$(git rev-parse HEAD 2>/dev/null || true)"
BUILD_ARGS=("--pull")
if [ -n "$SHIPIT_BUILD_ID" ]; then
  BUILD_ARGS+=("--build-arg" "SHIPIT_BUILD_ID=$SHIPIT_BUILD_ID")
fi
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    BUILD_ARGS+=("--no-cache")
    ;;
esac
docker compose -f "$COMPOSE_FILE" build "${BUILD_ARGS[@]}" session-worker shipit egress-sidecar

# docs/128 — build the docker-capable session image (Docker CLI + journalctl) on
# top of the :prod image we just built. It does `FROM shipit-session-worker:prod`,
# which now exists LOCALLY — so this is a SEPARATE build that must NOT pass
# --pull (that would try to fetch the local-only base from a registry and fail).
# It also must run AFTER session-worker so the base tag exists. FORCE_REBUILD
# still applies. The orchestrator selects this image (shipit-session-worker:docker)
# for `capabilities.docker` and ops sessions via SESSION_WORKER_DOCKER_IMAGE.
DOCKER_IMG_BUILD_ARGS=()
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    DOCKER_IMG_BUILD_ARGS+=("--no-cache")
    ;;
esac
docker compose -f "$COMPOSE_FILE" build "${DOCKER_IMG_BUILD_ARGS[@]}" session-worker-docker

# Start orchestrator (session-worker containers are spawned on demand)
docker compose -f "$COMPOSE_FILE" up -d --no-build shipit

# Dangling images + stale BuildKit cache are reclaimed by the EXIT trap
# (prune_build_artifacts) defined above, which runs on success and failure
# alike — see the comment there for why this moved out of the success tail.
