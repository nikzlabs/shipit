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
# docs/270 — the UID is now per-session; the GID is SHARED by every session and
# is what keeps the cross-session surfaces (the dep cache, the pnpm store, the
# overlay dependency base, the global gitconfig) usable by a session that did not
# create them. Defaults to the UID so an orchestrator that predates docs/270 —
# which forwards only SHIPIT_SESSION_WORKER_UID — boots this image unchanged.
WORKER_GID="${SHIPIT_SESSION_WORKER_GID:-$UID_GID}"

if [ -z "$UID_GID" ]; then
  # Flag off — legacy root runtime, byte-for-byte today's behavior.
  exec "$@"
fi

# docs/270 — chown the workspace WITHOUT taking ownership of anything that is
# shared with another clone or another session.
#
# Two things inside /workspace are not this session's to own:
#
#   1. `.git/objects` and `.git/lfs/objects` REGULAR FILES. `RepoGit.cloneFromCache`
#      creates every session clone with `git clone --local`, which HARDLINKS the
#      object store — measured: the bare cache and two clones report the same
#      inode for the same object. An inode has exactly one owner across all its
#      links, so a plain `chown -R` here would hand this session ownership (and
#      therefore chmod and rewrite rights) over object files the shared bare
#      cache and every sibling session's clone read. Under one shared uid that
#      was invisible; under per-session uids it is a cross-session write channel
#      — the very thing docs/270 exists to close.
#
#      The object DIRECTORIES are still chowned: the worker has to be able to
#      create a new object inside a fanout directory. This is the same split the
#      orchestrator side already makes in `chownGitMetadataRecursive`.
#
#   2. `.pnpm-store`, which is mounted NESTED under /workspace and is shared per
#      runtime across sessions. It gets the same group treatment /dep-cache does,
#      from the orchestrator (`ensurePnpmStoreDir`), so the walk must not descend
#      into it at all.
#
# `find … -prune` on the paths above, `-exec chown -h` on everything else. `-h`
# so a symlink is chowned in place and never followed out of the tree, matching
# the `lchown` the orchestrator-side helpers use.
chown_workspace() {
  d="$1"
  find "$d" \
    \( -path "$d/.pnpm-store" \) -prune -o \
    \( \( -path "$d/.git/objects/*" -o -path "$d/.git/lfs/objects/*" \) -type f \) -prune -o \
    -exec chown -h "${UID_GID}:${WORKER_GID}" {} +
}

# Only the writable runtime mounts + the runtime home. NEVER chown /app,
# /opt/agent-cli, /usr/local/bin, or system dirs — those stay root-owned and
# read-only to the worker (the shims under /usr/local/bin must stay traversable,
# which they are by default).
# /persist (docs/217) is the agent's writable persistent scratch mount; it needs
# the same worker-UID handoff as the other writable mounts or the non-root worker
# can't write to it. (/uploads is :ro — the writability probe below skips it;
# /persist is :rw, so it runs.)
# /session-state (docs/246) holds ShipIt's OWN per-session artifacts, moved out
# of the user's git clone. The worker writes the install marker there after
# `agent.install` and the agent reads fetched CI logs from it, so it needs the
# same handoff — without it the non-root worker EACCESes on the marker write and
# every `agent.install` re-runs.
# /plugin-store (docs/262) is deliberately absent from this loop: it is mounted
# :ro, so the writability probe below skips it anyway, and nothing in this
# container may write a plugin checkout (req 7). /plugins is handled separately
# just below — it is a plain directory on the container filesystem, not a mount.
for d in /workspace /uploads /persist /session-state /dep-cache /credentials /home/shipit; do
  case "$d" in
    # Skip the workspace chown when the orchestrator bind-mounted the host source
    # tree (dev / dogfood). `chown -R` on a bind mount rewrites *host* filesystem
    # ownership of the developer's checkout, which is destructive. See docs/150
    # §2/§9. Dev mode therefore bypasses the non-root hardening end-to-end.
    #
    # Suffix-matched (`*/workspace`, and `*/dep-cache` below) rather than
    # anchored on the absolute path. The loop's entries are a fixed literal list
    # two lines up, so nothing else can ever reach these branches — and matching
    # by suffix is what lets the entrypoint TEST run the branch against a temp
    # directory instead of the machine's real `/workspace`. That test executes
    # the script rather than pattern-matching it (see the header of
    # `session-worker-entrypoint.test.ts` for why), so a branch it cannot reach
    # is a branch nothing checks.
    */workspace) [ "${SHIPIT_SKIP_WORKSPACE_CHOWN:-0}" = "1" ] && continue ;;
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
  #
  # docs/270 — the sentinel and the walk both split by whether the mount is the
  # SESSION's or SHARED between sessions.
  #
  #   - A per-session mount is stamped with the uid AND gid, so a change to
  #     either re-runs the handoff once, and is chowned to that pair.
  #   - /dep-cache is shared by every session of a repo. Stamping it with the uid
  #     would make EVERY session re-walk a multi-gigabyte cache, and chowning it
  #     to the uid would take it away from every other session. So it is stamped
  #     with the shared GID, its group is set without touching the owner, and it
  #     is made group-writable with the setgid bit so entries a later session
  #     creates inherit the group too. That is what keeps a shared cache shared
  #     once uids differ (docs/270 req 9).
  #
  # Both sentinels are self-repairing for the same reason the uid one always was:
  # `mkdir` creates the marker as root, and the walk that follows chowns it too,
  # so the NEXT boot's check reads the handed-over value and skips.
  case "$d" in
    */dep-cache)
      marker="$d/.shipit-gid-${WORKER_GID}"
      if mkdir "$marker" 2>/dev/null || [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" != "$WORKER_GID" ]; then
        chown -R ":${WORKER_GID}" "$d"
        chmod -R g+rwX "$d"
        find "$d" -type d -exec chmod g+s {} + 2>/dev/null || true
      fi
      continue
      ;;
  esac
  marker="$d/.shipit-uid-${UID_GID}-${WORKER_GID}"
  if mkdir "$marker" 2>/dev/null \
    || [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" != "$UID_GID" ] \
    || [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" != "$WORKER_GID" ]; then
    case "$d" in
      */workspace) chown_workspace "$d" ;;
      *) chown -R "${UID_GID}:${WORKER_GID}" "$d" ;;
    esac
  fi
