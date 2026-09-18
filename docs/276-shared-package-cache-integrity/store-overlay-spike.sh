#!/usr/bin/env bash
#
# store-overlay-spike.sh — does putting the pnpm store inside a Docker overlay,
#   over a shared read-only base, isolate a store-index attack between sessions,
#   and at what disk/time cost?
#
# This is the Docker-mounted measurement plan.md section 5 and the checklist
# leave open. It CANNOT run in a session container (no Docker socket); run it on
# a host with the Docker daemon (the "services" host). It needs only Docker; the
# node and python toolchains come from images. Every host-filesystem access is
# routed through a container, because the store files are written as root inside
# the containers and the invoking user cannot read them under the volume path.
#
# Model of production (docs/276 plan.md section 5):
#   - The verified base = a warmed pnpm store, used as the overlay LOWERDIR.
#   - Each session mounts base + its own UPPER/WORK, so every store write
#     (index.db manifest or a content blob) copies up into that session's upper
#     by the kernel copy-up contract, and the base stays immutable.
#
# What it proves / measures:
#   A. Attack isolation. Attacker session A runs H4 (index.db manifest rewrite)
#      and H2 (mtime-preserved byte poison) against the store. Victim session B,
#      same base + its own upper, installs the package offline with
#      verify-store-integrity=true and must get CLEAN bytes. A shared-bind
#      control (no overlay) must get POISONED — attack real, overlay the fix.
#   B. Disk (req 7, req 10). Copy-up in A's upper after the attack; B's upper
#      after a base-hit install and a new-package install; index.db fraction.
#   C. Time (req 7). Base-hit overlay install vs a plain install.
#   D. Store lock. Two concurrent installs over one base into two uppers.
#
# Usage: ./store-overlay-spike.sh
set -uo pipefail

# One image with pnpm (baked, so containers don't re-download it and pollute
# stdout) plus python3 (sqlite3 is in its stdlib) for the store attacks.
IMG="pnpm-spike:local"
build_img(){ docker image inspect "$IMG" >/dev/null 2>&1 && return
  docker build -q -t "$IMG" - >/dev/null <<'DOCKER'
FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
DOCKER
}
NODE_IMG="$IMG"
PY_IMG="$IMG"
CE="-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
PKG_SPEC="is-odd@3.0.1"
NEW_SPEC="left-pad@1.3.0"
PKG_NAME="${PKG_SPEC%@*}"; PKG_VER="${PKG_SPEC#*@}"
PROBE_REL="node_modules/.pnpm/$PKG_NAME@$PKG_VER/node_modules/$PKG_NAME/index.js"
SCALE_PKGS='"express":"4.21.2","lodash":"4.17.21","react":"18.3.1","chalk":"5.3.0","typescript":"5.6.3","vite":"5.4.11","zod":"3.23.8","axios":"1.7.9"'

ok(){ echo -e "    \033[32m$1\033[0m"; }
bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }
hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ bad "$1"; FAIL=$((FAIL+1)); }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }

