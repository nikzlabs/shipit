#!/usr/bin/env bash
# Shared helpers for the local ShipIt install/update/stop scripts
# (deployment/local/setup.sh, update.sh, stop.sh). This file is SOURCED, not
# executed. Callers set/export SHIPIT_HOME first; we fill in sane defaults.

# Where the local checkout lives on the host. The container always sees it at
# /opt/shipit via the relative bind-mount in docker/local/prod/compose.yml, so
# the host path is free to be a per-user dir.
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
COMPOSE_FILE="$SHIPIT_HOME/docker/local/prod/compose.yml"
CHANNEL_FILE="$SHIPIT_HOME/.release-channel"
# Compose project name — matches `name:` in compose.yml and DOCKER_STACK, used
# as the shipit-stack label value on this install's containers.
COMPOSE_STACK="shipit-prod"

# Echo the git ref for the configured release channel. Mirrors
# deployment/vps/update.sh: stable -> origin/stable (falling back to origin/main
# until the first stable cut), edge -> origin/main. Default channel is stable.
shipit_channel_ref() {
  local channel
  channel="$(cat "$CHANNEL_FILE" 2>/dev/null || echo stable)"
  case "$channel" in
    stable)
      if git -C "$SHIPIT_HOME" ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
        echo "origin/stable"
      else
        echo "origin/main"
      fi
      ;;
    edge)
      echo "origin/main"
      ;;
    *)
      echo "Error: invalid release channel '$channel' in $CHANNEL_FILE (expected 'stable' or 'edge')." >&2
      return 1
      ;;
  esac
}

# Fetch the channel ref and hard-reset the checkout to it. Refuses to clobber
# uncommitted changes. Safe (effectively a no-op) right after a fresh clone.
#
# --untracked-files=no is deliberate (docs/254-local-bind-and-tailnet-access req 9). `git reset --hard` only
# discards changes to TRACKED files; untracked files are left untouched. So
# refusing on them never protected anything, while it did break updates outright:
# operator state lives in the checkout (.shipit.env, and before it was ignored,
# .release-channel), so writing any of it made this refuse forever. The egress
# opt-out writes .shipit.env, so that combination shipped as a dead-end.
#
# .gitignore now covers those files, but an ALREADY-affected install cannot reach
# that fix through this function — update.sh sources the checkout's own (old)
# copy of this file, which rejects the tree before fetching the commit that would
# fix it. Narrowing the check here is what actually unblocks them, on the next
# update after this change lands. Anyone stuck on a pre-fix copy needs one manual
# `rm ~/.shipit/.shipit.env` (or a stash) — see deployment/README.md.
shipit_sync_checkout() {
  if [ -n "$(git -C "$SHIPIT_HOME" status --porcelain --untracked-files=no)" ]; then
    echo "Error: $SHIPIT_HOME has uncommitted changes to tracked files; commit, stash, or discard them first." >&2
    return 1
  fi
  local ref channel
  ref="$(shipit_channel_ref)" || return 1
  channel="$(cat "$CHANNEL_FILE" 2>/dev/null || echo stable)"
  echo "==> Syncing $SHIPIT_HOME to channel '$channel' (ref $ref)..."
  git -C "$SHIPIT_HOME" fetch origin --tags --prune
  git -C "$SHIPIT_HOME" fetch origin "${ref#origin/}"
  git -C "$SHIPIT_HOME" reset --hard "$ref"
}

# Persisted operator env for the orchestrator service. The egress preflight in
# deployment/local/setup.sh writes the opt-out (SESSION_EGRESS_ENFORCE=0) here,
# and deployment/local/tailscale.sh writes the tailnet opt-in
# (SHIPIT_TAILNET_BIND=1), so both survive re-runs; compose's ${VAR:-}
# substitution picks them up. Lives in the checkout but is .gitignore'd — it has
# to be, because shipit_sync_checkout refuses to run when `git status
# --porcelain` is non-empty and that lists untracked files (docs/254-local-bind-and-tailnet-access req 9).
SHIPIT_ENV_FILE="${SHIPIT_ENV_FILE:-$SHIPIT_HOME/.shipit.env}"

