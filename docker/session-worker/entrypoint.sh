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
# /persist (docs/217) is the agent's writable persistent scratch mount; it needs
# the same worker-UID handoff as the other writable mounts or the non-root worker
# can't write to it. (/uploads is :ro — its sentinel mkdir fails on the read-only
# mount, so the chown self-skips; /persist is :rw, so it runs.)
for d in /workspace /uploads /persist /dep-cache /credentials /home/shipit; do
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

# docs/172 Gap 5 (SHI-97) — read-only rootfs. The orchestrator mounts a tmpfs at
# /home/shipit (the HOME holds writable caches: ~/.npm, ~/.npm-global, ~/.cache,
# ~/.claude.json), which SHADOWS the image-baked credential symlinks. Re-create
# them into the tmpfs so the agent CLIs still resolve their creds from the
# persistent /credentials mount. No-op unless the orchestrator set the flag.
if [ "${SHIPIT_READONLY_HOME:-0}" = "1" ]; then
  # The chown loop above just handed the /home/shipit tmpfs to UID_GID, and the
  # container drops DAC_OVERRIDE (docs/150 §10 — the worker owns its own files and
  # no longer bypasses DAC as root). So root can NO LONGER write into the now
  # non-root-owned dir: creating these symlinks as root fails EPERM. Create them
  # AS the target user via gosu (uses CAP_SETUID/SETGID, already in CapAdd, and
  # composes with no-new-privileges) — ownership then lands correct for free and
  # we never need DAC_OVERRIDE back. Must run after the chown above, not before:
  # a pre-chown `chown -R` would dereference the .claude symlink into /credentials.
  gosu "${UID_GID}:${UID_GID}" sh -c '
    ln -sfn /credentials/.claude      /home/shipit/.claude
    ln -sfn /credentials/.claude.json /home/shipit/.claude.json
    ln -sfn /credentials/.codex       /home/shipit/.codex
    mkdir -p /home/shipit/.npm-global /home/shipit/.npm
  '
fi

exec gosu "${UID_GID}:${UID_GID}" "$@"