VOL="pv-store"
ALL_OVL="pv-ovlA pv-ovlB pv-ovlN pv-ovlT pv-ovlP pv-ovlQ"
cleanup(){ docker volume rm $ALL_OVL >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker volume create "$VOL" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"

# every host-fs op runs as root in a container that mounts the work root at /mp
mp(){ docker run --rm -v "$MP":/mp "$NODE_IMG" bash -c "$1"; }

hdr "0. Environment"
build_img
echo "    docker $(docker version -f '{{.Server.Version}}')  driver $(docker info -f '{{.Driver}}')  host $(docker info -f '{{.OperatingSystem}}')"
echo "    image $IMG  pnpm $(docker run --rm $IMG pnpm --version)"
echo "    work root (ext4): $MP"

# pnpm keeps resolution metadata in XDG_CACHE_HOME/pnpm, separate from the
# store; a fresh container has none, so offline resolution fails unless that
# cache is shared. We share it on the volume at /mp/cache. (Finding recorded in
# FINDINGS.md: offline install cross-session needs the metadata cache OR a
# committed lockfile, not the store alone.) Installs also mount /mp for it.
XDG="-e XDG_CACHE_HOME=/mp/cache"
warm_base(){ docker run --rm $CE $XDG -v "$MP":/mp "$NODE_IMG" bash -c "
  set -e; mkdir -p /tmp/pw && cd /tmp/pw
  printf '{\"name\":\"w\",\"version\":\"1.0.0\",\"dependencies\":{$1}}' > package.json
  pnpm --store-dir /mp/$2 install --silent >/mp/$2.warm.log 2>&1"; }

hdr "1. Warm the verified base store (lowerdir)"
warm_base "\"$PKG_NAME\":\"$PKG_VER\"" "base-store" && pass "base store warmed with $PKG_SPEC" \
  || { fail "warm failed"; mp 'tail -5 /mp/base-store.warm.log'; exit 1; }
# Map the probe file to its store blob by CONTENT hash (== the blob's name);
# installs copy cross-fs here so inode identity does not hold, but content does.
read PROBE_HASH PROBE_SIZE < <(docker run --rm $CE $XDG -v "$MP":/mp "$NODE_IMG" bash -c "
  set -e; mkdir -p /tmp/pj && cd /tmp/pj
  printf '{\"name\":\"j\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /mp/base-store --offline install --silent >/tmp/pj.log 2>&1
  P=/tmp/pj/$PROBE_REL; h=\$(sha512sum \"\$P\" | cut -d' ' -f1)
  test -f /mp/base-store/v11/files/\${h:0:2}/\${h:2} && echo \"\$h \$(stat -c %s \"\$P\")\"" | tail -1)
BASE_STORE_SZ=$(mp 'du -sb /mp/base-store' | cut -f1)
BASE_IDX_SZ=$(mp 'stat -c %s "$(find /mp/base-store -name index.db)"')
BASE_IDX_SUM=$(mp 'sha256sum "$(find /mp/base-store -name index.db)"' | cut -d' ' -f1)
echo "    probe hash ${PROBE_HASH:0:16}…  size ${PROBE_SIZE:-?}B"
echo "    base store ${BASE_STORE_SZ}B  index.db ${BASE_IDX_SZ}B  sum ${BASE_IDX_SUM:0:12}…"
[ -n "$PROBE_HASH" ] && pass "probe file located by inode in the base store" || { fail "probe hash empty"; exit 1; }

cat > /tmp/attack.py <<'PY'
import sys, os, hashlib, sqlite3
mode, oldhash, osize = sys.argv[1], sys.argv[2], int(sys.argv[3])
store="/store"; idx=None
for r,_,fs in os.walk(store):
    if "index.db" in fs: idx=os.path.join(r,"index.db")
blobdir=os.path.join(os.path.dirname(idx),"files")
oldpath=os.path.join(blobdir, oldhash[:2], oldhash[2:])
if mode=="h4":
    payload=b"module.exports=function(){require('fs').writeFileSync('/store/PWNED','1');return true};//"
    poison=(payload+b"x"*max(0,osize-len(payload)))[:osize] if osize>=len(payload) else payload
    newhash=hashlib.sha512(poison).hexdigest()
    dest=os.path.join(blobdir,newhash[:2],newhash[2:]); os.makedirs(os.path.dirname(dest),exist_ok=True); open(dest,"wb").write(poison)
    con=sqlite3.connect(idx); cur=con.cursor(); hit=0
    for key,data in cur.execute("select key,data from package_index").fetchall():
        if oldhash.encode() in data:
            nd=data.replace(oldhash.encode(),newhash.encode()); assert len(nd)==len(data)
            cur.execute("update package_index set data=? where key=?",(nd,key)); hit+=1
    con.commit(); con.close(); print("h4 rows rewritten:",hit)
elif mode=="h2":
    st=os.stat(oldpath); poison=(b"POISON"+b"x"*max(0,osize-6))[:osize]
    open(oldpath,"wb").write(poison); os.utime(oldpath,(st.st_atime,st.st_mtime)); print("h2 bytes poisoned, mtime kept")
PY
docker run --rm -v "$MP":/mp -v /tmp/attack.py:/attack.py "$PY_IMG" cp /attack.py /mp/attack.py

attack(){ docker run --rm -v "$1":/store -v "$MP/attack.py":/attack.py "$PY_IMG" bash -c "python3 /attack.py $2 $PROBE_HASH $PROBE_SIZE"; }
victim_install(){
  local out rc
  out=$(docker run --rm $CE $XDG -v "$MP":/mp -v "$1":/store "$NODE_IMG" bash -c "
    mkdir -p /tmp/v && cd /tmp/v
    printf '{\"name\":\"v\",\"dependencies\":{\"${2%@*}\":\"${2#*@}\"}}' > package.json
    pnpm --store-dir /store --offline --config.verify-store-integrity=true install --silent >/tmp/i.log 2>&1; echo RC=\$?
    if   grep -q PWNED /tmp/v/$PROBE_REL 2>/dev/null; then echo B=poison
    elif grep -q POISON /tmp/v/$PROBE_REL 2>/dev/null; then echo B=poison
    elif head -c 20 /tmp/v/$PROBE_REL >/dev/null 2>&1; then echo B=clean
    else echo B=absent; fi" 2>&1)
  rc=$(echo "$out" | sed -n 's/^RC=//p' | head -1)
  echo "rc=${rc:-?} bytes=$(echo "$out" | sed -n 's/^B=//p' | head -1)"
}
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true; docker volume create "$1" --driver local --opt type=overlay --opt device=overlay --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }

hdr "2. Overlay isolation — attack through A's upper, install through B's upper"
mp 'mkdir -p /mp/A-up /mp/A-wk /mp/B-up /mp/B-wk'
make_ovl pv-ovlA "$MP/base-store" "$MP/A-up" "$MP/A-wk"
make_ovl pv-ovlB "$MP/base-store" "$MP/B-up" "$MP/B-wk"
echo "    H4 via A: $(attack pv-ovlA h4)"
echo "    H2 via A: $(attack pv-ovlA h2)"
NOW_IDX_SUM=$(mp 'sha256sum "$(find /mp/base-store -name index.db)"' | cut -d' ' -f1)
[ "$NOW_IDX_SUM" = "$BASE_IDX_SUM" ] && pass "base index.db BYTE-UNCHANGED after both attacks (copy-up hit A's upper)" \
  || fail "base index.db changed ($NOW_IDX_SUM) — copy-up did NOT protect the base"
[ -n "$(mp 'find /mp/A-up -name index.db')" ] && pass "A's index.db write landed in A's private upper" || warn "no index.db in A's upper"
res=$(victim_install pv-ovlB "$PKG_SPEC"); echo "    victim B ($res)"
echo "$res" | grep -q "bytes=clean" && pass "victim B installed CLEAN over the shared base (overlay isolated A's attack)" \
  || fail "victim B did not get clean bytes: $res"

hdr "3. Shared-bind control — same attack, NO overlay, must poison B"
warm_base "\"$PKG_NAME\":\"$PKG_VER\"" "bind-store" >/dev/null 2>&1
echo "    H4 via bind: $(attack "$MP/bind-store" h4)"
resb=$(victim_install "$MP/bind-store" "$PKG_SPEC"); echo "    victim B on shared bind ($resb)"
echo "$resb" | grep -q "bytes=poison" && pass "shared bind: B got POISON — attack real; overlay is the mitigation" \
  || warn "shared-bind control did not poison ($resb) — re-check"

hdr "4. Disk — copy-up cost (req 7, req 10)"
A_UP_SZ=$(mp 'du -sb /mp/A-up' | cut -f1)
B_UP_SZ=$(mp 'du -sb /mp/B-up' | cut -f1)
mp 'mkdir -p /mp/N-up /mp/N-wk'; make_ovl pv-ovlN "$MP/base-store" "$MP/N-up" "$MP/N-wk"
docker run --rm $CE $XDG -v "$MP":/mp -v pv-ovlN:/store "$NODE_IMG" bash -c "
  mkdir -p /tmp/n && cd /tmp/n; printf '{\"name\":\"n\",\"dependencies\":{\"${NEW_SPEC%@*}\":\"${NEW_SPEC#*@}\"}}' > package.json
  pnpm --store-dir /store install --silent >/dev/null 2>&1" || true
N_UP_SZ=$(mp 'du -sb /mp/N-up' | cut -f1)
pct=$(awk "BEGIN{printf \"%.1f\", $BASE_IDX_SZ*100/$BASE_STORE_SZ}")
printf "    %-42s %s\n" "base store total" "${BASE_STORE_SZ} B"
printf "    %-42s %s (%s%% of store)\n" "index.db" "${BASE_IDX_SZ} B" "$pct"
printf "    %-42s %s\n" "A upper after H4+H2 attack" "${A_UP_SZ} B"
printf "    %-42s %s\n" "B upper after base-hit install" "${B_UP_SZ} B"
printf "    %-42s %s\n" "fresh upper after NEW-package install" "${N_UP_SZ} B"

hdr "4b. index.db fraction at a larger scale"
# pnpm exits non-zero only for a real error; an "ignored build scripts" notice
# still populates the store. Gate on the store existing, not the exit code.
warm_base "$SCALE_PKGS" "scale-store" >/dev/null 2>&1 || true
if [ -n "$(mp 'find /mp/scale-store -name index.db 2>/dev/null')" ]; then
  S_SZ=$(mp 'du -sb /mp/scale-store' | cut -f1)
  S_IDX_SZ=$(mp 'stat -c %s "$(find /mp/scale-store -name index.db)"')
  S_N=$(mp 'find /mp/scale-store -path "*/files/*" -type f | wc -l')
  spct=$(awk "BEGIN{printf \"%.1f\", $S_IDX_SZ*100/$S_SZ}")
  printf "    %-42s %s files, %s B store, index.db %s B (%s%%)\n" "scale set (8 top-level deps)" "$S_N" "$S_SZ" "$S_IDX_SZ" "$spct"
else warn "scale warm produced no store:"; mp 'tail -4 /mp/scale-store.warm.log 2>/dev/null'; fi

hdr "5. Time — base-hit overlay install vs plain install (req 7)"
mp 'mkdir -p /mp/T-up /mp/T-wk'; make_ovl pv-ovlT "$MP/base-store" "$MP/T-up" "$MP/T-wk"
t_ovl=$( { /usr/bin/time -f %e docker run --rm $CE $XDG -v "$MP":/mp -v pv-ovlT:/store "$NODE_IMG" bash -c "
  mkdir -p /tmp/t && cd /tmp/t; printf '{\"name\":\"t\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /store --offline install --silent"; } 2>&1 | tail -1)
t_plain=$( { /usr/bin/time -f %e docker run --rm $CE $XDG -v "$MP":/mp -v "$MP/base-store":/store "$NODE_IMG" bash -c "
  mkdir -p /tmp/t && cd /tmp/t; printf '{\"name\":\"t\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /store --offline install --silent"; } 2>&1 | tail -1)
printf "    %-42s %ss\n" "base-hit install, store on overlay" "$t_ovl"
printf "    %-42s %ss\n" "base-hit install, plain store (control)" "$t_plain"
warn "single-shot wall time incl. container spawn — order-of-magnitude, not a benchmark."

hdr "6. Store lock — two concurrent installs, one base, two uppers"
mp 'mkdir -p /mp/P-up /mp/P-wk /mp/Q-up /mp/Q-wk'
make_ovl pv-ovlP "$MP/base-store" "$MP/P-up" "$MP/P-wk"
make_ovl pv-ovlQ "$MP/base-store" "$MP/Q-up" "$MP/Q-wk"
run_conc(){ docker run --rm $CE $XDG -v "$MP":/mp -v "$1":/store "$NODE_IMG" bash -c "
  mkdir -p /tmp/c && cd /tmp/c; printf '{\"name\":\"c\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /store --offline install --silent >/tmp/c.log 2>&1; echo \$?"; }
r1=$(run_conc pv-ovlP & run_conc pv-ovlQ & wait)
echo "    concurrent rcs: $(echo $r1)"
echo "$r1" | grep -qE '[1-9]' && warn "a concurrent install returned non-zero — inspect store lock" \
  || pass "two concurrent installs over one base, separate uppers — no lock error"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && ok "Store-in-overlay isolates the index attack; disk/time captured above." \
  || bad "A cell failed — record which; the overlay store fix is not proven on this host."