done

# docs/262 — /plugins holds the per-repo symlinks into the read-only plugin
# store, and the worker creates them AFTER dropping to UID_GID. `/` is
# root-owned, so without this the mkdir fails EACCES and the agent-facing
# `/plugins/<name>` path silently never appears. Handled here rather than in the
# loop above because it is not a mount: it needs no sentinel and no recursive
# walk, and the loop's sentinel would litter a dot-entry into a directory the
# agent lists. Under SESSION_READONLY_ROOTFS the orchestrator mounts a tmpfs
# here instead; this mkdir is then a harmless no-op on it.
# Best-effort, like the journal block below: this script runs under `set -e`, so
# an unconditional mkdir/chown here would abort the whole boot on any host where
# `/` is not writable by this process — taking the agent down over an optional
# feature. Failures are reported on stderr (the container's `docker logs`) so a
# missing plugin surface is diagnosable rather than silently absent, which is
# how the original EACCES bug hid.
if ! (mkdir -p /plugins && chown "${UID_GID}:${WORKER_GID}" /plugins) 2>/dev/null; then
  echo "[shipit] warning: could not prepare /plugins for UID ${UID_GID}; plugin checkouts will not be linked" >&2
fi

# docs/270 — OpenCode's credential home. The image symlinks
# ~/.local/share/opencode at /credentials/.local/share/opencode, and unlike the
# single-segment .claude/.codex targets, a recursive mkdir THROUGH that dangling
# leaf fails — so the target directory must exist before the CLI's first write.
# It is not a soft failure: OpenCode's own bootstrap dies on it. mkdir(2) returns
# EEXIST for a path that exists as a DANGLING SYMLINK, and OpenCode's Bun runtime
# surfaces that raw errno rather than converting it, so the whole agent process
# exits 1 with `EEXIST: file already exists, mkdir '/home/shipit/.local/share/opencode'`.
#
# It MUST run as the worker via gosu, not as root. The first version of this
# block did `mkdir -p` + `chown` as root on the premise that "/credentials was
# just handed off by the loop" — the loop does no such thing. The orchestrator
# hands the per-session credentials subtree to the session's uid and seals it
# 0700 (`session-credentials-scaffold.ts` -> `chownSessionCredentialsTree` ->
# `sealDirMode`) BEFORE the container starts, so /credentials is already
# foreign-owned and unreadable to root at every point in this script — the loop
# itself skips it, because its `[ -w "$d" ]` probe correctly reports a 0700 dir
# as unwritable. The container drops DAC_OVERRIDE (docs/150 §10,
# `container-lifecycle.ts` CapAdd), which is the only capability that bypasses a
# directory's write bit; the CHOWN and FOWNER it keeps bypass ownership checks
# for chown and chmod, and neither runs before the mkdir in the old compound. So
# the root form failed at its first command on every production boot — silently,
# since the warning goes to container stderr while the user sees the agent's
# EEXIST. (Root retains enough to seize the directory — CHOWN it to itself, then
# write. That is a repair we specifically do not want: it would undo the docs/270
# seal on the session's own credentials to create an empty directory.)
#
# gosu is the same remedy the SHIPIT_READONLY_HOME block below applies for the
# same reason, and it needs no chown: the directory lands owned by the worker
# because the worker is what created it. Still best-effort — a boot must never
# die over an optional credential surface.
if ! gosu "${UID_GID}:${WORKER_GID}" mkdir -p /credentials/.local/share/opencode 2>/dev/null; then
  echo "[shipit] warning: could not prepare /credentials/.local/share/opencode for UID ${UID_GID}; OpenCode will fail to start (EEXIST on the dangling ~/.local/share/opencode symlink)" >&2