# Generated compose overlay carrying the opt-in tailnet port binding (docs/254).
# Regenerated on every start and .gitignore'd, for the same reason as above.
TAILNET_COMPOSE_FILE="${TAILNET_COMPOSE_FILE:-$SHIPIT_HOME/.shipit-tailnet.compose.yml}"

# Source the persisted env file (if any) and export its vars so the docker
# compose invocations below see them for ${VAR:-} substitution.
shipit_load_env_file() {
  if [ -f "$SHIPIT_ENV_FILE" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$SHIPIT_ENV_FILE"
    set +a
  fi
}

# Resolve the Tailscale CLI, echoing an invocable path (empty output + non-zero
# when there is none). Use this instead of a bare `command -v tailscale`.
#
# Why: the standalone macOS app — the one tailscale.com/download/mac hands you —
# keeps its CLI INSIDE the bundle at
# /Applications/Tailscale.app/Contents/MacOS/Tailscale and never puts `tailscale`
# on PATH. A bare `command -v` therefore reports "not installed" on a machine that
# is fully installed and connected, which is the single most likely configuration
# for the laptop this feature exists to serve.
#
# Symlinking the bundle binary onto PATH is NOT a workaround: it resolves its
# bundle identifier from its own executable path and dies with
# "Fatal error: The current bundleIdentifier is unknown to the registry".
# Only invoking the absolute bundle path (or a wrapper that `exec`s it) works —
# which is exactly why this returns a PATH to invoke rather than just a boolean.
#
# SHIPIT_TAILSCALE_BIN overrides everything, for an install in a nonstandard
# place. SHIPIT_TAILSCALE_PREFIX prefixes the probed absolute paths; it exists so
# the tests can exercise the bundle-path branch without an /Applications, and is
# not intended for users.
shipit_tailscale_bin() {
  if [ -n "${SHIPIT_TAILSCALE_BIN:-}" ]; then
    [ -x "$SHIPIT_TAILSCALE_BIN" ] || return 1
    printf '%s\n' "$SHIPIT_TAILSCALE_BIN"
    return 0
  fi
  # PATH first: a Homebrew/`tailscaled`-package install is the common Linux case
  # and the fastest check.
  if command -v tailscale >/dev/null 2>&1; then
    printf 'tailscale\n'
    return 0
  fi
  local prefix="${SHIPIT_TAILSCALE_PREFIX:-}" candidate
  for candidate in \
    "$prefix/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "$prefix/usr/local/bin/tailscale" \
    "$prefix/opt/homebrew/bin/tailscale"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Re-derive the opt-in tailnet port binding, and write (or remove) the compose
# overlay that carries it. Called before every `up`. See docs/254.
#
# Why this is computed at start rather than written once: Docker fails the WHOLE
# container if any single published binding can't be bound, so a tailnet address
# baked into compose.yml would turn "tailscaled hasn't come up yet after a
# reboot" into "ShipIt does not start" (req 5). Re-deriving here also means a
# changed tailnet address is picked up with no hand-editing (req 6).
#
# Loopback lives in compose.yml itself and is never touched by this, so localhost
# access never depends on Tailscale being reachable. Users who have not opted in
# never reach the tailscale lookup at all (req 3).
#
# Every filesystem mutation below is `|| true`'d for the same reason as the
# tailscale lookup: this whole function is BEST-EFFORT, and callers run under
# `set -e`. A read-only checkout, a full disk, or a directory sitting at the
# overlay path must degrade to "no tailnet binding" — never to "ShipIt refuses to
# start". If the overlay can't be removed, `shipit_compose_files` would still
# emit a stale one, so the failure is surfaced rather than swallowed silently.
shipit_refresh_tailnet_bind() {
  if [ "${SHIPIT_TAILNET_BIND:-}" != "1" ]; then
    shipit_drop_tailnet_overlay
    return 0
  fi

  # `|| true` is load-bearing, not defensive noise: every caller runs under
  # `set -euo pipefail`, and `tailscale ip -4` exits non-zero when the daemon is
  # installed but not connected — the exact laptop-after-reboot case. Without it
  # the failing substitution aborts setup.sh/update.sh instead of falling through
  # to the loopback-only path below, which is precisely the opposite of req 5.
  local ts_ip="" ts_bin=""
  ts_bin="$(shipit_tailscale_bin || true)"
  if [ -n "$ts_bin" ]; then
    ts_ip="$("$ts_bin" ip -4 2>/dev/null | head -n1 || true)"
  fi

  if [ -z "$ts_ip" ]; then
    # Opted in, but Tailscale is absent or not connected. Start anyway on
    # loopback and say so — this is req 5, not an error.
    shipit_drop_tailnet_overlay
    echo "==> Tailscale not reachable; starting on localhost only." >&2
    echo "    Re-run this start (update.sh) once Tailscale is up to restore tailnet access." >&2
    return 0
  fi

  # Written atomically so a concurrent `docker compose` never reads a partial
  # file. Compose concatenates `ports` across -f files (uniqueness key includes
  # the host IP), so this ADDS a binding rather than replacing the loopback one
  # in compose.yml.
  local tmp=""
  tmp="$(mktemp "${TAILNET_COMPOSE_FILE}.XXXXXX" 2>/dev/null || true)"
  if [ -z "$tmp" ]; then
    shipit_drop_tailnet_overlay
    echo "==> Could not write the tailnet overlay; starting on localhost only." >&2
    return 0
  fi
  if ! cat > "$tmp" <<EOF
# GENERATED by deployment/local/lib.sh — do not edit, rewritten on every start.
# Opt-in tailnet binding for the local install (docs/254). Remove
# SHIPIT_TAILNET_BIND from $SHIPIT_ENV_FILE to opt out.
services:
  shipit:
    ports:
      - "${ts_ip}:4123:4123"
EOF
  then
    rm -f "$tmp" 2>/dev/null || true
    shipit_drop_tailnet_overlay
    echo "==> Could not write the tailnet overlay; starting on localhost only." >&2
    return 0
  fi
  if ! mv -f "$tmp" "$TAILNET_COMPOSE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    shipit_drop_tailnet_overlay
    echo "==> Could not write the tailnet overlay; starting on localhost only." >&2
    return 0
  fi
  # Export so callers (tailscale.sh) print the address actually bound, rather
  # than one from an earlier, separate lookup that may since have changed.
  SHIPIT_TAILNET_IP="$ts_ip"
}

# Remove the generated overlay. A failure here is NOT ignorable the way the
# others are: shipit_compose_files keys off the file's existence, so a leftover
# overlay would keep binding an address the user has opted out of — or one that
# no longer exists, which fails the container outright. Surface it and let the
# caller decide; never abort the start from inside a best-effort path.
shipit_drop_tailnet_overlay() {
  [ -e "$TAILNET_COMPOSE_FILE" ] || return 0
  if ! rm -f "$TAILNET_COMPOSE_FILE" 2>/dev/null; then
    echo "==> Warning: could not remove $TAILNET_COMPOSE_FILE." >&2
    echo "    ShipIt will keep using the tailnet binding it contains until it is deleted." >&2
  fi
  return 0
}

# Echo the `-f` arguments for every docker compose invocation: the base file,
# plus the generated tailnet overlay when it exists.
shipit_compose_files() {
  printf '%s\n' -f "$COMPOSE_FILE"
  if [ -f "$TAILNET_COMPOSE_FILE" ]; then
    printf '%s\n' -f "$TAILNET_COMPOSE_FILE"
  fi
}

# Build the prod images and start the orchestrator detached. session-worker and
# egress-sidecar are built (needed by SessionContainerManager / the default-on
# egress containment at runtime) but not started; they live under the build-only
# compose profile.
shipit_build_and_up() {
  shipit_load_env_file
  shipit_refresh_tailnet_bind
  local compose_files=()
  while IFS= read -r arg; do compose_files+=("$arg"); done < <(shipit_compose_files)
  echo "==> Building ShipIt images..."
  docker compose "${compose_files[@]}" build --pull session-worker shipit egress-sidecar
  echo "==> Starting ShipIt (detached)..."
  docker compose "${compose_files[@]}" up -d --no-build shipit
}

# Remove orphan session containers (and their compose children) plus the
# per-session networks left behind by previous runs. Matches the labels the
# orchestrator stamps (compose-generator.ts, session-container.ts).
shipit_cleanup_sessions() {
  # shellcheck disable=SC2046  # intentional word-splitting over the id list
  docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
  # shellcheck disable=SC2046
  docker rm -f $(docker ps -aq --filter "label=shipit-stack=$COMPOSE_STACK") 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true
}
