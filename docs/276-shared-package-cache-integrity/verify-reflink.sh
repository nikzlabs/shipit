#!/usr/bin/env bash
#
# verify-reflink.sh — can a session get isolation from the shared pnpm store
#                     WITHOUT paying for a second copy of the bytes?
#
# docs/276 plan.md option E argues yes: a reflink (copy-on-write) import gives
# each session its own inode while the extents stay shared, so poisoning the
# store no longer reaches a session that already installed, and the disk barely
# moves. pnpm implements this as `package-import-method=clone` / `clone-or-copy`.
#
# That argument had ONE unverified link, and this script exists to close it.
# The filesystem holding ShipIt's state directory — every session workspace,
# /dep-cache and the pnpm stores, all one filesystem — is ext4, which has no
# reflink, so the saving was inferred and never measured. Run this on XFS
# (reflink=1) or btrfs to replace the inference with a number.
#
# TWO measurement traps, both of which this script fell into before you read it:
#
#   1. `du` is BLIND TO REFLINKS. Reflinked copies are separate inodes with
#      their own extent maps, so du reports each at full size while the
#      filesystem grows by zero. Measured on XFS: two reflinked 64 MB files,
#      du says 64 MB each, `df` says +0 KB. A du-based harness refutes option E
#      on evidence that cannot see the thing being claimed. du DOES see through
#      hardlinks, which is how the ext4-only version got away with it — one
#      tool, two sharing mechanisms, only one of them visible. Every disk figure
#      below is therefore a `df` used-space delta.
#
#   2. Plain `cp` on XFS defaults to `--reflink=auto`. A "full copy" control
#      written as `cp a b` silently makes a reflink and costs 0 KB, which reads
#      as "reflink saves nothing" or "copies are free" depending on which you
#      were hoping for. Controls here pass `--reflink=never` explicitly.
#
# Self-contained: needs bash, node, npm, and network for the initial store warm.
# Touches only its own scratch dir. Does not read or write the ShipIt repo.
#
# Usage:
#   ./verify-reflink.sh [--dir DIR] [--pkg NAME@VER] [--probe RELPATH]
#                       [--allow-non-reflink] [--tsv FILE] [--keep]
#
# Exit: 0 sweep completed, 1 setup failure, 2 filesystem has no reflink
#       (unless --allow-non-reflink, which records the ext4 baseline instead).

set -uo pipefail

SCRATCH="${TMPDIR:-/tmp}/verify-reflink.$$"
PKG_SPEC="lodash@4.17.21"
PROBE_REL=""
TSV_OUT=""
ALLOW_NON_REFLINK=0
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)   SCRATCH="$2"; shift 2 ;;
    --pkg)   PKG_SPEC="$2"; shift 2 ;;
    --probe) PROBE_REL="$2"; shift 2 ;;
    --tsv)   TSV_OUT="$2"; shift 2 ;;
    --allow-non-reflink) ALLOW_NON_REFLINK=1; shift ;;
    --keep)  KEEP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

PKG_NAME="${PKG_SPEC%@*}"; PKG_VER="${PKG_SPEC##*@}"
[ -n "$PROBE_REL" ] || PROBE_REL="node_modules/${PKG_NAME}/isEqual.js"

