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
# Three things inside /workspace are not this session's to own:
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
#   3. The declared dep dirs (`agent.dep-dirs`, resolved by the orchestrator and
#      forwarded as SHIPIT_DEP_DIRS — planning#415). A dep dir is either a
#      docs/183 overlay mount whose lowerdir is a base generation SHARED by
#      every session of the repo, or a plain populated install cache. In the
#      overlay case ANY chown/chmod on a lower-only entry forces a copy-up of
#      that file into this session's private upper layer — `chown_common` sets
#      ATTR_UID whenever the argument is not `-1`, whether or not the value
#      changes, so even an ownership-preserving chown copies the whole shared
#      base up and defeats the sharing docs/183 exists for. The per-session
#      contents are owned orchestrator-side instead
#      (`reconcileDepDirCacheOwnership` over the upperdir, every container
#      create), so the walk here prunes the whole dep dir and gives only its
#      ROOT a shallow handoff — see the tail of `chown_workspace`. This mirrors
#      the orchestrator-side worktree walk (`chownWorktreeToSessionWorker`'s
#      `excludeRelDirs`), which excludes the dep dirs for the same reasons.
#
# `find … -prune` on the paths above, `-exec chown -h` on everything else. `-h`
# so a symlink is chowned in place and never followed out of the tree, matching
# the `lchown` the orchestrator-side helpers use.
#
# docs/271 — and group-writable, in a second pass over the same tree.
#
# A Compose service cannot run as UID_GID: ShipIt's fill-in supplies it only to a
# service that declares no `user:`, and a project may not declare a uid in the
# session range at all. The shared GROUP is therefore the only channel between a
# service and the workspace it shares with the agent, and the write bit is what
# that channel was missing — a root-materialized checkout is 0644/0755, so every
# service in every repository could read the workspace and not write it
# (github#2374). This is the same rule `umask 002` below already applies to files
# created after boot, applied to the ones that existed before it.
#
# Safe for the same reason the umask is: the session directory is 0700, so
# group-writable files inside a session are unreachable to every uid outside it.
#
# SEPARATE passes rather than more `-exec`s on the one above, because the three
# differ on what they may touch. `chown -h` must reach a symlink and stop there;
# `chmod` has no `-h` and follows one, so it would rewrite whatever the link
# points at — possibly outside the tree — and both mode passes therefore select
# `-type d` / `-type f`, which excludes symlinks on their own. The git-object
# prune is kept for the FILE pass and for the same reason it exists above: a mode,
# like an owner, belongs to the inode, and those inodes are hardlinked into the
# shared bare cache and every sibling clone. Object DIRECTORIES are moded, exactly
# as they are chowned, so the worker can still add an object to a fanout dir.
#
# Best-effort (`|| true`), unlike the chown: this script runs under `set -e`, and
# a boot must not die over a file mode on a filesystem that will not take one.
#
# The object patterns are anchored at the TOP-LEVEL `.git`, so a submodule's
# `.git/modules/<name>/objects` is not pruned — matching the chown above, and
# harmless for the same reason: `git clone --local` hardlinks only the top-level
# object store from the bare cache, so a submodule's objects are this session's
# own. Revisit both if the bare cache ever starts carrying submodule objects.
chown_workspace() {
  d="$1"
  # planning#415 — the declared dep dirs join the prune set, as `.pnpm-store`
  # above already does. POSIX sh has no arrays, so the `-path … -o -path …`
  # terms accumulate in the POSITIONAL PARAMETERS, one quoted word per path —
  # a dep-dir name containing a space survives, and the three finds below each
  # splice the whole set in as `\( "$@" \)`. SHIPIT_DEP_DIRS is colon-separated
  # (the PATH convention); an unset or empty value — an orchestrator that
  # predates this change, or an explicit `agent.dep-dirs: []` — leaves exactly
  # today's prune set, so the legacy boot is byte-for-byte unchanged.
  #
  # No HANDOFF_SCHEME bump for THIS: v2's walk already chowned and group-wrote
  # every dep-dir ROOT (it was not pruned, so the root got the full treatment),
  # which is all the shallow pass at the tail of this function applies. A tree
  # claimed under v2 therefore had nothing to gain from a re-walk on this
  # account — the copy-ups it already suffered cannot be undone by walking again.
  # (v3 exists, for the default-ACL pass below, and it does not change that: the
  # dep dirs stay pruned from it too.)
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
  # Directories: group write + traverse, and setgid so an entry a Compose service
  # creates inherits the shared group instead of that service's own.
  find "$d" \( "$@" \) -prune -o \
    -type d -exec chmod g+rwxs {} + || true
  # Files: group write, and group execute ONLY where some class already has it
  # (`X`), so nothing becomes executable that was not.
  find "$d" \
    \( "$@" \) -prune -o \
    \( \( -path "$d/.git/objects/*" -o -path "$d/.git/lfs/objects/*" \) -type f \) -prune -o \
    -type f -exec chmod g+rwX {} + || true
  # docs/271 §3 — and a POSIX DEFAULT ACL on each directory, which is what the
  # two mode passes above cannot do: they fix the nodes that exist, and a Compose
  # service running at a uid the project declared (docs/271 req 4 keeps it) then
  # creates NEW ones under its own umask 022 — `0644`/`0755`, owned by that uid.
  # Setgid propagates the shared group to them and not the group write bit, so
  # the agent can traverse a directory such a service created and neither add to
  # nor delete from it, and orchestrator git (dropped to the session uid by
  # docs/266) cannot unlink its contents during a checkout. A default ACL is
  # applied by the kernel at creation time and REPLACES the umask, so it reaches
  # a writer ShipIt does not own without wrapping a command ShipIt does not own;
  # and it is inherited, so every later `mkdir` carries it forward and this walk
  # only ever has to repair the tree that already exists.
  #
  # Same prunes as the mode passes and `-type d` for the same reason: a default
  # ACL exists only on a directory, and `setfacl` follows a symlink.
  #
  # Guarded and best-effort, but NOT silently: a missing `setfacl` makes this
  # function report failure (see its tail), so the caller declines to stamp the
  # scheme sentinel and the next boot retries. Without that, a session that
  # happened to boot on an image predating the `acl` install would remember an
  # incomplete walk as a finished one and never get the pass again — the
  # self-latching shape `share_cache_with_all_sessions` was fixed for. The tree
  # is still chowned and still group-writable meanwhile, which is exactly the
  # pre-docs/271-§3 behaviour, and a boot must never fail over this.
  acl_ok=1
  if command -v setfacl >/dev/null 2>&1; then
    find "$d" \( "$@" \) -prune -o \
      -type d -exec setfacl -d -m g::rwx -- {} + 2>/dev/null || true
  else
    acl_ok=0
    echo "shipit-entrypoint: setfacl not found; what a foreign-uid Compose service creates in $d will not be group-writable (docs/271 §3)" >&2
  fi
  # planning#415 — the dep-dir ROOTS still get a handoff, SHALLOWLY: one chown
  # and one chmod on the root, never a descent. In overlay mode the merged dep
  # dir's root IS the per-session upperdir's root, so these are in-place upper
  # operations — no copy-up — and they are what leaves the session able to
  # write its upper layer at all: worker-owned, group-writable (docs/271, so a
  # Compose service at another uid can create its `node_modules/.vite`-style
  # cache), and setgid so new entries inherit the shared group (docs/272).
  # Everything BELOW a root may be a lower-only entry shared with every session
  # of the repo, and the per-session layer's contents are reconciled
  # orchestrator-side on every container create — the walk here must not touch
  # them. Best-effort for the same reason the mode passes are.
  #
  # A SYMLINKED dep dir is refused whole, never chowned and never moded:
  # `chown -h` would be safe on the link itself, but `chmod` FOLLOWS one and
  # would rewrite whatever it points at, possibly outside the tree — the same
  # reason the mode passes above select `-type d`/`-type f`. This mirrors
  # `reconcileDepDirCacheOwnership`, which refuses a symlinked dep dir too.
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
  # The ONLY thing that makes this function report failure. The chown and the two
  # mode passes stay best-effort — a file another process unlinked mid-walk must
  # not cost the tree its sentinel — but "this image cannot do ACLs at all" is a
  # whole capability the walk did not deliver, and stamping it as done is what
  # would make it permanent.
  [ "$acl_ok" = "1" ]
}

