#!/usr/bin/env bash
# One-line local installer for ShipIt (macOS + Linux).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/local/setup.sh)
#
# Clones ShipIt to ~/.shipit (override with SHIPIT_HOME), builds the prod images,
# and starts ShipIt detached at http://localhost:4123. Unlike the VPS installer
# it sets up no Cloudflare / Tailscale / systemd — local binds to localhost and
# updates are applied by re-running deployment/local/update.sh. Installing a
# fork? Set SHIPIT_REPO_URL before the command.
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/nicolasalt/shipit.git"
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
