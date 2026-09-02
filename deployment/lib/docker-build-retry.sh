# shellcheck shell=bash
# Bounded retry around a `docker compose build` for TRANSIENT registry faults.
# Source this file; it defines functions only.
#
# Why: on 2026-09-02 the production self-updater failed the whole update — and
# rolled the checkout back — because ONE HEAD to ghcr.io hit a TLS handshake
# timeout. The retry 0.6s later got a 404 (GHCR's answer to a manifest request
# whose bearer-token fetch went to the same host that had just timed out), and
# BuildKit surfaced that as `not found`. The exact same commit, with the exact
# same digest pin, built successfully 40 minutes later with no code change.
#
# So the operator-visible text of a transient registry fault is
# indistinguishable from a genuinely deleted image: the underlying network error
# appears only in the host's dockerd journal, never in the build output. We
# therefore DO retry that shape, and rely on a small bounded attempt count to
# keep a genuinely missing image from spinning. A retry is cheap — the build
# replays from BuildKit cache up to the step that failed.
#
# Deliberately NOT wired into the interactive build paths (docker/local/dev.sh,
# docker/local/prod.sh, deployment/local/lib.sh): classifying a failure requires
# capturing the output, which makes stderr a pipe and drops BuildKit's live
# progress renderer to plain lines. That is a bad trade where a human is already
# watching and can just re-run. The unattended updater has no human and a
# rollback on the line, so it takes the trade.
#
# Do NOT add an EXIT trap here to clean up the capture file: deploy.sh already
# installs one (prune_build_artifacts), and bash keeps a single EXIT trap — a
# second one silently replaces it, so the failed build's dangling images and
# BuildKit cache would stop being reclaimed (issue #1050). The capture file is
# removed on every return path instead.

# Retry `docker compose build …` on a transient registry failure.
# Usage: shipit_docker_build_with_retry docker compose -f FILE build ARGS...
# Returns the last attempt's exit status.
shipit_docker_build_with_retry() {
  local attempts="${SHIPIT_BUILD_ATTEMPTS:-3}"
  local delay="${SHIPIT_BUILD_RETRY_DELAY:-5}"
  local attempt=1
  local status=0
  local log
  # A non-numeric override would make the `[ "$attempt" -ge "$attempts" ]` below
  # fail INSIDE an `if` — which does not abort — i.e. retry forever. Fall back to
  # the defaults rather than trust the environment.
  case "$attempts" in '' | *[!0-9]*) attempts=3 ;; esac
  case "$delay" in '' | *[!0-9]*) delay=5 ;; esac
  [ "$attempts" -ge 1 ] || attempts=1
  log="$(mktemp "${TMPDIR:-/tmp}/shipit-build.XXXXXX")"

  while :; do
    # `2>&1 | tee` keeps the build streaming to the operator while capturing it
    # for classification. Read PIPESTATUS, not the pipeline status: under
    # `pipefail` bash reports the RIGHTMOST failure, so a `tee` that also failed
    # (a full /tmp) would replace docker's exit status with tee's.
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

# True when the captured build log looks like a network/registry blip rather
# than a deterministic build failure. Patterns come from the 2026-09-02 incident
# (dockerd resolver journal + BuildKit output) plus the usual registry 5xx set.
shipit_build_failure_is_transient() {
  # A full disk is emphatically NOT transient: retrying burns minutes and the
  # operator needs the message. Checked FIRST so it wins over any transient-
  # looking line in the same log — a disk that fills mid-build produces both.
  # deploy.sh's EXIT trap prunes either way.
  if grep -qiE 'no space left on device|disk quota exceeded' "$1"; then
    return 1
  fi
  if grep -qiE \
    'TLS handshake timeout|i/o timeout|dial tcp|connection reset by peer|failed to do request|net/http: request canceled|unexpected status.*: 5[0-9][0-9]|unexpected HTTP status: 5[0-9][0-9]' \
    "$1"; then
    return 0
  fi
  # The ambiguous incident shape: reference RESOLUTION that ends in `not found`.
  # BOTH halves are required, and neither is safe alone. `failed to solve: … not
  # found` on its own is what a missing COPY source produces — deterministic, and
  # retrying it costs minutes on every broken deploy. `failed to resolve source
  # metadata` on its own also covers deterministic auth/policy refusals, which
  # will not fix themselves either.
  grep -qi 'failed to resolve source metadata' "$1" && grep -qi 'not found' "$1"
}

# On a final failure that looks like a reference-resolution error, say the one
# thing the 2026-09-02 investigation was missing: `not found` here usually is
# not a deleted digest, and this is how to settle it.
shipit_build_failure_note() {
  grep -qi 'failed to resolve source metadata' "$1" || return 0
  local ref
  # `|| true` is load-bearing: deploy.sh runs under `set -euo pipefail`, so a
  # grep that matches nothing makes this assignment fail and aborts the script
  # right here — losing docker's exit status, leaking the log, and swallowing
  # the very note this function exists to print. That is precisely the no-digest
  # case the fallback below is for.
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