# docs/272 — hand a SHARED mount (/dep-cache) to every session of its repo:
# set the GROUP without touching the owner, make it group-writable, and set
# setgid on its directories so an entry a later session creates inherits the
# shared group instead of that session's own.
#
# Split out of the loop so the two halves can be gated differently, which is the
# fix rather than a tidy-up. The GROUP is what the handoff is FOR — a cache whose
# group did not change is not shared at all — so a failure there returns non-zero
# and the caller RELEASES its claim, and the next boot retries. The MODE passes
# are best-effort, for the same reason `chown_workspace`'s are: this script runs
# under `set -e`, and a shared cache is written CONCURRENTLY by every session of
# the repo — npm's `_cacache/tmp` and `_logs` churn constantly — so a file
# another session unlinked mid-walk must not kill the boot.
#
# Before this split, `chmod -R g+rwX "$d"` was an unguarded simple command: one
# vanished temp file killed the entrypoint, and because the claim had already
# been staked (and `chown -R` had already stamped the marker with the shared
# gid) EVERY later boot skipped the walk. The cache stayed half group-writable
# for good, which is EACCES with no recovery for every session that did not
# write each entry — the shape reported from production on 2026-08-18, where
# `npm` blamed "root-owned files" on a cache that was not root-owned at all.
share_cache_with_all_sessions() {
  d="$1"
  chown -R ":${WORKER_GID}" "$d" || return 1
  chmod -R g+rwX "$d" || true
  find "$d" -type d -exec chmod g+s {} + 2>/dev/null || true
}

