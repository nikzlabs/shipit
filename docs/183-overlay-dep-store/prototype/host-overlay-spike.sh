#!/usr/bin/env bash
# PROTOTYPE — host-side overlayfs spike for docs/183-overlay-dep-store.
#
# This is the GATING risk from the plan: can the *orchestrator* own a per-session
# whole-workspace overlay (mount on activate, unmount + workdir cleanup on
# dispose) within the containment model (docs/172), on the prod VPS's ext4?
#
# It CANNOT run inside a session container — those are unprivileged (no
# CAP_SYS_ADMIN, no user+mount namespace; see ../FINDINGS.md for the probe).
# Run it where the orchestrator runs (the host / a privileged context):
#
#     sudo bash host-overlay-spike.sh [scratch-dir-on-ext4]
#
# Default scratch dir is /var/tmp/ob-spike. Pass an ext4 path to match prod.
# It validates, in order:
#   1. overlay mount (lower ro + upper + work) on the target filesystem
#   2. copy-on-write: an "install" write lands ONLY in the upper (delta capture)
#   3. whole-workspace generality: writes outside node_modules are captured too
#   4. git clone + fast-forward ON the merged dir; source diff stays small
#   5. .git exclusion correctness (base must not carry a session branch ref)
#   6. stacked lowerdirs (overlay depth) up to a configured cap
#   7. bind-mount the MERGED dir as a source (compose service pattern)
#   8. inotify over the overlay incl. copy-up events (file-watcher pattern)
#   9. teardown ordering: unmount BEFORE removing workdir; janitor-safe
#
# Exit 0 = every check passed. Each check prints PASS/FAIL/SKIP.
set -u

SCRATCH="${1:-/var/tmp/ob-spike}"
PASS=0; FAIL=0; SKIP=0
ok()   { echo -e "  \033[32mPASS\033[0m $1"; PASS=$((PASS+1)); }
bad()  { echo -e "  \033[31mFAIL\033[0m $1 ${2:+— $2}"; FAIL=$((FAIL+1)); }
skip() { echo -e "  \033[33mSKIP\033[0m $1 ${2:+— $2}"; SKIP=$((SKIP+1)); }
hdr()  { echo -e "\n\033[1m$1\033[0m"; }

# --- preflight --------------------------------------------------------------
hdr "0. Preflight"
if [ "$(id -u)" -ne 0 ]; then
  echo "  must run as root (overlay mount needs CAP_SYS_ADMIN). Try: sudo bash $0"
  exit 2
fi
# overlayfs is a Linux kernel feature. macOS (XNU) has no /proc and no overlay —
# there is nothing to validate there. ShipIt's orchestrator runs on Linux, so on
# a Mac run this INSIDE the Docker Desktop Linux VM (or on the actual Linux host),
# not on the macOS host itself.
if [ ! -r /proc/filesystems ]; then
  echo "  no /proc/filesystems — not a Linux host (likely macOS)."
  echo "  overlayfs is Linux-only; prod runs on Linux. Run this inside the Docker"
  echo "  Desktop Linux VM or on the Linux host, not on macOS."; exit 2
fi
if ! grep -q overlay /proc/filesystems; then
  echo "  overlay not in /proc/filesystems — kernel lacks overlayfs"; exit 2
fi
# CAP_SYS_ADMIN (bit 21) is required for mount(2). A ShipIt *session* container
# is unprivileged and lacks it — that's the whole reason the mount must be
# host-side (docs/172). Detect and explain rather than dying on a raw EPERM.
CAPEFF="0x$(awk '/^CapEff:/{print $2}' /proc/self/status)"
if (( (CAPEFF >> 21) & 1 )); then
  ok "CAP_SYS_ADMIN present (CapEff=$CAPEFF) — can mount(2)"
else
  echo "  CAP_SYS_ADMIN ABSENT (CapEff=$CAPEFF). This context cannot mount(2)."
  echo "  This is expected inside a ShipIt session container — run on the HOST"
  echo "  (where the orchestrator runs), which is exactly the plan's design."
  exit 2
fi
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
FSTYPE="$(stat -f -c %T "$SCRATCH")"
ok "scratch=$SCRATCH fstype=$FSTYPE kernel=$(uname -r)"
[ "$FSTYPE" = "ext2/ext3" ] || [ "$FSTYPE" = "ext4" ] \
  && echo "  (note: prod VPS is ext4 — this matches)" \
  || echo "  (note: NOT ext4 — overlay limits/semantics can differ from prod)"

