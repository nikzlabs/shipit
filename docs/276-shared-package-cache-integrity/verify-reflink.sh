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
# That argument has ONE unverified link, and this script exists to close it.
# ShipIt's data disk is ext4, which has no reflink, so the saving was inferred
# from the mechanism and never measured. Run this on a host with XFS
# (reflink=1) or btrfs to replace the inference with a number.
#
# The measurement trap, stated because the first attempt fell into it:
# `du` over node_modules ALONE cannot see hardlink sharing — it happily counts
# blocks that the store already owns. The only honest figure is a SINGLE `du`
# run spanning the store and node_modules together, which dedups by inode.
# Every total below is measured that way.
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

run_method() {
  local METHOD="$1"
  local proj="$SCRATCH/run" store="$SCRATCH/store"
  rm -rf "$proj" "$store"; mkdir -p "$proj"
  cp "$TEMPLATE/package.json" "$proj/package.json"
  [ -f "$TEMPLATE/lock.keep" ] && cp "$TEMPLATE/lock.keep" "$proj/pnpm-lock.yaml"
  cp -a "$PRISTINE" "$store"

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

  # inode sharing with the store
  local pino shared
  pino=$(stat -c %i "$proj/$PROBE_REL")
  if find "$store" -inum "$pino" 2>/dev/null | grep -q .; then shared="yes"; else shared="no"; fi

  # THE honest disk figure: one du run across both trees, which dedups by inode.
  local store_kb nm_kb combined
  store_kb=$(du -sk "$store" | cut -f1)
  nm_kb=$(du -sk "$proj/node_modules" | cut -f1)
  combined=$(du -sk --total "$store" "$proj/node_modules" 2>/dev/null | tail -1 | cut -f1)

  # isolation: overwrite the backing store entry, see if the installed file moves
  local before after reaches
  before=$(cksum < "$proj/$PROBE_REL")
  printf '/* POISONED */\n' > "$store/$ENTRY_REL"
  after=$(cksum < "$proj/$PROBE_REL")
  [ "$before" != "$after" ] && reaches="YES" || reaches="no"
  cp "$SCRATCH/clean.bak" "$store/$ENTRY_REL"

  printf '  %-14s inode-shared=%-4s poison-reaches=%-4s store=%sKB nm=%sKB COMBINED=%sKB install=%sms\n' \
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