# Remove handoff sentinels a completed walk has superseded — an earlier scheme
# version, or an earlier identity. Depth-1 and prefix-exact, so nothing but a
# sentinel is a candidate, and `rmdir` (never `rm -r`) so a name that is somehow
# not an empty directory is left alone. Runs only AFTER the superseding walk
# succeeded, so a tree is never left with no sentinel at all.
#
# POSIX sh has no `local`, so every name here is global. `chown_workspace` and
# `share_cache_with_all_sessions` take the loop variable `d` and assign it back
# to itself, which is harmless; this one takes three arguments and is the most
# likely to be called with something else one day, so it deliberately avoids `d`.
#
# A fourth argument of `worker` removes them AS THE WORKER, for a tree root
# cannot write: no CAP_DAC_OVERRIDE, and a shared cache is not root-owned. Root
# would silently fail every `rmdir` there and the superseded markers would
# accumulate one per deployment.
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
  # Explicit, because this is called from inside an `if` BODY (where `set -e` is
  # live) and a loop's status is its last command's. Bookkeeping must never be
  # able to fail a boot.
  return 0
}

# docs/272 — the sentinel names carry a HANDOFF SCHEME version alongside the
# identity they stamp, because the identity is not the only thing that can
# change.
#
# A sentinel claims a tree ONCE and every later boot skips on it. That is right
# while what the walk DOES is fixed, and silently wrong the moment the walk
# learns to do something new: every tree an earlier image already claimed keeps
# the old treatment for good — and those are the longest-running deployments,
# i.e. exactly the ones with the most to repair. Two passes have already landed
# that way (docs/271's workspace group-write, and the shared-cache mode pass
# above), and neither could reach a tree whose sentinel was already in place.
#
# So: bump this whenever the handoff starts doing more, or differently, than it
# did. The cost is one extra walk per tree per deployment — what the walk costs
# on a cold tree anyway — and the alternative is a repair that reaches only new
# sessions.
#
# v2: the mode passes above (`chmod -R g+rwX` and setgid on directories) now
# reach shared caches claimed under v1.
#
# *That entry read "the mode passes above (`chmod -R g+rwX`, setgid on
# directories, and `chown_workspace`'s group-write pass) now reach trees claimed
# under v1" until 2026-08-28. The workspace half of it was never true, and it is
# corrected rather than deleted because it is half of a contradiction worth
# keeping visible: it promised the bump reached claimed WORKSPACES, while the
# probe's justification below promised the opposite — that a handed-over mount
# skips and that this is correct. Both could not hold. Measured on a live host:
# `/workspace` is `2775 <sessionUid>:1000` with NO sentinel of any version, while
# `/persist` and `/session-state` beside it carry `.shipit-uid-<uid>-<gid>-v2`.
# So the workspace was never claimed by this walk at all — not stale, absent —
# and every bump before v3 reached only the other mounts. docs/271 §3 has the
# full account.*
#
# v3: `chown_workspace`'s default-ACL pass (docs/271 §3), plus the workspace
# branch below that makes a bump reach the workspace for the first time. A
# workspace handed over before v3 has directories with no default ACL, so what a
# foreign-uid Compose service creates in them stays unwritable to the agent and
# to orchestrator git — and those are the long-lived sessions where a plugin
# service has had the most time to leave such directories behind. The cost is one
# extra walk per tree per deployment.
HANDOFF_SCHEME=3

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

  # docs/272 — the SHARED cache is handled BEFORE the writability probe below,
  # and that ordering is the fix rather than a preference.
  #
  # The probe's own comment says `test -w` is right "even though we are still
  # root here", because access(2) reports EROFS regardless of privilege. That is
  # true and it is not the whole rule: root passes W_OK on a directory it does
  # not own only by way of **CAP_DAC_OVERRIDE**, and this container drops it —
  # measured on the production host, the bounding set is CHOWN, FOWNER, KILL,
  # SETGID, SETUID and nothing else. So root's access to a mount is decided by
  # the `other` class like anyone else's.
  #
  # `/dep-cache` is 0755 and owned by the uid that first claimed it — 1000, from
  # before docs/270 made the uid per-session. `other` is `r-x`. So root fails the
  # probe, `continue` fires, and the branch that would repair the cache is never
  # reached. It cannot recover on its own either: the state that locks root out
  # was created by the handoff's OWN first run, so the fault is self-latching and
  # every improvement since — docs/270's group + setgid, docs/271's group write —
  # has been unreachable on every deployment that ever claimed a cache under the
  # old scheme. Observed exactly so in production on 2026-08-18: `/dep-cache`
  # 0755 `1000:1000` throughout, carrying the pre-docs/270 `.shipit-uid-1000`
  # marker and no `.shipit-gid-*` marker at all, on a host where every session
  # runs at its own uid with gid 1000 and therefore cannot write the cache.
  #
  # Skipping the probe for this branch is safe because the branch no longer needs
  # write permission to decide anything: `stat` only reads (the `r-x` root does
  # have), the walk itself needs CAP_CHOWN and CAP_FOWNER rather than write
  # permission, and both are in the bounding set. A genuinely read-only mount
  # simply fails the walk's `chown -R`, which is a logged retry and not a boot
  # failure. See `share_cache_with_all_sessions`.
  case "$d" in
    */dep-cache)
      marker="$d/.shipit-gid-${WORKER_GID}-v${HANDOFF_SCHEME}"
      # Already handed off under THIS scheme and gid → nothing to do. Stat-only,
      # so it works without write permission.
      if [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" = "$WORKER_GID" ]; then
        continue
      fi
      if share_cache_with_all_sessions "$d"; then
        # The sentinel is written AS THE WORKER, and only AFTER the walk. Root
        # cannot create it — no CAP_DAC_OVERRIDE, and the cache is not root-owned
        # — while the uid the walk has just made group-writable can. This is the
        # same reason the `/credentials` prep further down runs through gosu.
        #
        # Writing it after the walk rather than claiming before it does lose the
        # concurrent-boot claim: two sessions booting together may both walk. That
        # is idempotent and costs one duplicated pass on the first boot after this
        # change, which is the price of a sentinel that can only be written once
        # the thing it records has actually happened. A failed walk now simply
        # writes nothing and is retried, which replaces the release-the-claim path
        # this branch used to need.
        gosu "${UID_GID}:${WORKER_GID}" mkdir "$marker" 2>/dev/null || true
        prune_stale_sentinels "$d" ".shipit-gid-" "$marker" worker
      else
        echo "shipit-entrypoint: shared-cache handoff for $d did not complete; it will be retried on the next boot" >&2
      fi
      continue
      ;;
  esac

  # docs/271 §3 — the WORKSPACE is handled before the writability probe below,
  # for exactly the reason the shared cache is, and this is a fix rather than a
  # tidy-up.
  #
  # The probe below rests on "these mounts are created root-owned by the
  # orchestrator and are handed to the session by this very walk". For the
  # workspace that is false, and not merely stale: the orchestrator hands the
  # workspace to the session uid at CLONE time (`handWorkspaceBackToWorker`),
  # before this container has ever booted. So the workspace is already
  # `2775 <sessionUid>:<sharedGid>` on boot #1 — a tree root neither owns nor
  # shares a group with, and CAP_DAC_OVERRIDE is dropped — and `test -w` has
  # failed on EVERY boot this walk has ever run, not merely on the ones after
  # some first success.
  #
  # Measured on a live host: `/workspace` is `2775 <sessionUid>:1000` and holds
  # NO sentinel of any version, while `/persist` and `/session-state` beside it
  # each hold `.shipit-uid-<uid>-<gid>-v2`. Absent, not stale — `mkdir "$marker"`
  # never ran, so the loop `continue`d here. Every live session's workspace
  # ownership came from the orchestrator-side handback; none of it came from this
  # walk, and a HANDOFF_SCHEME bump therefore reached no workspace at all. That
  # is precisely backwards: an existing workspace is the only kind a foreign-uid
  # Compose service has had time to leave `0755` directories in.
  #
  # Handled the same way the shared cache is, and for the same three reasons:
  # `stat` only READS, so the skip works without write permission; the walk needs
  # CAP_CHOWN and CAP_FOWNER rather than write permission, and both are in the
  # bounding set; and the sentinel is written AS THE WORKER, after the walk,
  # because root cannot create a directory in a tree it does not own and the walk
  # has just made that tree writable by the uid that can.
  #
  # Only the workspace, deliberately. The other per-session mounts take the
  # generic `chown -R`, which v3 did not change, so re-reaching them would buy
  # nothing and cost a walk.
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

  # A read-only mount (/uploads) can neither hold the sentinel nor be chowned, so
  # there is nothing to hand off — skip it before the sentinel logic runs. This
  # MUST stay ahead of the ownership check below: that check treats a missing
  # sentinel as "handoff not done" and falls through to `chown -R`, which then
  # fails EROFS and, under `set -e`, kills the entrypoint. The sentinel can never
  # exist on a :ro mount, so every boot would take that path.
  #
  # `test -w` remains the probe for the PER-SESSION mounts below, and the reason
  # it is sound is narrower than the reason first written down. It is not that
  # root passes W_OK on every read-write mount — without CAP_DAC_OVERRIDE it does
  # not (see the shared-cache branch above). It is that THESE mounts are created
  # root-owned by the orchestrator and are handed to the session by this very
  # walk, so on the boot where the walk is owed, root still owns them and passes.
  #
  # That premise is the whole argument, and it is a claim about each specific
  # mount rather than a property of the probe. It holds for `/persist`,
  # `/session-state` and `/credentials` — measured on a live host, each carries
  # its `.shipit-uid-<uid>-<gid>-v<scheme>` sentinel, so the walk did claim them.
  # It never held for `/workspace`, which the orchestrator hands over at CLONE
  # time, before the container has ever booted: that same host's `/workspace` is
  # `2775 <sessionUid>:1000` with no sentinel of any version. So do not extend
  # this reasoning to a mount without checking which of the two it is.
  #
  # *This paragraph ended "Once handed over, a later boot fails the probe and
  # skips — which is the correct outcome there, because the sentinel says the
  # handoff is done" until 2026-08-28. That sentence is the bug written as a
  # guarantee. It is true only while the walk never changes: after a
  # HANDOFF_SCHEME bump the sentinel says the OPPOSITE, and the probe skips
  # without ever reading it — which is why every bump before v3 reached no
  # workspace at all, and why the workspace now has its own stat-gated branch
  # above. Corrected in place rather than deleted, because the premise it rests
  # on is still the reason the probe is safe for the mounts that keep it.*
  #
  # Do NOT reuse this reasoning for a tree ShipIt does not create root-owned.
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
  esac
  marker="$d/.shipit-uid-${UID_GID}-${WORKER_GID}-v${HANDOFF_SCHEME}"
  if mkdir "$marker" 2>/dev/null \
    || [ "$(stat -c '%u' "$marker" 2>/dev/null || true)" != "$UID_GID" ] \
    || [ "$(stat -c '%g' "$marker" 2>/dev/null || true)" != "$WORKER_GID" ]; then
    # The workspace never reaches here — it took its own branch above, which is
    # the only one whose skip survives the tree being handed over.
    chown -R "${UID_GID}:${WORKER_GID}" "$d"
    prune_stale_sentinels "$d" ".shipit-uid-" "$marker"
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

# planning#444 — Grok's config root, the same class of bug as the OpenCode block
# above and the same remedy, reached from the other direction.
#
# OpenCode's target was uncreatable because the path is three deep and no code
# path walked it. Grok's is single-segment, so a `mkdir -p` would have worked
# fine — nothing ever RAN one. Grok is key-billed (docs/274 req 6): the
# credential arrives as XAI_API_KEY, no auth.json is ever written, and
# `copyCredentialPath` returns early on a source that does not exist, so the
# provisioning that materializes `.claude`/`.codex` materializes nothing here.
# The image symlinks ~/.grok at /credentials/.grok unconditionally, so the link
# DANGLES in every session container, and the CLI dies at its own session
# creation with `FS_OTHER / "File exists (os error 17)"` and `duration_ms: 0` —
# before any stream event, which is why it presented as a bare `error` row.
#
# Same gosu requirement, for exactly the reason spelled out above: /credentials
# is sealed 0700 to the session's own uid before the container starts and the
# container drops DAC_OVERRIDE, so the root form could only ever warn.
if ! gosu "${UID_GID}:${WORKER_GID}" mkdir -p /credentials/.grok 2>/dev/null; then
  echo "[shipit] warning: could not prepare /credentials/.grok for UID ${UID_GID}; Grok turns will fail (dangling ~/.grok symlink)" >&2
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
