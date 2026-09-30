#!/usr/bin/env bash
# One take on the demo host, start to finish — docs/296 plan §9. Runs ON the
# demo host from the synced pipeline tree (sync-to-host.sh), so whoever starts
# it needs only SSH to the host, not a route to the instance.
#
#   demo-take.sh <record|replay> <scenario> <take-name> --instance <url> [--dry-run]
#
#   1. the tools image, built when demo-tools.Dockerfile has no image yet
#   2. the proxy image for the mode (demo-proxy-image.sh)
#   3. the instance reset (reset-demo-instance.sh), then a wait for /api/bootstrap
#   4. the repo reset (reset-demo-repo.sh)
#   5. the driver, in the tools container on the host's network
#   6. record only: the cassette, copied out of the session's proxy container
#   7. the cut
#
# Everything lands in <demo-home>/takes/<take-name>/: take.log (this script's
# whole output), recording.webm, beats.json, run.json, hero.mp4, hero.webm, and
# cassette/ after a record take — also after a record take whose driver failed,
# since the next take's reset would destroy it. <demo-home> is the directory
# that holds the pipeline tree. --instance is this host's own instance, by the
# name the host and a browser on it reach it at (previews need a name that
# carries a wildcard, so not 127.0.0.1); any other instance is refused, because
# step 3 resets this host's. One take at a time. --dry-run prints each step
# instead of running it.
#
# DEMO_GITHUB_ENV (default /root/shipit-demo-github.env) is the env file that
# holds GITHUB_TOKEN for step 4. It is handed to `sudo docker run --env-file`;
# this script never reads it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PIPELINE=$(cd "$HERE/.." && pwd)
DEMO_HOME=$(cd "$PIPELINE/.." && pwd)
GITHUB_ENV="${DEMO_GITHUB_ENV:-/root/shipit-demo-github.env}"
BOOT_TIMEOUT_S=300

log() { echo "[demo-take] $*" >&2; }
die() { log "$*"; exit 1; }
usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

DRY_RUN=0
INSTANCE=""
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) [ $# -ge 2 ] || usage; INSTANCE="${2%/}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    --*) die "unknown flag $1" ;;
    *) positional+=("$1"); shift ;;
  esac
done
[ ${#positional[@]} -eq 3 ] || usage
MODE=${positional[0]}
SCENARIO=${positional[1]}
TAKE=${positional[2]}

case "$MODE" in record|replay) ;; *) die "mode must be record or replay, got '$MODE'" ;; esac
for name in "$SCENARIO" "$TAKE"; do
  [[ "$name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "names must be lowercase letters, digits, '.', '_' or '-': $name"
done
[ -n "$INSTANCE" ] || die "--instance <url> is required"
[ -f "$PIPELINE/scenarios/$SCENARIO/storyboard.json" ] || die "no scenario at $PIPELINE/scenarios/$SCENARIO"
OUT="$DEMO_HOME/takes/$TAKE"
[ ! -e "$OUT" ] || die "$OUT already exists; a take never overwrites another"

# The image is named for its Dockerfile, so an edit there is a new image.
TOOLS_IMAGE="demo-tools:$(sha256sum "$HERE/demo-tools.Dockerfile" | cut -c1-12)"
IN_SCENARIO="/demo/pipeline/scenarios/$SCENARIO"

run() {
  echo "+ $*"
  [ "$DRY_RUN" -eq 1 ] || "$@"
}

# The pipeline read-only, the take's directory writable, the host's network
# (the instance answers on the host's own addresses), and the caller's uid so
# the take's files are the caller's.
tools() {
  docker run --rm --network host --shm-size 1g --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PIPELINE:/demo/pipeline:ro" -v "$OUT:/out" "$TOOLS_IMAGE" "$@"
}

wait_for_instance() {
  local deadline=$((SECONDS + BOOT_TIMEOUT_S))
  until curl -fsS -o /dev/null --max-time 5 "$INSTANCE/api/bootstrap"; do
    [ "$SECONDS" -lt "$deadline" ] || die "$INSTANCE/api/bootstrap did not answer within ${BOOT_TIMEOUT_S}s"
    sleep 3
  done
}

# The reset wipes THIS host's instance; a take pointed anywhere else would
# reset one instance and film another.
require_local_instance() {
  local host addr
  host=$(printf '%s' "$INSTANCE" | sed -E 's#^[a-z]+://##; s#[:/].*$##')
  addr=$(getent ahostsv4 "$host" | awk 'NR==1 { print $1 }')
  [ -n "$addr" ] || die "refusing: cannot resolve $host"
  ip -o -4 addr show | awk '{ print $4 }' | cut -d/ -f1 | grep -qxF "$addr" \
    || die "refusing: $INSTANCE resolves to $addr, which is not an address of this host — the reset would wipe this host's instance and the take would film another"
}

run require_local_instance
if [ "$DRY_RUN" -eq 0 ]; then
  # Two takes would reset the instance, the repo and the proxy image under each other.
  exec 9>"$DEMO_HOME/.demo-take.lock"
  flock -n 9 || die "another take is running on this host"
  mkdir -p "$OUT"
  exec > >(tee "$OUT/take.log") 2>&1
fi

docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1 \
  || run docker build -q -t "$TOOLS_IMAGE" -f "$HERE/demo-tools.Dockerfile" "$HERE"
run bash "$HERE/demo-proxy-image.sh" build "$MODE" "$SCENARIO"
run bash "$HERE/reset-demo-instance.sh"
run wait_for_instance
run sudo docker run --rm --network host --env-file "$GITHUB_ENV" -v "$PIPELINE:/demo/pipeline:ro" "$TOOLS_IMAGE" \
  bash /demo/pipeline/reset-demo-repo.sh --scenario "$IN_SCENARIO" --instance "$INSTANCE"

if ! run tools node /demo/pipeline/driver.mjs --instance "$INSTANCE" --scenario "$IN_SCENARIO" --out /out --mode "$MODE"; then
  # What a failed record take did record is in a container the next reset removes.
  if [ "$MODE" = record ]; then
    bash "$HERE/demo-proxy-image.sh" extract "$SCENARIO" "$OUT/cassette" || log "no cassette to rescue"
  fi
  die "the driver failed; see $OUT/take.log"
fi
if [ "$MODE" = record ]; then run bash "$HERE/demo-proxy-image.sh" extract "$SCENARIO" "$OUT/cassette"; fi
run tools env FFMPEG=ffmpeg bash /demo/pipeline/cut.sh /out/recording.webm /out/beats.json "$IN_SCENARIO/storyboard.json" /out/hero

if [ "$DRY_RUN" -eq 1 ]; then log "done (dry run)"; else log "done: $OUT"; fi
