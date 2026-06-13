#!/bin/sh
# Session-worker entrypoint (docs/150 — non-root runtime).
#
# Runs as root ONLY long enough to prepare the writable runtime mounts, then
# drops to the unprivileged session-worker user (UID/GID 1000 = `shipit`) via
# gosu before exec'ing the worker. After this point neither the worker nor any
# child it spawns (agent CLI, terminal, agent.install, MCP servers) runs as
# UID 0.
#
# gosu (not setuid) relies on PID 1's CAP_SETUID/CAP_SETGID, which composes
# cleanly with `no-new-privileges`. Do NOT flip gosu to setuid or drop
# SETUID/SETGID from the container's CapAdd — that breaks this boot path.
set -eu

# The UID/GID the worker runs as. The orchestrator forwards the SAME
# SHIPIT_SESSION_WORKER_UID it gates its own chown helpers on, so the two sides
# can never disagree about who owns the mounts. Defaults to 1000 (the `shipit`
# user baked into the image).
UID_GID="${SHIPIT_SESSION_WORKER_UID:-1000}"

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