fi

# docs/262 req 17 — /plugin-bin holds the generated companion-CLI wrappers the
# worker writes AFTER dropping to UID_GID, so it needs the same handoff /plugins
# does and for the same reason (`/` is root-owned). Nothing plugin-authored ever
# lands here: a wrapper is ShipIt's own four-line script that brokers an
# invocation container. Best-effort like the block above — a missing wrapper
# directory costs the session its plugin commands, not its agent.
if ! (mkdir -p /plugin-bin && chown "${UID_GID}:${WORKER_GID}" /plugin-bin) 2>/dev/null; then
  echo "[shipit] warning: could not prepare /plugin-bin for UID ${UID_GID}; plugin commands will not be on PATH" >&2
fi

# docs/172 Gap 5 (planning#99) — read-only rootfs. The orchestrator mounts a tmpfs at
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
  gosu "${UID_GID}:${WORKER_GID}" sh -c '
    ln -sfn /credentials/.claude      /home/shipit/.claude
    ln -sfn /credentials/.claude.json /home/shipit/.claude.json
    ln -sfn /credentials/.codex       /home/shipit/.codex
    mkdir -p /home/shipit/.local/share
    ln -sfn /credentials/.local/share/opencode /home/shipit/.local/share/opencode
    mkdir -p /home/shipit/.npm-global /home/shipit/.npm
  '
fi

# docs/270 — an ALLOCATED per-session uid has no passwd entry in the image, so
# the user form would never be reachable and every session would silently take
# the lossy path. Move the image's own `shipit` account onto the allocated uid
# first: `usermod -u` keeps the account's primary gid and its entire
# supplementary set, so the user form applies again and req 10 holds.
#
# It MUST run BEFORE the journal-group alignment below, not next to the drop it
# enables. That block resolves the worker's account name with
# `getent passwd "$UID_GID"` and gives up (`break`) when there is none — so with
# the order reversed an allocated uid would be moved onto an account the journal
# group had never been added to, and the drop would succeed while the journal
# stayed unreadable. The symptom is identical to having no `usermod` at all,
# which is what makes the ordering worth stating rather than trusting.
#
# Best-effort, like the /plugins and journal blocks: under
# SESSION_READONLY_ROOTFS=1 `/etc` is not writable and `usermod` fails, which
# must cost the session its journal read rather than its agent. `set -e` is why
# the failure is caught here rather than left to the command's exit status.
if ! getent passwd "$UID_GID" >/dev/null 2>&1; then
  if ! usermod -u "$UID_GID" shipit 2>/dev/null; then
    echo "shipit-entrypoint: could not move the shipit account to uid ${UID_GID} (read-only /etc?); the host journal will be unreadable" >&2
  fi
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
# the GID we intend to run with, because the user form takes the primary GID from
# passwd rather than from the argument. Both hold for the image's `shipit`
# account, and the `usermod` above keeps them holding for an allocated
# per-session uid. If that ever breaks, keep the old form and say so on stderr:
# running with the wrong primary group would be a worse failure than an
# unreadable journal.
# A non-empty field 4 also proves the passwd entry itself exists, so this is the
# only lookup the drop needs.
# docs/270 req 9 — create files group-writable, so a SHARED cache stays shared.
#
# The dep cache and the pnpm store are written by whichever session gets there
# first and used by every other. The boot-time handoff above sets their group and
# turns on setgid, so entries a session creates inherit the shared GROUP — but
# not group WRITE, which comes from the umask. At the default 022 every entry
# lands 0644 owned by its creator, and the next session (same group, different
# uid) can read it and not modify it.
#
# That is not hypothetical for npm: cacache appends to its `index-v5` entries
# rather than writing each once, so the second session's `npm install` fails
# EACCES on an index file the first session created. Content-addressed blobs
# would have survived; the index is what breaks.
#
# 002 rather than a chmod pass because the hazard is every file written from now
# on, not the ones that exist at boot. Safe inside a session: its directory is
# 0700, so group-writable files in the workspace are unreachable to every uid
# that is not this session anyway — the group bit only ever matters on the shared
# mounts, which is exactly where it is needed.
umask 002

worker_gid=$(getent passwd "$UID_GID" 2>/dev/null | cut -d: -f4 || true)
if [ -n "$worker_gid" ] && [ "$worker_gid" = "$WORKER_GID" ]; then
  exec gosu "$UID_GID" "$@"
fi
echo "shipit-entrypoint: uid ${UID_GID} has no passwd entry with primary gid ${WORKER_GID} (got '${worker_gid}'); dropping privileges without supplementary groups — the host journal will be unreadable" >&2
exec gosu "${UID_GID}:${WORKER_GID}" "$@"
