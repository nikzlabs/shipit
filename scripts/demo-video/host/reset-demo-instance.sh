#!/usr/bin/env bash
# Reset the demo instance between takes — docs/296 plan §9. Runs ON the demo
# host (`ssh services`), never from a session: it drives the local install's
# own scripts and Docker directly.
#
#   demo-proxy project down   (compose down cannot remove the shipit-prod
#                              network while the proxy is attached to it)
#   stop.sh                   (compose down, volumes kept; session containers removed)
#   docker volume rm shipit-prod_workspace   (sessions, repo cache, .shipit.db)
#   keep shipit-prod_credentials             (provider keys + the GitHub token)
#   shipit_build_and_up       (cached build, .shipit.env, tailnet overlay, up)
#   demo-proxy project up
#
# Idempotent: every step tolerates its state already being the case. Refuses to
# run unless the install's Compose project is `shipit-prod` — the guard against
# pointing it at any other ShipIt on a machine.
#
# Usage: reset-demo-instance.sh [--dry-run] [--shipit-home DIR] [--proxy-compose FILE]
#   --dry-run prints each command instead of running it.
#   SHIPIT_HOME (default ~/.shipit) and DEMO_PROXY_COMPOSE
#   (default ~/shipit-demo/demo-proxy.compose.yml) are the env equivalents.
set -euo pipefail

EXPECTED_STACK="shipit-prod"
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
PROXY_COMPOSE="${DEMO_PROXY_COMPOSE:-$HOME/shipit-demo/demo-proxy.compose.yml}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --shipit-home) SHIPIT_HOME="$2"; shift 2 ;;
    --proxy-compose) PROXY_COMPOSE="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "reset-demo-instance: unknown argument $1" >&2; exit 2 ;;
  esac
done
export SHIPIT_HOME

log() { echo "[reset-demo-instance] $*" >&2; }
die() { log "$*"; exit 1; }

run() {
  echo "+ $*"
  [ "$DRY_RUN" -eq 1 ] || "$@"
}

LIB="$SHIPIT_HOME/deployment/local/lib.sh"
[ -f "$LIB" ] || die "no local install at $SHIPIT_HOME (missing $LIB)"
# shellcheck source=/dev/null
. "$LIB"

# Two independent readings of the project name have to agree with the demo's.
[ "${COMPOSE_STACK:-}" = "$EXPECTED_STACK" ] || die "refusing: lib.sh names Compose stack '${COMPOSE_STACK:-}', expected $EXPECTED_STACK"
grep -Eq "^name:[[:space:]]*$EXPECTED_STACK[[:space:]]*$" "$COMPOSE_FILE" \
  || die "refusing: $COMPOSE_FILE is not the $EXPECTED_STACK project"

WORKSPACE_VOLUME="${EXPECTED_STACK}_workspace"
CREDENTIALS_VOLUME="${EXPECTED_STACK}_credentials"

# 1. demo-proxy down — its own project, attached to the instance's network.
if [ -f "$PROXY_COMPOSE" ]; then
  run sudo docker compose -f "$PROXY_COMPOSE" down
else
  log "no demo-proxy compose file at $PROXY_COMPOSE; skipping the proxy steps"
fi

# 2. Stop the instance; stop.sh keeps both volumes and removes session containers.
run "$SHIPIT_HOME/deployment/local/stop.sh"

# 3. Drop the workspace volume, keep credentials.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ docker volume rm $WORKSPACE_VOLUME   (if present)"
elif docker volume inspect "$WORKSPACE_VOLUME" > /dev/null 2>&1; then
  run docker volume rm "$WORKSPACE_VOLUME"
else
  log "$WORKSPACE_VOLUME already absent"
fi
if [ "$DRY_RUN" -eq 0 ] && ! docker volume inspect "$CREDENTIALS_VOLUME" > /dev/null 2>&1; then
  log "warning: $CREDENTIALS_VOLUME is missing — the instance will boot to the GitHub modal (plan §9)"
fi

# 4. Up, via the recipe's own function: loads .shipit.env, refreshes the
#    tailnet overlay, cached build, `up -d`. Not update.sh — that also re-syncs
#    the checkout to origin/main, which moves the instance under a pinned take.
run env "SHIPIT_HOME=$SHIPIT_HOME" bash -c '. "$SHIPIT_HOME/deployment/local/lib.sh" && shipit_build_and_up'

# 5. demo-proxy up, now that the network exists again.
if [ -f "$PROXY_COMPOSE" ]; then
  run sudo docker compose -f "$PROXY_COMPOSE" up -d
fi

if [ "$DRY_RUN" -eq 1 ]; then log "done (dry run)"; else log "done"; fi
