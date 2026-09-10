#!/bin/sh
# Docker supplies PID 1. Keep exec and gosu so signals and supplementary groups survive.
set -eu

UID_GID="${SHIPIT_SESSION_WORKER_UID:-}"
WORKER_GID="${SHIPIT_SESSION_WORKER_GID:-$UID_GID}"

if [ -z "$UID_GID" ]; then
  exec "$@"
fi

# Never change shared object inodes or descend into dependency overlays: chown forces copy-up.
chown_workspace() {
  d="$1"
  set -- -path "$d/.pnpm-store"
  if [ -n "${SHIPIT_DEP_DIRS:-}" ]; then
    old_ifs=$IFS
    IFS=:
    for dep in $SHIPIT_DEP_DIRS; do
      [ -n "$dep" ] || continue
      set -- "$@" -o -path "$d/$dep"
    done
    IFS=$old_ifs
  fi
  find "$d" \
    \( "$@" \) -prune -o \
    \( \( -path "$d/.git/objects/*" -o -path "$d/.git/lfs/objects/*" \) -type f \) -prune -o \
    -exec chown -h "${UID_GID}:${WORKER_GID}" {} +
  find "$d" \( "$@" \) -prune -o \
    -type d -exec chmod g+rwxs {} + || true
  find "$d" \
    \( "$@" \) -prune -o \
    \( \( -path "$d/.git/objects/*" -o -path "$d/.git/lfs/objects/*" \) -type f \) -prune -o \
    -type f -exec chmod g+rwX {} + || true
  # Default ACLs preserve group write for future files from services with their own umask.
  acl_ok=1
  if command -v setfacl >/dev/null 2>&1; then
    find "$d" \( "$@" \) -prune -o \
      -type d -exec setfacl -d -m g::rwx -- {} + 2>/dev/null || true
  else
    acl_ok=0
    echo "shipit-entrypoint: setfacl not found; what a foreign-uid Compose service creates in $d will not be group-writable (docs/271 §3)" >&2
  fi
  # Hand off only dependency roots. chmod follows symlinks, so reject them.
  if [ -n "${SHIPIT_DEP_DIRS:-}" ]; then
    old_ifs=$IFS
    IFS=:
    for dep in $SHIPIT_DEP_DIRS; do
      [ -n "$dep" ] || continue
      [ -d "$d/$dep" ] || continue
      [ ! -L "$d/$dep" ] || continue
      chown -h "${UID_GID}:${WORKER_GID}" "$d/$dep" 2>/dev/null || true
      chmod g+rwxs "$d/$dep" 2>/dev/null || true
    done
    IFS=$old_ifs
  fi
  # Missing ACL support must leave the handoff unstamped so a later image retries.
  [ "$acl_ok" = "1" ]
}

share_cache_with_all_sessions() {
  d="$1"
  chown -R ":${WORKER_GID}" "$d" || return 1
  chmod -R g+rwX "$d" || true
  find "$d" -type d -exec chmod g+s {} + 2>/dev/null || true
}

prune_stale_sentinels() {
  tree="$1"; prefix="$2"; keep="$3"; as_worker="${4:-}"
  for stale in "$tree/$prefix"*; do
    [ -d "$stale" ] || continue
    [ "$stale" = "$keep" ] && continue
    if [ "$as_worker" = "worker" ]; then
      gosu "${UID_GID}:${WORKER_GID}" rmdir "$stale" 2>/dev/null || true
    else
      rmdir "$stale" 2>/dev/null || true
    fi
  done
  return 0
}

# Bump when the handoff changes, so existing trees receive the new treatment.
HANDOFF_SCHEME=3

