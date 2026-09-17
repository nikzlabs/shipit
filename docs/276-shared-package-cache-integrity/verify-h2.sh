#!/usr/bin/env bash
#
# verify-h2.sh — does pnpm install poisoned content from a shared store?
#
# Sweeps store-state (copied aside vs poisoned in place) × network ×
# verify-store-integrity × poison-length (same-length vs shorter) × pnpm version.
# Poison length tells a hash check from a size/mtime check; network tells
# "verified and repaired" from "never checked".
#
# EVERY cell is run twice: once poisoned, once clean (the negative control). A
# cell whose clean run also fails proves nothing about the poison and is
# reported as VOID. Without this, ERR_PNPM_NO_OFFLINE_TARBALL reads as "no
# check fired" when it is the check's own eviction.
#
# Self-contained: needs bash, node, npm, and network for the initial store warm.
# Touches only its own scratch dir. Does not read or write the ShipIt repo.
#
# Usage:
#   ./verify-h2.sh [--dir DIR] [--pnpm system|11.22.0,12.4.2] [--pkg NAME@VER]
#                  [--probe RELPATH] [--tsv FILE] [--keep]
#
# Exit: 0 if the sweep completed (regardless of findings), 1 on setup failure.

set -uo pipefail

SCRATCH="${TMPDIR:-/tmp}/verify-h2.$$"
PNPM_VERSIONS="system"
PKG_SPEC="lodash@4.17.21"
PROBE_REL=""          # default derived from package name below
TSV_OUT=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)   SCRATCH="$2"; shift 2 ;;
    --pnpm)  PNPM_VERSIONS="$2"; shift 2 ;;
    --pkg)   PKG_SPEC="$2"; shift 2 ;;
    --probe) PROBE_REL="$2"; shift 2 ;;
    --tsv)   TSV_OUT="$2"; shift 2 ;;
    --keep)  KEEP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

PKG_NAME="${PKG_SPEC%@*}"
PKG_VER="${PKG_SPEC##*@}"
[ -n "$PROBE_REL" ] || PROBE_REL="node_modules/${PKG_NAME}/isEqual.js"

