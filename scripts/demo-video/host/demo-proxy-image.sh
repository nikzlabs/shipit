#!/usr/bin/env bash
# The demo proxy as the image `demo-proxy:current` in the demo host's Docker,
# which the demo repo's `demo-proxy` Compose service runs (docs/296 plan §2,
# §9). Runs ON the demo host, inside the synced pipeline tree (proxy.mjs one
# level up, the scenarios beside it). The mode, the cassette and the pace are
# baked in, so switching any of them is a rebuild.
#
#   demo-proxy-image.sh build replay <scenario>   scenarios/<scenario>/cassette copied in
#   demo-proxy-image.sh build record <scenario>   empty /cassettes/<scenario>
#   demo-proxy-image.sh extract <scenario> <dir>  copy a recorded take out of the
#                                                 demo-proxy container that holds
#                                                 it, as <dir>
#
# DOCKER overrides the docker command (default `docker`). DEMO_PROXY_PACE is
# the replay pace in characters per second (default 120).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PIPELINE=$(cd "$HERE/.." && pwd)
IMAGE="demo-proxy:current"
# Same digest as docker/Dockerfile.prod and the session-worker image.
BASE="node:24-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d"
read -r -a DOCKER_CMD <<<"${DOCKER:-docker}"
PACE="${DEMO_PROXY_PACE:-120}"

die() { echo "demo-proxy-image: $*" >&2; exit 1; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "scenario name must be lowercase letters, digits, '.', '_' or '-': $1"; }

build() {
  local mode=$1 name=$2 ctx committed="$PIPELINE/scenarios/$2/cassette"
  valid_name "$name"
  case "$mode" in
    replay) [ -f "$committed/fingerprints.jsonl" ] || die "no committed cassette at $committed" ;;
    record) ;;
    *) usage ;;
  esac
  ctx=$(mktemp -d)
  # Expanded now: `ctx` is local and gone by the time the trap runs.
  # shellcheck disable=SC2064
  trap "rm -rf '$ctx'" EXIT
  cp "$PIPELINE/proxy.mjs" "$HERE/demo-proxy-entrypoint.sh" "$ctx/"
  mkdir -p "$ctx/cassettes/$name"
  if [ "$mode" = replay ]; then cp -r "$committed/." "$ctx/cassettes/$name/"; fi
  # A service runs as the session's own uid, which the image cannot know: the
  # record target has to be writable by anyone.
  printf '%s\n' \
    "FROM $BASE" \
    "COPY proxy.mjs demo-proxy-entrypoint.sh /app/" \
    "COPY cassettes/ /cassettes/" \
    "RUN chmod -R a+rwX /cassettes" \
    "ENV DEMO_PROXY_MODE=$mode DEMO_PROXY_CASSETTE=/cassettes/$name DEMO_PROXY_PACE=$PACE" \
    "EXPOSE 8787" \
    'ENTRYPOINT ["/bin/sh", "/app/demo-proxy-entrypoint.sh"]' \
    >"$ctx/Dockerfile"
  "${DOCKER_CMD[@]}" build -q -t "$IMAGE" "$ctx" >/dev/null
  echo "demo-proxy-image: built $IMAGE ($mode, /cassettes/$name)"
}

extract() {
  local name=$1 dest=$2 tmp id found=""
  valid_name "$name"
  [ ! -e "$dest" ] || die "$dest already exists"
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  # Each demo session that started the service has its own proxy container;
  # the take is in the one that served the turn.
  for id in $("${DOCKER_CMD[@]}" ps -a -q --filter "ancestor=$IMAGE"); do
    mkdir "$tmp/$id"
    # As a tar stream, so the copy belongs to whoever runs this, not to the
    # session's uid.
    "${DOCKER_CMD[@]}" cp "$id:/cassettes/$name" - 2>/dev/null | tar -x -C "$tmp/$id" --no-same-owner 2>/dev/null || continue
    [ -f "$tmp/$id/$name/fingerprints.jsonl" ] || continue
    [ -z "$found" ] || die "more than one container of $IMAGE holds a take at /cassettes/$name ($found, $id); copy the right one by hand"
    found=$id
  done
  [ -n "$found" ] || die "no container of $IMAGE holds a take at /cassettes/$name"
  mkdir -p "$(dirname "$dest")"
  cp -r "$tmp/$found/$name" "$dest"
  echo "demo-proxy-image: extracted $(wc -l <"$dest/fingerprints.jsonl") recording(s) from container $found to $dest"
}

case "${1:-}" in
  build) [ $# -eq 3 ] || usage; build "$2" "$3" ;;
  extract) [ $# -eq 3 ] || usage; extract "$2" "$3" ;;
  *) usage ;;
esac