for d in /workspace /uploads /persist /session-state /dep-cache /credentials /home/shipit; do
  case "$d" in
    */workspace) [ "${SHIPIT_SKIP_WORKSPACE_CHOWN:-0}" = "1" ] && continue ;;
  esac
  mkdir -p "$d"

  # Root lacks DAC_OVERRIDE. Check shared and pre-owned trees before test -w can skip them.
  case "$d" in
    */dep-cache)
      marker="$d/.shipit-gid-${WORKER_GID}-v${HANDOFF_SCHEME}"
      if [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" = "$WORKER_GID" ]; then
        continue
      fi
      if share_cache_with_all_sessions "$d"; then
        gosu "${UID_GID}:${WORKER_GID}" mkdir "$marker" 2>/dev/null || true
        prune_stale_sentinels "$d" ".shipit-gid-" "$marker" worker
      else
        echo "shipit-entrypoint: shared-cache handoff for $d did not complete; it will be retried on the next boot" >&2
      fi
      continue
      ;;
  esac

  case "$d" in
    */workspace)
      marker="$d/.shipit-uid-${UID_GID}-${WORKER_GID}-v${HANDOFF_SCHEME}"
      if [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" = "$UID_GID" ] \
        && [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" = "$WORKER_GID" ]; then
        continue
      fi
      if chown_workspace "$d"; then
        gosu "${UID_GID}:${WORKER_GID}" mkdir "$marker" 2>/dev/null || true
        prune_stale_sentinels "$d" ".shipit-uid-" "$marker" worker
      else
        echo "shipit-entrypoint: workspace handoff for $d did not complete; it will be retried on the next boot" >&2
      fi
      continue
      ;;
  esac

  # Remaining mounts are root-created or already handed off; read-only mounts must skip.
  [ -w "$d" ] || continue
  case "$d" in
  esac
  marker="$d/.shipit-uid-${UID_GID}-${WORKER_GID}-v${HANDOFF_SCHEME}"
  if mkdir "$marker" 2>/dev/null \
    || [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" != "$UID_GID" ] \
    || [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" != "$WORKER_GID" ]; then
    chown -R "${UID_GID}:${WORKER_GID}" "$d"
    prune_stale_sentinels "$d" ".shipit-uid-" "$marker"
  fi
done

if ! (mkdir -p /plugins && chown "${UID_GID}:${WORKER_GID}" /plugins) 2>/dev/null; then
  echo "[shipit] warning: could not prepare /plugins for UID ${UID_GID}; plugin checkouts will not be linked" >&2
fi

# Create symlink targets as the worker: /credentials is already sealed to that UID.
if ! gosu "${UID_GID}:${WORKER_GID}" mkdir -p /credentials/.local/share/opencode 2>/dev/null; then
  echo "[shipit] warning: could not prepare /credentials/.local/share/opencode for UID ${UID_GID}; OpenCode will fail to start (EEXIST on the dangling ~/.local/share/opencode symlink)" >&2
fi

if ! gosu "${UID_GID}:${WORKER_GID}" mkdir -p /credentials/.grok 2>/dev/null; then
  echo "[shipit] warning: could not prepare /credentials/.grok for UID ${UID_GID}; Grok turns will fail (dangling ~/.grok symlink)" >&2
fi

if ! (mkdir -p /plugin-bin && chown "${UID_GID}:${WORKER_GID}" /plugin-bin) 2>/dev/null; then
  echo "[shipit] warning: could not prepare /plugin-bin for UID ${UID_GID}; plugin commands will not be on PATH" >&2
fi

# The tmpfs hides image symlinks. Recreate them after its ownership handoff.
if [ "${SHIPIT_READONLY_HOME:-0}" = "1" ]; then
  gosu "${UID_GID}:${WORKER_GID}" sh -c '
    ln -sfn /credentials/.claude      /home/shipit/.claude
    ln -sfn /credentials/.claude.json /home/shipit/.claude.json
    ln -sfn /credentials/.codex       /home/shipit/.codex
    mkdir -p /home/shipit/.local/share
    ln -sfn /credentials/.local/share/opencode /home/shipit/.local/share/opencode
    mkdir -p /home/shipit/.npm-global /home/shipit/.npm
  '
fi

# Create the allocated UID's passwd entry before journal-group alignment uses it.
if ! getent passwd "$UID_GID" >/dev/null 2>&1; then
  if ! usermod -u "$UID_GID" shipit 2>/dev/null; then
    echo "shipit-entrypoint: could not move the shipit account to uid ${UID_GID} (read-only /etc?); the host journal will be unreadable" >&2
  fi
fi

worker_user=$(getent passwd "$UID_GID" 2>/dev/null | cut -d: -f1 || true)
# Split the space-separated override deliberately; mounted journals retain the host GID.
for journal_dir in ${SHIPIT_JOURNAL_DIRS:-/var/log/journal /run/log/journal}; do
  [ -n "$worker_user" ] || break
  [ -d "$journal_dir" ] || continue
  journal_gid=$(stat -c '%g' "$journal_dir" 2>/dev/null || true)
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

# New cache entries must remain writable by other sessions in the shared group.
umask 002

# gosu uid:gid discards supplementary groups; prefer the passwd entry when its GID matches.
worker_gid=$(getent passwd "$UID_GID" 2>/dev/null | cut -d: -f4 || true)
if [ -n "$worker_gid" ] && [ "$worker_gid" = "$WORKER_GID" ]; then
  exec gosu "$UID_GID" "$@"
fi
echo "shipit-entrypoint: uid ${UID_GID} has no passwd entry with primary gid ${WORKER_GID} (got '${worker_gid}'); dropping privileges without supplementary groups — the host journal will be unreadable" >&2
exec gosu "${UID_GID}:${WORKER_GID}" "$@"