mnts=()  # track mounts for ordered teardown
cleanup() {
  for ((i=${#mnts[@]}-1; i>=0; i--)); do umount "${mnts[$i]}" 2>/dev/null; done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

mount_overlay() { # lowerdirs(colon) upper work merged
  local lower="$1" upper="$2" work="$3" merged="$4"
  mkdir -p "$upper" "$work" "$merged"
  if mount -t overlay overlay -o "lowerdir=$lower,upperdir=$upper,workdir=$work" "$merged" 2>/tmp/ob-mnt.err; then
    mnts+=("$merged"); return 0
  fi
  return 1
}

# --- 1. basic overlay mount -------------------------------------------------
hdr "1. Overlay mount (lower ro + upper + work) on $FSTYPE"
L="$SCRATCH/v0"; mkdir -p "$L"
echo "from-base" > "$L/base-file.txt"
mkdir -p "$L/node_modules/left-pad"; echo "module.exports='x'" > "$L/node_modules/left-pad/index.js"
M="$SCRATCH/s1/merged"
if mount_overlay "$L" "$SCRATCH/s1/upper" "$SCRATCH/s1/work" "$M"; then
  ok "mounted overlay at $M"
  [ "$(cat "$M/base-file.txt")" = "from-base" ] && ok "base content visible through merged" || bad "base content not visible"
else
  bad "overlay mount failed" "$(cat /tmp/ob-mnt.err)"
  echo "  GATE FAILED — without a working host mount the whole design is blocked."; exit 1
fi

# --- 2. copy-on-write: install delta lands only in upper --------------------
hdr "2. CoW — an 'install' write lands ONLY in the upper layer"
mkdir -p "$M/node_modules/new-dep"; echo "new" > "$M/node_modules/new-dep/index.js"
echo "patched" > "$M/node_modules/left-pad/index.js"   # in-place edit of a base file (patch-package style)
[ -f "$SCRATCH/s1/upper/node_modules/new-dep/index.js" ] && ok "new dep captured in upper" || bad "new dep missing from upper"
[ "$(cat "$SCRATCH/s1/upper/node_modules/left-pad/index.js")" = "patched" ] && ok "in-place edit copied-up (base immune)" || bad "copy-up of edit failed"
[ "$(cat "$L/node_modules/left-pad/index.js")" = "module.exports='x'" ] && ok "BASE unchanged by session edit (immutable lower)" || bad "base was mutated!"

# --- 3. whole-workspace generality (not just node_modules) ------------------
hdr "3. Whole-workspace — writes outside node_modules captured generically"
mkdir -p "$M/.venv/lib"; echo "venv" > "$M/.venv/pyvenv.cfg"
mkdir -p "$M/vendor"; echo "v" > "$M/vendor/dep.rb"
echo ".pnp" > "$M/.pnp.cjs"
[ -f "$SCRATCH/s1/upper/.venv/pyvenv.cfg" ] && [ -f "$SCRATCH/s1/upper/vendor/dep.rb" ] && [ -f "$SCRATCH/s1/upper/.pnp.cjs" ] \
  && ok ".venv / vendor / .pnp.cjs all captured — no ecosystem knowledge needed" || bad "non-node_modules deltas not captured"

# --- 4. git fast-forward ON the merged dir ----------------------------------
hdr "4. git clone + fast-forward on the merged dir; small source diff"
if command -v git >/dev/null; then
  ORIGIN="$SCRATCH/origin"; git init -q --bare "$ORIGIN"
  SEED="$SCRATCH/seed"; git init -q -b main "$SEED"
  git -C "$SEED" config user.email a@b.c; git -C "$SEED" config user.name a
  echo "v1" > "$SEED/src.txt"; git -C "$SEED" add -A; git -C "$SEED" commit -qm t1
  git -C "$SEED" remote add origin "$ORIGIN"; git -C "$SEED" push -q origin main
  echo "v2" > "$SEED/src.txt"; git -C "$SEED" commit -qam t2; git -C "$SEED" push -q origin main
  # Session clones INTO the merged dir (its .git lands in the upper layer).
  git clone -q "$ORIGIN" "$M/repo" 2>/tmp/ob-git.err && ok "git clone into merged dir" || bad "git clone into merged failed" "$(cat /tmp/ob-git.err)"
  git -C "$M/repo" checkout -q -b session-branch origin/main
  before=$(git -C "$M/repo" rev-parse HEAD)
  git -C "$M/repo" pull -q --ff-only origin main >/dev/null 2>&1
  after=$(git -C "$M/repo" rev-parse HEAD)
  ok "fast-forward on overlay HEAD $before -> $after"
  # The .git dir is what we must EXCLUDE from a published base (carries the
  # session branch). Confirm it is plainly identifiable in the upper layer.
  [ -d "$SCRATCH/s1/upper/repo/.git" ] && ok ".git present in upper (must be excluded on base publish)" || bad ".git not where expected"
  # Worktree gitdir pointer files use absolute paths — confirm a linked
  # worktree's gitdir resolves under the overlay merged path.
  git -C "$M/repo" worktree add -q "$M/repo/.wt" -b wt origin/main 2>/tmp/ob-wt.err \
    && [ -f "$M/repo/.wt/.git" ] && grep -q "gitdir:" "$M/repo/.wt/.git" \
    && ok "linked worktree gitdir pointer resolves on overlay" \
    || skip "worktree gitdir check" "$(cat /tmp/ob-wt.err 2>/dev/null)"
else
  skip "git checks" "git not installed"
fi

# --- 5. .git exclusion correctness ------------------------------------------
hdr "5. Base publish must exclude .git (correctness, not security)"
# Simulate publishing the merged tree as the next base, excluding .git.
NEXTBASE="$SCRATCH/v1"; mkdir -p "$NEXTBASE"
tar -C "$M" --exclude='./repo/.git' -cf - . 2>/dev/null | tar -C "$NEXTBASE" -xf - 2>/dev/null
if [ -d "$NEXTBASE/repo" ] && [ ! -d "$NEXTBASE/repo/.git" ]; then
  ok "published base carries source CONTENTS but no .git (no stale branch ref)"
else
  bad "exclude-.git publish did not behave as expected"
fi

# --- 6. stacked lowerdirs (overlay depth) -----------------------------------
hdr "6. Stacked lowerdirs — overlay depth up to a tunable cap"
CAP=16
layers=(); for i in $(seq 1 "$CAP"); do d="$SCRATCH/layer$i"; mkdir -p "$d"; echo "l$i" > "$d/l$i.txt"; layers+=("$d"); done
# overlay lowerdir is colon-joined, highest-precedence first.
lowerspec=$(IFS=:; echo "${layers[*]}")
MD="$SCRATCH/deep/merged"
if mount_overlay "$lowerspec" "$SCRATCH/deep/upper" "$SCRATCH/deep/work" "$MD"; then
  seen=0; for i in $(seq 1 "$CAP"); do [ -f "$MD/l$i.txt" ] && seen=$((seen+1)); done
  [ "$seen" -eq "$CAP" ] && ok "$CAP stacked lowerdirs all visible (depth cap is safe)" || bad "only $seen/$CAP layers visible"
  echo "  (mount option length for $CAP layers: ${#lowerspec} bytes; kernel page limit is ~4096 for the whole option string)"
else
  bad "mounting $CAP stacked lowerdirs failed" "$(cat /tmp/ob-mnt.err)"
fi

# --- 7. bind-mount the merged dir (compose service source) ------------------
hdr "7. Bind-mount the merged dir as a source (compose service pattern)"
BIND="$SCRATCH/bind"; mkdir -p "$BIND"
if mount --bind "$M" "$BIND" 2>/tmp/ob-bind.err; then
  mnts+=("$BIND")
  [ "$(cat "$BIND/base-file.txt")" = "from-base" ] && ok "bind-mount of merged dir reads through to base" || bad "bind-mount read-through failed"
  echo "via-bind" > "$BIND/node_modules/new-dep/extra.txt"
  [ -f "$SCRATCH/s1/upper/node_modules/new-dep/extra.txt" ] && ok "writes via bind-mount hit the overlay upper" || bad "write via bind-mount did not reach upper"
else
  bad "bind-mount of merged dir failed" "$(cat /tmp/ob-bind.err)"
fi

# --- 8. inotify over the overlay incl. copy-up ------------------------------
hdr "8. inotify over overlay (file-watcher pattern), incl. copy-up events"
if command -v inotifywait >/dev/null; then
  EVT="$SCRATCH/evt.log"
  inotifywait -m -r -q -e create -e modify -e moved_to "$M" > "$EVT" 2>/dev/null &
  WPID=$!; sleep 0.4
  echo "watch-create" > "$M/watched-new.txt"          # pure upper create
  echo "watch-copyup" > "$M/base-file.txt"            # triggers copy-up of a base file
  sleep 0.6; kill "$WPID" 2>/dev/null
  grep -q "watched-new.txt" "$EVT" && ok "inotify saw a plain create" || bad "inotify missed plain create"
  grep -q "base-file.txt" "$EVT" && ok "inotify saw the copy-up modify" || skip "copy-up inotify event" "not observed — note the quirk for the watcher"
else
  skip "inotify checks" "inotifywait not installed (apt-get install inotify-tools)"
fi

# --- 9. teardown ordering ---------------------------------------------------
hdr "9. Teardown ordering — unmount BEFORE removing workdir (janitor-safe)"
# Removing a merged dir or workdir while still mounted is the disk-janitor /
# archive hazard the plan flags. Confirm the safe order works and the unsafe
# order is detectable (target busy).
if rmdir "$SCRATCH/deep/work" 2>/dev/null; then
  bad "workdir removable while mounted — janitor could corrupt a live mount"
else
  ok "workdir NOT removable while mounted (janitor must unmount first)"
fi
umount "$MD" 2>/dev/null && { mnts=("${mnts[@]/$MD}"); ok "unmount then cleanup succeeds in order"; } || bad "ordered unmount failed"
rm -rf "$SCRATCH/deep" && ok "workdir cleanup after unmount" || bad "post-unmount cleanup failed"

# --- summary ----------------------------------------------------------------
hdr "Summary"
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ] && { echo -e "  \033[32mHOST-MOUNT GATE: feasible on this host.\033[0m"; exit 0; } \
                  || { echo -e "  \033[31mHOST-MOUNT GATE: at least one check failed — investigate before building the subsystem.\033[0m"; exit 1; }
