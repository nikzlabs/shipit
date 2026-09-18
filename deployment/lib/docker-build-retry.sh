# shellcheck shell=bash
# Bounded retry for transient registry failures. This sourced file defines functions only.
# Do not add an EXIT trap; it would replace deploy.sh's cleanup trap.

# Usage: shipit_docker_build_with_retry docker compose -f FILE build ARGS...
shipit_docker_build_with_retry() {
  local attempts="${SHIPIT_BUILD_ATTEMPTS:-3}"
  local delay="${SHIPIT_BUILD_RETRY_DELAY:-5}"
  local attempt=1
  local status=0
  local log
  # Reject invalid overrides to prevent an unbounded loop.
  case "$attempts" in '' | *[!0-9]*) attempts=3 ;; esac
  case "$delay" in '' | *[!0-9]*) delay=5 ;; esac
  [ "$attempts" -ge 1 ] || attempts=1
  log="$(mktemp "${TMPDIR:-/tmp}/shipit-build.XXXXXX")"

  while :; do
    # PIPESTATUS[0] preserves Docker's status if tee also fails.
    if "$@" 2>&1 | tee "$log"; then status=0; else status="${PIPESTATUS[0]}"; fi
    if [ "$status" -eq 0 ]; then
      rm -f "$log"
      return 0
    fi
    if [ "$attempt" -ge "$attempts" ] || ! shipit_build_failure_is_transient "$log"; then
      shipit_build_failure_note "$log" "$attempt"
      rm -f "$log"
      return "$status"
    fi
    echo "==> Build attempt ${attempt}/${attempts} failed with a transient registry error; retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

shipit_build_failure_is_transient() {
  # A disk error overrides any transient-looking line in the same log.
  if grep -qiE 'no space left on device|disk quota exceeded' "$1"; then
    return 1
  fi
  if grep -qiE \
    'TLS handshake timeout|i/o timeout|dial tcp|connection reset by peer|failed to do request|net/http: request canceled|unexpected status.*: 5[0-9][0-9]|unexpected HTTP status: 5[0-9][0-9]' \
    "$1"; then
    return 0
  fi
  # Require both halves to avoid retrying missing COPY sources or auth failures.
  grep -qi 'failed to resolve source metadata' "$1" && grep -qi 'not found' "$1"
}

shipit_build_failure_note() {
  grep -qi 'failed to resolve source metadata' "$1" || return 0
  local ref
  # Keep a missing digest from triggering the caller's `set -euo pipefail`.
  ref="$(grep -oE '[^[:space:]]+@sha256:[0-9a-f]{64}' "$1" | head -n1 || true)"
  [ -n "$ref" ] || ref="<image-ref>"
  {
    echo ""
    echo "NOTE: '$ref' failed to resolve after ${2} attempt(s)."
    echo "      A 'not found' / 'failed to resolve source metadata' here is COMMONLY a transient"
    echo "      registry or token-fetch failure, not a deleted image — the underlying network"
    echo "      error (e.g. a TLS handshake timeout) is visible only in the host's dockerd journal."
    echo "      Confirm the reference actually exists before changing any pin:"
    echo "        docker buildx imagetools inspect $ref"
  } >&2
}