say()  { printf '%s\n' "$*"; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

for t in node npm; do command -v "$t" >/dev/null || fail "missing required tool: $t"; done

say "=== verify-h2.sh ==="
say "host:      $(uname -sr) / $(hostname)"
say "scratch:   $SCRATCH"
say "filesystem: $(stat -f -c %T "$(dirname "$SCRATCH")" 2>/dev/null || echo unknown)"
say "package:   $PKG_SPEC   probe: $PROBE_REL"
say ""

rm -rf "$SCRATCH"; mkdir -p "$SCRATCH" || fail "cannot create $SCRATCH"
TEMPLATE="$SCRATCH/template"
mkdir -p "$TEMPLATE"
cat > "$TEMPLATE/package.json" <<EOF
{ "name": "h2-probe", "version": "1.0.0", "private": true,
  "dependencies": { "$PKG_NAME": "$PKG_VER" } }
EOF

# A pinned pnpm is installed once into its own prefix; `npx -y pnpm@VER` would
# re-resolve on every one of ~50 calls per version.
pnpm_cmd() {
  local ver="$1" prefix bin
  if [ "$ver" = "system" ]; then command -v pnpm >/dev/null || return 1; echo "pnpm"; return 0; fi
  prefix="$SCRATCH/pnpm-$ver"
  bin="$prefix/node_modules/.bin/pnpm"
  if [ ! -x "$bin" ]; then
    mkdir -p "$prefix"
    ( cd "$prefix" && npm install --silent --no-save --no-audit --no-fund "pnpm@$ver" ) \
      >"$prefix/install.log" 2>&1
  fi
  [ -x "$bin" ] || { printf 'could not install pnpm@%s (see %s)\n' "$ver" "$prefix/install.log" >&2; return 1; }
  echo "$bin"
}

# ---------------------------------------------------------------------------
# Per-version setup: build a pristine store, and locate the store entry that
# backs the probe file by inode (a content grep finds a plausible file, not
# the right one).
# ---------------------------------------------------------------------------
setup_version() {
  local PNPM="$1" root="$2"
  rm -rf "$root"; mkdir -p "$root"
  cp "$TEMPLATE/package.json" "$root/package.json"
  ( cd "$root" && $PNPM --store-dir "$root/store-pristine" \
      --config.package-import-method=hardlink install --silent ) >"$root/warm.log" 2>&1
  if [ ! -f "$root/$PROBE_REL" ]; then
    say "  !! warm install failed; see $root/warm.log"; return 1
  fi
  cp "$root/pnpm-lock.yaml" "$TEMPLATE/pnpm-lock.yaml" 2>/dev/null
  local ino entry
  ino=$(stat -c %i "$root/$PROBE_REL")
  entry=$(find "$root/store-pristine" -inum "$ino" 2>/dev/null | head -1)
  [ -n "$entry" ] || { say "  !! probe file shares no inode with the store"; return 1; }
  printf '%s\n' "${entry#"$root/store-pristine/"}" > "$root/ENTRY"
  cp "$entry" "$root/clean.bak"
  rm -rf "$root/node_modules"
  return 0
}

# Build a same-length poison so a size check can be told apart from a hash check.
make_poisons() {
  local root="$1" n
  n=$(stat -c %s "$root/clean.bak")
  printf '/* POISONED-SHORT */\n' > "$root/poison-short"
  node -e '
    const fs=require("fs"), n=Number(process.argv[1]);
    const p="/* POISONED-SAMELEN */";
    fs.writeFileSync(process.argv[2], p.length>=n ? p.slice(0,n) : p+"\n".repeat(n-p.length));
  ' "$n" "$root/poison-samelen"
  [ "$(stat -c %s "$root/poison-samelen")" = "$n" ] || say "  !! same-length poison is not the same length"
}

# ---------------------------------------------------------------------------
# One cell. Returns a classification plus the mechanism signal (was the store
# entry repaired, i.e. did pnpm re-download?).
#   $1 pnpm cmd  $2 root  $3 store-state  $4 network  $5 verify  $6 poison
# ---------------------------------------------------------------------------
trial() {
  local PNPM="$1" root="$2" STATE="$3" NET="$4" VERIFY="$5" POISON="$6"
  local REL proj store rc out verdict repaired
  REL=$(cat "$root/ENTRY")

  proj="$root/run"; rm -rf "$proj"; mkdir -p "$proj"
  cp "$TEMPLATE/package.json" "$proj/package.json"
  [ -f "$TEMPLATE/pnpm-lock.yaml" ] && cp "$TEMPLATE/pnpm-lock.yaml" "$proj/pnpm-lock.yaml"

  case "$STATE" in
    copied)   store="$root/store-copy"; rm -rf "$store"; cp -a "$root/store-pristine" "$store" ;;
    in-place) # "in place" = a store THIS pnpm wrote and has already imported from
              # once, then poisoned without the file ever being moved. Rebuilt
              # for every trial: a store reused across trials lets one cell
              # inherit the previous cell's re-verified entry.
              store="$root/store-live"; rm -rf "$store"
              cp -a "$root/store-pristine" "$store"
              ( cd "$proj" && $PNPM --store-dir "$store" \
                  --config.package-import-method=hardlink install --silent ) >/dev/null 2>&1
              rm -rf "$proj/node_modules"
              cp "$root/clean.bak" "$store/$REL" ;;
  esac

  case "$POISON" in
    none)    : ;;
    short)   cp "$root/poison-short"   "$store/$REL" ;;
    samelen) cp "$root/poison-samelen" "$store/$REL" ;;
  esac

  local -a cfg=( "--store-dir" "$store" "--config.package-import-method=hardlink" )
  [ "$VERIFY" != "unset" ] && cfg+=( "--config.verify-store-integrity=$VERIFY" )
  [ "$NET" = "offline" ] && cfg+=( "--offline" )

  out=$( cd "$proj" && $PNPM "${cfg[@]}" install --silent 2>&1 ); rc=$?

  if [ ! -f "$proj/$PROBE_REL" ]; then
    verdict="FAILED:$(printf '%s' "$out" | grep -oE 'ERR_PNPM_[A-Z_]+' | head -1)"
    verdict="${verdict:-FAILED:rc$rc}"
  elif grep -q 'POISONED' "$proj/$PROBE_REL" 2>/dev/null; then
    verdict="POISONED_INSTALLED"
  else
    verdict="CLEAN_INSTALLED"
  fi

  if grep -q 'POISONED' "$store/$REL" 2>/dev/null; then repaired="store-untouched"
  elif [ "$POISON" = "none" ];                     then repaired="n/a"
  else                                                  repaired="STORE_REPAIRED"; fi

  printf '%s\t%s\n' "$verdict" "$repaired"
  cp "$root/clean.bak" "$store/$REL" 2>/dev/null
  rm -rf "$proj/node_modules"
}

