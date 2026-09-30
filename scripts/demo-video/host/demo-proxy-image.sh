#!/usr/bin/env bash
# The demo proxy as an image on the demo host — docs/296 plan §2, §9. Runs ON
# the demo host (`ssh services`), beside proxy.mjs, demo-proxy-entrypoint.sh
# and cassettes/ in ~/shipit-demo.
#
# The demo repo's docker-compose.yml declares `demo-proxy` with
# `image: demo-proxy:current`, so a demo session runs its own proxy as one of
# its Compose services: a session's agent may reach its own services
# and nothing else on the machine (docs/319-api-reach-through-host req 4). The
# image exists only in this host's Docker; the mode and the cassette are baked
# in, so switching either is a rebuild.
#
#   demo-proxy-image.sh build replay <cassette>   cassettes/<cassette> copied in
#   demo-proxy-image.sh build record <cassette>   empty /cassettes/<cassette>
#   demo-proxy-image.sh extract <cassette>        copy a recorded take out of the
#                                                 demo-proxy container that holds
#                                                 it into cassettes/<cassette>
#
# DOCKER overrides the docker command (default `docker`; `sudo docker` on a
# host where the user is not in the docker group). DEMO_PROXY_PACE is the
# replay pace in characters per second (default 120).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE="demo-proxy:current"
# Same digest as docker/Dockerfile.prod and the session-worker image.
BASE="node:24-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d"
read -r -a DOCKER_CMD <<<"${DOCKER:-docker}"
PACE="${DEMO_PROXY_PACE:-120}"

die() { echo "demo-proxy-image: $*" >&2; exit 1; }
usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "cassette name must be lowercase letters, digits, '.', '_' or '-': $1"; }

build() {
  local mode=$1 name=$2 ctx
  valid_name "$name"
  case "$mode" in
    replay) [ -f "$HERE/cassettes/$name/fingerprints.jsonl" ] || die "no recorded take at $HERE/cassettes/$name" ;;
    record) [ ! -e "$HERE/cassettes/$name" ] || die "$HERE/cassettes/$name already exists; move it aside before recording over its name" ;;
    *) usage ;;
  esac
  ctx=$(mktemp -d)
  # Expanded now: `ctx` is local and gone by the time the trap runs.
  # shellcheck disable=SC2064
  trap "rm -rf '$ctx'" EXIT
  cp "$HERE/proxy.mjs" "$HERE/demo-proxy-entrypoint.sh" "$ctx/"
  mkdir -p "$ctx/cassettes/$name"
  [ "$mode" = replay ] && cp -r "$HERE/cassettes/$name/." "$ctx/cassettes/$name/"
  # A service runs as the session's own uid, which the image cannot know: the
  # record target has to be writable by anyone.
  cat >"$ctx/Dockerfile" <<EOF
FROM $BASE
COPY proxy.mjs demo-proxy-entrypoint.sh /app/
COPY cassettes/ /cassettes/
RUN chmod -R a+rwX /cassettes
ENV DEMO_PROXY_MODE=$mode DEMO_PROXY_CASSETTE=/cassettes/$name DEMO_PROXY_PACE=$PACE
EXPOSE 8787
ENTRYPOINT ["/bin/sh", "/app/demo-proxy-entrypoint.sh"]
EOF
  "${DOCKER_CMD[@]}" build -q -t "$IMAGE" "$ctx" >/dev/null
  echo "demo-proxy-image: built $IMAGE ($mode, /cassettes/$name)"
}

extract() {
  local name=$1 tmp id found=""
  valid_name "$name"
  [ ! -e "$HERE/cassettes/$name" ] || die "$HERE/cassettes/$name already exists; move it aside first"
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
  mkdir -p "$HERE/cassettes"
  cp -r "$tmp/$found/$name" "$HERE/cassettes/$name"
  echo "demo-proxy-image: extracted $(wc -l <"$HERE/cassettes/$name/fingerprints.jsonl") recording(s) from container $found to $HERE/cassettes/$name"
}

case "${1:-}" in
  build) [ $# -eq 3 ] || usage; build "$2" "$3" ;;
  extract) [ $# -eq 2 ] || usage; extract "$2" ;;
  *) usage ;;
esac
