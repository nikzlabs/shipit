#!/usr/bin/env bash
# One-line local installer for ShipIt (macOS, Linux, and Windows via WSL2).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)
#
# Clones ShipIt to ~/.shipit (override with SHIPIT_HOME), builds the prod images,
# and starts ShipIt detached at http://localhost:4123. Unlike the VPS installer
# it sets up no Cloudflare / Tailscale / systemd — local binds to localhost and
# updates are applied by re-running deployment/local/update.sh. Installing a
# fork? Set SHIPIT_REPO_URL before the command.
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/nikzlabs/shipit.git"
REPO_URL="${SHIPIT_REPO_URL:-$DEFAULT_REPO_URL}"
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
export SHIPIT_HOME

OS="$(uname -s)"

echo "==========================================="
echo "  ShipIt — Local install"
echo "==========================================="
echo ""

# --- Preflight: required tooling (check-and-instruct, never auto-install) ---
missing=0
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is not installed." >&2
  missing=1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed." >&2
  case "$OS" in
    Darwin) echo "  Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/" >&2 ;;
    *)      echo "  Install Docker Engine + the compose plugin: https://docs.docker.com/engine/install/" >&2 ;;
  esac
  missing=1
elif ! docker compose version >/dev/null 2>&1; then
  echo "Error: the Docker Compose v2 plugin ('docker compose') is not available." >&2
  echo "  See https://docs.docker.com/compose/install/" >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi

# --- Clone (or reuse) the checkout ---
if [ -d "$SHIPIT_HOME/.git" ]; then
  echo "==> ShipIt already cloned at $SHIPIT_HOME."
else
  echo "==> Cloning ShipIt to $SHIPIT_HOME ..."
  git clone "$REPO_URL" "$SHIPIT_HOME"
  # Fresh installs track the stable channel (matches the VPS installer).
  echo "stable" > "$SHIPIT_HOME/.release-channel"
fi

# shellcheck source=/dev/null
. "$SHIPIT_HOME/deployment/local/lib.sh"

# Sync to the channel tip (a no-op on a just-cloned tree).
shipit_sync_checkout

# --- Linux only: raise inotify limits if we can (best effort) ---
# inotify limits are per-host, and every session container's file-watcher plus
# every preview dev server registers watches against them. macOS runs Docker in
# a VM that manages its own limits, so this is Linux-only. Skipped silently when
# we lack root/sudo rather than failing the install.
if [ "$OS" = "Linux" ]; then
  conf="/etc/sysctl.d/99-shipit-inotify.conf"
  if [ ! -f "$conf" ]; then
    SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    fi
    if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
      echo "==> Raising inotify watcher limits (sessions + dev servers need these)..."
      $SUDO sh -c "printf 'fs.inotify.max_user_watches=524288\nfs.inotify.max_user_instances=512\n' > '$conf'" || true
      $SUDO sysctl --system >/dev/null 2>&1 || true
    else
      echo "==> Skipping inotify limit bump (needs root/sudo)."
      echo "    If file watching misbehaves, raise fs.inotify.max_user_watches manually."
    fi
  fi
fi

# --- Agent egress containment preflight (docs/172, SHI-90) ---
# Containment is ON by default for all ShipIt instances (fail-closed): the
# orchestrator runs a privileged NET_ADMIN sidecar in each agent container's
# netns to apply a default-deny egress allowlist. If this host can't run that
# sidecar, ShipIt fails closed and refuses to start sessions. When the host
# can't grant the capability we ASK the operator (interactive) whether to
# install with containment disabled, rather than aborting with a variable to
# look up. SHIPIT_EGRESS=off pre-answers that prompt for non-interactive runs.