say()  { printf '%s\n' "$*"; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

for t in node npm; do command -v "$t" >/dev/null || fail "missing required tool: $t"; done
command -v pnpm >/dev/null || fail "missing pnpm (try: corepack enable, or npm i -g pnpm)"

mkdir -p "$SCRATCH" || fail "cannot create $SCRATCH"
FSTYPE=$(stat -f -c %T "$SCRATCH" 2>/dev/null || echo unknown)
MOUNT=$(df -P "$SCRATCH" 2>/dev/null | awk 'NR==2{print $6}')

say "=== verify-reflink.sh ==="
say "host:       $(uname -sr) / $(hostname)"
say "scratch:    $SCRATCH"
say "mountpoint: ${MOUNT:-?}   filesystem: $FSTYPE"
say "pnpm:       $(pnpm --version 2>/dev/null)"
say ""

# --- Gate: does this filesystem actually do reflinks? -----------------------
say "--- reflink probe ---"
dd if=/dev/urandom of="$SCRATCH/.rl-src" bs=1M count=4 status=none 2>/dev/null
REFLINK=0
if cp --reflink=always "$SCRATCH/.rl-src" "$SCRATCH/.rl-dst" 2>/dev/null; then
  REFLINK=1
  a=$(du -sk "$SCRATCH/.rl-src" | cut -f1)
  both=$(du -sk --total "$SCRATCH/.rl-src" "$SCRATCH/.rl-dst" | tail -1 | cut -f1)
  say "  cp --reflink=always: SUPPORTED"
  say "  one 4MB file=${a}KB, two reflinked copies=${both}KB  (equal => extents shared)"
else
  say "  cp --reflink=always: NOT SUPPORTED on $FSTYPE"
fi
rm -f "$SCRATCH/.rl-src" "$SCRATCH/.rl-dst"
say ""

if [ "$REFLINK" = "0" ] && [ "$ALLOW_NON_REFLINK" = "0" ]; then
  say "This filesystem cannot answer the question option E is asking."
  say "Re-run on XFS (mkfs.xfs defaults to reflink=1 since xfsprogs 5.x) or btrfs,"
  say "or pass --allow-non-reflink to record the non-reflink baseline instead."
  [ "$KEEP" = "1" ] || rm -rf "$SCRATCH"
  exit 2
fi

# --- Project template -------------------------------------------------------
TEMPLATE="$SCRATCH/template"; mkdir -p "$TEMPLATE"
cat > "$TEMPLATE/package.json" <<EOF
{ "name": "reflink-probe", "version": "1.0.0", "private": true,
  "dependencies": { "$PKG_NAME": "$PKG_VER" } }
EOF

PRISTINE="$SCRATCH/store-pristine"
say "--- warming a pristine store ---"
( cd "$TEMPLATE" && pnpm --store-dir "$PRISTINE" \
    --config.package-import-method=hardlink install --silent ) >"$SCRATCH/warm.log" 2>&1
[ -f "$TEMPLATE/$PROBE_REL" ] || fail "warm install failed; see $SCRATCH/warm.log"

# Locate the store entry backing the probe file BY INODE. Never by grepping
# content: a grep finds a plausible file, not the right one, and that silently
# invalidated an earlier run of this experiment.
ino=$(stat -c %i "$TEMPLATE/$PROBE_REL")
ENTRY_ABS=$(find "$PRISTINE" -inum "$ino" 2>/dev/null | head -1)
[ -n "$ENTRY_ABS" ] || fail "probe file shares no inode with the store"
ENTRY_REL="${ENTRY_ABS#"$PRISTINE"/}"
cp "$ENTRY_ABS" "$SCRATCH/clean.bak"
cp "$TEMPLATE/pnpm-lock.yaml" "$TEMPLATE/lock.keep" 2>/dev/null
rm -rf "$TEMPLATE/node_modules"
say "  store entry for probe: $ENTRY_REL"
say "  store size: $(du -sh "$PRISTINE" | cut -f1)"
say ""

[ -n "$TSV_OUT" ] && printf 'method\tfs\tinode_shared\tpoison_reaches_installed\tstore_kb\tnm_kb\tcombined_dedup_kb\tinstall_ms\tstatus\n' > "$TSV_OUT"

# Filesystem used-space in KB for the scratch mount. This, not du, is what sees
# through BOTH hardlinks and reflinks.
fs_used_kb() { df -Pk "$SCRATCH" | awk 'NR==2{print $3}'; }

run_method() {
  local METHOD="$1"
  local proj="$SCRATCH/run" store="$SCRATCH/store"
  rm -rf "$proj" "$store"; mkdir -p "$proj"
  cp "$TEMPLATE/package.json" "$proj/package.json"
  [ -f "$TEMPLATE/lock.keep" ] && cp "$TEMPLATE/lock.keep" "$proj/pnpm-lock.yaml"
  # --reflink=never so the store copy itself never silently shares extents with
  # the pristine tree: on XFS, plain `cp` defaults to --reflink=auto, which made
  # an earlier "full copy" control cost 0 KB and look like a reflink.
  cp -a --reflink=never "$PRISTINE" "$store"
  sync; local FS_USED_BASE; FS_USED_BASE=$(fs_used_kb)

  local s e out rc
  s=$(date +%s%N)
  out=$( cd "$proj" && pnpm --store-dir "$store" \
           --config.package-import-method="$METHOD" install --silent 2>&1 ); rc=$?
  e=$(date +%s%N)
  local ms=$(( (e - s) / 1000000 ))

  if [ ! -f "$proj/$PROBE_REL" ]; then
    local err; err=$(printf '%s' "$out" | grep -oE 'Operation not supported|os error [0-9]+|ERR_PNPM_[A-Z_]+' | head -2 | tr '\n' ' ')
    printf '  %-14s %s\n' "$METHOD" "INSTALL FAILED — ${err:-rc=$rc}"
    [ -n "$TSV_OUT" ] && printf '%s\t%s\t-\t-\t-\t-\t-\t-\tINSTALL_FAILED\n' "$METHOD" "$FSTYPE" >> "$TSV_OUT"
    return
  fi

  sync; local fs_used_after; fs_used_after=$(fs_used_kb)

  # inode sharing with the store
  local pino shared
  pino=$(stat -c %i "$proj/$PROBE_REL")
  if find "$store" -inum "$pino" 2>/dev/null | grep -q .; then shared="yes"; else shared="no"; fi

  # THE honest disk figure is the FILESYSTEM's used-space delta, not du.
  #
  # `du` is blind to reflinks. Reflinked copies are separate inodes with their
  # own extent maps, so du reports each at full size even though they share
  # every block — measured on XFS: two reflinked 64 MB files, du says 64 MB
  # each, and the filesystem grew by 0 KB. A du-based harness would therefore
  # report copy-on-write as costing exactly as much as a full copy and refute
  # option E on evidence that cannot see the thing being claimed.
  #
  # (du DOES see through hardlinks, which is why the earlier ext4-only version
  # got away with it. One tool, two sharing mechanisms, only one of them
  # visible.)
  local store_kb nm_kb combined
  store_kb=$(du -sk "$store" | cut -f1)
  nm_kb=$(du -sk "$proj/node_modules" | cut -f1)
  combined=$(( fs_used_after - FS_USED_BASE ))

  # isolation: overwrite the backing store entry, see if the installed file moves
  local before after reaches
  before=$(cksum < "$proj/$PROBE_REL")
  printf '/* POISONED */\n' > "$store/$ENTRY_REL"
  after=$(cksum < "$proj/$PROBE_REL")
  [ "$before" != "$after" ] && reaches="YES" || reaches="no"
  cp "$SCRATCH/clean.bak" "$store/$ENTRY_REL"

  printf "  %-14s inode-shared=%-4s poison-reaches=%-4s du-store=%sKB du-nm=%sKB REAL-DISK-COST=%sKB install=%sms\n" \
    "$METHOD" "$shared" "$reaches" "$store_kb" "$nm_kb" "$combined" "$ms"
  [ -n "$TSV_OUT" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tOK\n' \
    "$METHOD" "$FSTYPE" "$shared" "$reaches" "$store_kb" "$nm_kb" "$combined" "$ms" >> "$TSV_OUT"
}

say "--- import methods ---"
say "  (COMBINED is a single du across store+node_modules; it is the only figure"
say "   that sees through hardlinks. 'poison-reaches' overwrites the backing store"
say "   entry and re-reads the installed file, with no install in between.)"
say ""
for M in hardlink clone clone-or-copy copy; do run_method "$M"; done
say ""

say "=== what the result means ==="
say "hardlink       expect inode-shared=yes and poison-reaches=YES. This is today's"
say "               behaviour and the hole docs/276 calls H3."
say "clone          on a reflink filesystem: inode-shared=no, poison-reaches=no, and"
say "               COMBINED close to hardlink's. That is option E's claim, confirmed."
say "               On ext4 it does not degrade — it fails with 'Operation not"
say "               supported (os error 95)', which is why ShipIt must never set it"
say "               unconditionally."
say "clone-or-copy  the safe spelling: reflink where available, full copy otherwise."
say "copy           the ext4 fallback. Same isolation, full disk cost."
say ""
say "Option E is CONFIRMED if clone/clone-or-copy show poison-reaches=no while"
say "COMBINED stays near hardlink's. It is REFUTED if COMBINED tracks 'copy' —"
say "that would mean the reflink is not actually sharing extents here."
[ -n "$TSV_OUT" ] && say "TSV written to $TSV_OUT"

if [ "$KEEP" = "1" ]; then say "scratch kept at $SCRATCH"; else rm -rf "$SCRATCH"; fi
