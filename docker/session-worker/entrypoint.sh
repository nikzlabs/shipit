#!/bin/sh
# Session-worker entrypoint (docs/150 — non-root runtime).
#
# Gated on SHIPIT_SESSION_WORKER_UID so the whole non-root migration is
# flag-off-by-default and the orchestrator + image flip together:
#
#   - UNSET (default) — preserve the legacy root runtime: no chown, no privilege
#     drop, exec the worker as root. The image still ships the `shipit` user and
#     the /home/shipit symlink layout, but root reads everything, so credential
#     writes the orchestrator lands as `root:root` (its chown helpers are also
#     no-ops when the var is unset) stay readable. This makes the image safe to
#     ship BEFORE the coordinated flip — no auth break.
#   - SET (e.g. 1000) — prep the writable mounts (chown to the worker UID) and
#     drop to that unprivileged user via gosu before exec'ing the worker. The
#     orchestrator gates its own §7 chowns on the SAME var, so neither side can
#     disagree about who owns the mounts. One env flips both.
#
# gosu (not setuid) relies on PID 1's CAP_SETUID/CAP_SETGID, which composes
# cleanly with `no-new-privileges`. Do NOT flip gosu to setuid or drop
# SETUID/SETGID from the container's CapAdd — that breaks this boot path.
set -eu

UID_GID="${SHIPIT_SESSION_WORKER_UID:-}"

if [ -z "$UID_GID" ]; then
  # Flag off — legacy root runtime, byte-for-byte today's behavior.
  exec "$@"
fi

# Only the writable runtime mounts + the runtime home. NEVER chown /app,
# /opt/agent-cli, /usr/local/bin, or system dirs — those stay root-owned and
# read-only to the worker (the shims under /usr/local/bin must stay traversable,
# which they are by default).
for d in /workspace /uploads /dep-cache /credentials /home/shipit; do
  case "$d" in
    # Skip the workspace chown when the orchestrator bind-mounted the host source
    # tree (dev / dogfood). `chown -R` on a bind mount rewrites *host* filesystem
    # ownership of the developer's checkout, which is destructive. See docs/150
    # §2/§9. Dev mode therefore bypasses the non-root hardening end-to-end.
    /workspace) [ "${SHIPIT_SKIP_WORKSPACE_CHOWN:-0}" = "1" ] && continue ;;
  esac
  mkdir -p "$d"
  # Atomic-claim the chown via `mkdir` of a UID-stamped sentinel: on warm reuse
  # the walk is skipped (large node_modules trees), and for the shared /dep-cache
  # only the winner of a concurrent-boot race performs the walk. A UID change
  # rotates the sentinel name so the chown re-runs once under the new owner.
  marker="$d/.shipit-uid-${UID_GID}"
  if mkdir "$marker" 2>/dev/null; then
    chown -R "${UID_GID}:${UID_GID}" "$d"
  fi
done

exec gosu "${UID_GID}:${UID_GID}" "$@"
