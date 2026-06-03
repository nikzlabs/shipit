#!/bin/sh
# ShipIt one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/install.sh | sh
#
# Clones (or updates) ShipIt, builds the Docker images, and starts it at
# http://localhost:4123. Set SHIPIT_DIR to control where it's checked out
# (defaults to ./shipit).
set -e

REPO_URL="https://github.com/nicolasalt/shipit.git"
INSTALL_DIR="${SHIPIT_DIR:-shipit}"

err() {
  echo "Error: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || err "git is required. Install it and re-run."
command -v docker >/dev/null 2>&1 || err "Docker is required. See https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || \
  err "Docker Compose v2 plugin is required (the 'docker compose' command). See https://docs.docker.com/compose/install/"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing ShipIt checkout in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning ShipIt into $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "Building images and starting ShipIt at http://localhost:4123 ..."
exec docker/local/prod.sh