# ---------------------------------------------------------------------------
# Sweep
# ---------------------------------------------------------------------------
[ -n "$TSV_OUT" ] && printf 'pnpm\tstore_state\tnetwork\tverify\tpoison\tverdict\tstore_after\tcontrol\tcell\n' > "$TSV_OUT"

IFS=',' read -r -a VERSIONS <<< "$PNPM_VERSIONS"
for V in "${VERSIONS[@]}"; do
  if ! PNPM=$(pnpm_cmd "$V"); then say "### pnpm $V — unavailable, skipping"; say ""; continue; fi
  root="$SCRATCH/v-$V"
  say "### pnpm $V  ($PNPM)"
  if ! setup_version "$PNPM" "$root"; then say "    setup failed, skipping"; say ""; continue; fi
  say "    version:     $( cd "$root" && $PNPM --version 2>/dev/null | tail -1 )"
  say "    store entry: $(cat "$root/ENTRY")"
  make_poisons "$root"
  say ""
  printf '    %-9s %-8s %-7s %-8s | %-26s %-16s | %s\n' \
         STORE NET VERIFY POISON VERDICT STORE-AFTER CONTROL
  printf '    %s\n' "$(printf '%.0s-' {1..104})"

  for STATE in copied in-place; do
    for NET in online offline; do
      for VERIFY in unset true false; do
        # negative control for this cell: identical run, no poison
        ctl=$(trial "$PNPM" "$root" "$STATE" "$NET" "$VERIFY" none)
        ctl_verdict="${ctl%%$'\t'*}"
        for POISON in samelen short; do
          res=$(trial "$PNPM" "$root" "$STATE" "$NET" "$VERIFY" "$POISON")
          verdict="${res%%$'\t'*}"; after="${res##*$'\t'}"
          if [ "$ctl_verdict" != "CLEAN_INSTALLED" ]; then
            cell="VOID (control also ${ctl_verdict})"
          else
            case "$verdict" in
              POISONED_INSTALLED) cell="HOLE OPEN" ;;
              CLEAN_INSTALLED)    [ "$after" = "STORE_REPAIRED" ] \
                                    && cell="closed by re-download" \
                                    || cell="closed (no refetch: verified)" ;;
              FAILED:*)           cell="fails closed" ;;
              *)                  cell="?" ;;
            esac
          fi
          printf '    %-9s %-8s %-7s %-8s | %-26s %-16s | %s\n' \
                 "$STATE" "$NET" "$VERIFY" "$POISON" "$verdict" "$after" "$cell"
          [ -n "$TSV_OUT" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
             "$V" "$STATE" "$NET" "$VERIFY" "$POISON" "$verdict" "$after" "$ctl_verdict" "$cell" >> "$TSV_OUT"
        done
      done
    done
  done
  say ""
done

say "=== how to read this ==="
say "VOID                     the clean control failed too; the cell says nothing about the poison."
say "HOLE OPEN                poisoned bytes reached node_modules. This is the finding that matters."
say "fails closed             install refused. Safe, but check WHICH ERR_ code — a presence error is not"
say "                         an integrity check, and mistaking the two is how this was first got wrong."
say "closed by re-download    pnpm replaced the entry from the network. Isolation by refetch, not by"
say "                         verification: it will not hold offline."
say "closed (no refetch)      pnpm rejected the bytes without going to the network. A real check."
say ""
say "samelen vs short tells you WHICH check fired: if 'short' is caught and 'samelen' is not,"
say "the check is on size or mtime, not on the content hash."
[ -n "$TSV_OUT" ] && say "TSV written to $TSV_OUT"

if [ "$KEEP" = "1" ]; then say "scratch kept at $SCRATCH"; else rm -rf "$SCRATCH"; fi
