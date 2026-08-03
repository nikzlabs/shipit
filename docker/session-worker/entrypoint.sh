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
# can't write to it. (/uploads is :ro — the writability probe below skips it;
# /persist is :rw, so it runs.)
for d in /workspace /uploads /persist /dep-cache /credentials /home/shipit; do
  case "$d" in
    # Skip the workspace chown when the orchestrator bind-mounted the host source
    # tree (dev / dogfood). `chown -R` on a bind mount rewrites *host* filesystem
    # ownership of the developer's checkout, which is destructive. See docs/150
    # §2/§9. Dev mode therefore bypasses the non-root hardening end-to-end.
    /workspace) [ "${SHIPIT_SKIP_WORKSPACE_CHOWN:-0}" = "1" ] && continue ;;
  esac
  mkdir -p "$d"
  # A read-only mount (/uploads) can neither hold the sentinel nor be chowned, so
  # there is nothing to hand off — skip it before the sentinel logic runs. This
  # MUST stay ahead of the ownership check below: that check treats a missing
  # sentinel as "handoff not done" and falls through to `chown -R`, which then
  # fails EROFS and, under `set -e`, kills the entrypoint. The sentinel can never
  # exist on a :ro mount, so every boot would take that path. `test -w` is the
  # right probe even though we are still root here: access(2) reports EROFS for
  # W_OK regardless of privilege, so a read-only mount reads as non-writable.
  [ -w "$d" ] || continue
  # Atomic-claim the chown via `mkdir` of a UID-stamped sentinel: on warm reuse
  # the walk is skipped (large node_modules trees), and for the shared /dep-cache
  # only the winner of a concurrent-boot race performs the walk. A UID change
  # rotates the sentinel name so the chown re-runs once under the new owner.
  #
  # A backup/volume restore recreates every inode as root, INCLUDING an existing
  # sentinel. Existence alone therefore cannot prove that the restored tree was
  # handed to the worker. Treat a marker owned by anyone other than UID_GID as
  # stale and re-run the handoff. This is what lets git-lfs replace restored,
  # root-owned pointer files instead of merely downloading their objects.
  marker="$d/.shipit-uid-${UID_GID}"
  if mkdir "$marker" 2>/dev/null || [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" != "$UID_GID" ]; then
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

# docs/128 (#1917) — make the host's systemd journal readable to the worker.
#
# Ops sessions bind-mount the host journal read-only (/var/log/journal,
# /run/log/journal). Those files are 0640 root:systemd-journal on the HOST, and
# a bind mount carries the *numeric* GID through unchanged — the kernel checks
# that number, never the group name. So the image's build-time
# `groupadd -rf systemd-journal && usermod -aG systemd-journal shipit`
# (Dockerfile.session-worker.docker) is necessary but NOT sufficient: `groupadd`
# allocates whatever GID is free in the image, which has nothing to do with the
# host's. Read the real number off the mount instead, and make sure some group
# in this container carries it.
#
# Best-effort by design: no journal mount (every non-ops session), an unwritable
# /etc (SESSION_READONLY_ROOTFS=1), or a missing groupadd each leave the
# container exactly as it was rather than failing the boot. Failures are logged
# to stderr — the session container's `docker logs` — so a broken journal pillar
# is diagnosable instead of silently empty, which is how #1917 stayed hidden.
worker_user=$(getent passwd "$UID_GID" 2>/dev/null | cut -d: -f1 || true)
# Unquoted on purpose — the override is a space-separated path list. It exists
# so a host whose journal lives elsewhere can point at it (and so the test can
# run this block against temp dirs); the default is the pair ops sessions mount.
for journal_dir in ${SHIPIT_JOURNAL_DIRS:-/var/log/journal /run/log/journal}; do
  [ -n "$worker_user" ] || break
  [ -d "$journal_dir" ] || continue
  journal_gid=$(stat -c '%g' "$journal_dir" 2>/dev/null || true)
  # Skip a non-numeric stat and GID 0: a root-owned journal grants nothing to a
  # supplementary group, and adding the worker to GID 0 would be a privilege
  # gain rather than a read grant.
  case "$journal_gid" in
    '' | 0 | *[!0-9]*) continue ;;
  esac
  journal_group=$(getent group "$journal_gid" 2>/dev/null | cut -d: -f1 || true)
  if [ -z "$journal_group" ]; then
    journal_group="shipit-journal-${journal_gid}"
    groupadd -g "$journal_gid" "$journal_group" 2>/dev/null || {
      echo "shipit-entrypoint: could not create a group for ${journal_dir} (gid ${journal_gid}); it will be unreadable" >&2
      continue
    }
  fi
  usermod -aG "$journal_group" "$worker_user" 2>/dev/null \
    || echo "shipit-entrypoint: could not add ${worker_user} to ${journal_group} (gid ${journal_gid}); ${journal_dir} will be unreadable" >&2
done

# The privilege drop MUST preserve supplementary groups (#1917).
#
# `gosu <uid>:<gid>` takes runc's explicit-group path: it resolves the primary
# GID from the argument and then calls setgroups() with an EMPTY list, so every
# supplementary group — the image's baked-in `systemd-journal`/`adm` and
# everything aligned above — is discarded. That is exactly why #1917 observed
# `groups=1000(shipit)` inside an image whose build *asserts* membership in both
# groups. The user form (`gosu <uid>`) takes the other path: it resolves the
# passwd entry and initializes the supplementary set from /etc/group.
#
# Only take the user form when it is otherwise byte-identical to the old
# behavior — the passwd entry must exist AND its primary GID must already equal
# UID_GID, because the user form takes the primary GID from passwd rather than
# from the argument. Both hold for the image's `shipit` account. If a custom UID
# ever breaks that, keep the old form and say so on stderr: running with the
# wrong primary group would be a worse failure than an unreadable journal.
# A non-empty field 4 also proves the passwd entry itself exists, so this is the
# only lookup the drop needs.
worker_gid=$(getent passwd "$UID_GID" 2>/dev/null | cut -d: -f4 || true)
if [ -n "$worker_gid" ] && [ "$worker_gid" = "$UID_GID" ]; then
  exec gosu "$UID_GID" "$@"
fi
echo "shipit-entrypoint: uid ${UID_GID} has no passwd entry with a matching primary gid (got '${worker_gid}'); dropping privileges without supplementary groups — the host journal will be unreadable" >&2
exec gosu "${UID_GID}:${UID_GID}" "$@"