# Persist the egress opt-out (SESSION_EGRESS_ENFORCE=0) to the operator env file
# so it survives re-runs and image rebuilds; compose reads it via ${VAR:-}.
disable_egress_containment() {
  mkdir -p "$(dirname "$SHIPIT_ENV_FILE")"
  touch "$SHIPIT_ENV_FILE"; chmod 600 "$SHIPIT_ENV_FILE"
  if grep -q '^SESSION_EGRESS_ENFORCE=' "$SHIPIT_ENV_FILE" 2>/dev/null; then
    sed -i.bak "s/^SESSION_EGRESS_ENFORCE=.*/SESSION_EGRESS_ENFORCE=0/" "$SHIPIT_ENV_FILE" && rm -f "$SHIPIT_ENV_FILE.bak"
  else
    echo "SESSION_EGRESS_ENFORCE=0" >> "$SHIPIT_ENV_FILE"
  fi
}

echo "==> Checking agent egress containment support..."
# Bringing loopback down in a throwaway NET_ADMIN container requires
# CAP_NET_ADMIN and touches only that container's own netns — a safe,
# dependency-light proxy for "can run the egress sidecar".
if docker run --rm --cap-add NET_ADMIN alpine sh -c 'ip link set lo down' >/dev/null 2>&1; then
  echo "    Agent egress containment: enabled (default-deny allowlist)."
elif [ "${SHIPIT_EGRESS:-}" = "off" ]; then
  # Explicit, pre-answered opt-out (set before the command — e.g. CI/automation).
  disable_egress_containment
  echo "    Egress containment DISABLED (SHIPIT_EGRESS=off). Sessions will run with UNRESTRICTED outbound network."
else
  # The host denied CAP_NET_ADMIN — common with rootless Docker or a locked-down
  # kernel. sudo can't grant a capability the daemon won't hand out (and ShipIt
  # runs Docker un-elevated anyway), so this isn't a privilege we can escalate:
  # the real choice is "containment or not", which only the operator can make.
  echo "" >&2
  echo "  This host can't run the egress containment sidecar." >&2
  echo "  ShipIt isolates each agent container's outbound network with a privileged" >&2
  echo "  NET_ADMIN sidecar (default-deny + allowlist), and this host denied that" >&2
  echo "  capability (common with rootless Docker or a locked-down kernel)." >&2
  echo "" >&2
  echo "  Containment is ON by default and fails closed. You can install anyway with" >&2
  echo "  it DISABLED, but then a prompt-injected agent could exfiltrate credentials" >&2
  echo "  over the network." >&2
  echo "" >&2
  if [ -t 0 ]; then
    egress_reply=""
    read -rp "  Install with egress containment DISABLED (unrestricted egress)? [y/N]: " egress_reply
    case "$egress_reply" in
      y|Y|yes|Yes|YES)
        disable_egress_containment
        echo "    Egress containment DISABLED. Sessions will run with UNRESTRICTED outbound network."
        ;;
      *)
        echo "  Aborting — egress containment is required. Re-run on a host that can grant" >&2
        echo "  CAP_NET_ADMIN, or accept the prompt above to install without containment." >&2
        exit 1
        ;;
    esac
  else
    # No terminal to prompt (e.g. piped via 'curl … | bash'): fail closed and
    # surface the pre-answer for the non-interactive case.
    echo "  Non-interactive install (no terminal to prompt). To install without" >&2
    echo "  containment, re-run with SHIPIT_EGRESS=off set before the command:" >&2
    echo "" >&2
    echo "      SHIPIT_EGRESS=off bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)" >&2
    echo "" >&2
    exit 1
  fi
fi

# --- Build + start ---
shipit_build_and_up

echo ""
echo "==========================================="
echo "  ShipIt is running"
echo "==========================================="
echo ""
echo "  Open:    http://localhost:4123"
echo "  Update:  $SHIPIT_HOME/deployment/local/update.sh"
echo "  Stop:    $SHIPIT_HOME/deployment/local/stop.sh"
echo ""
echo "  On first launch, sign in to Claude Code or Codex from the in-app provider flow."
echo ""
