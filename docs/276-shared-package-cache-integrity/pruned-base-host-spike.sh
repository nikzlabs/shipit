#!/usr/bin/env bash
#
# pruned-base-host-spike.sh — the PRUNED verified base on a real overlay, under distinct session
# uids (docs/276 plan.md section 5, "Sharing for ineligible repos"; planning#604 / #414).
#
# `pruned-base-spike.sh` measures what pnpm does with a pruned tree; only this host can answer
# what happens when that tree is a read-only lowerdir owned by ANOTHER uid — which is where
# planning#604's defect lived and where its repair has to be shown.
#
# It runs the SHIPPED prune, not a restatement of it: `prune-cli.cjs` is
# `src/server/orchestrator/pnpm-base-prune.ts` bundled by esbuild. Build and copy it with
#
#   npx esbuild <entry importing pnpm-base-prune.js> --bundle --platform=node --format=cjs \
#     --outfile=/tmp/prune-cli.cjs
#   scp /tmp/prune-cli.cjs docs/276-*/pruned-base-host-spike.sh services:/tmp/
#
# Cells (hard-asserted; exit non-zero on any failure):
#   1. a base the builder's way over a BUILD-BEARING lockfile: whole tree, `--ignore-scripts`,
#      the native package present and unbuilt.
#   2. the shipped prune over that tree: what it removes, and that it verifies.
#   3. CONTROL, UNPRUNED (what a `v2` base does): an approved build over a base hit exits 0 and
#      the addon still does not load — planning#604's defect, so the cells below are not vacuous.
#   4. PRUNED: the session's own BARE `pnpm install` as its own uid re-imports the package,
#      BUILDS it, and the addon loads. Upper and private-store cost, and wall time.
#   5. `pnpm add` and `pnpm rebuild` over the pruned base, as the session's own uid.
#   6. the cost table: pruned base vs a base hit vs no base at all.
#   7. isolation: the base is byte-unchanged and a second session inherits nothing.
#
# Run on a host with the Docker daemon (the "services" host). Cleans up its volumes on exit.
set -uo pipefail

BUILDER_IMG="pnpm-pruned-builder:local"
SESSION_IMG="pnpm-pruned-session:local"
BUILDER_PNPM="12.4.1"     # the pinned builder pnpm
SESSION_PNPM="12.5.1"     # the image's corepack default, as production pairs them
PRUNE_CLI="${PRUNE_CLI:-/tmp/prune-cli.cjs}"

# The build-bearing package is the whole subject; the rest are the scriptless remainder a base
# exists to share, and carry `bin` entries so the seed has something to seed.
NATIVE_PKG="better-sqlite3"; NATIVE_VER="11.0.0"
SCRIPTLESS='"rimraf":"5.0.10","semver":"7.6.3","lodash":"4.17.21","chalk":"5.3.0"'
DEPS="\"$NATIVE_PKG\":\"$NATIVE_VER\",$SCRIPTLESS"
ADD_PKG="left-pad"
GID=2000; UID1=2001; UID2=2002

ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0; pass(){ ok "$1"; PASS=$((PASS+1)); }; fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }
[ -f "$PRUNE_CLI" ] || { echo "the bundled prune is missing at $PRUNE_CLI (see the header)"; exit 2; }

build_img(){ docker image inspect "$1" >/dev/null 2>&1 && return
  docker build -q -t "$1" - >/dev/null <<DOCKER
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@$2 && pnpm --version
DOCKER
}

VOL="pb-store"; OVLS="pb-ctl pb-live pb-s2 pb-hit"
cleanup(){ for v in $OVLS; do docker volume rm "$v" >/dev/null 2>&1 || true; done
           docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker volume create "$VOL" >/dev/null; MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"

mp(){ docker run --rm -v "$MP":/mp "$SESSION_IMG" bash -c "$1"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true
  docker volume create "$1" --driver local --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
sz(){ mp "du -sB1 $1 2>/dev/null | cut -f1" ; }
tree_sum(){ mp "cd $1 && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16"; }

hdr "0. Environment"
build_img "$BUILDER_IMG" "$BUILDER_PNPM"; build_img "$SESSION_IMG" "$SESSION_PNPM"
# Through a container: the volume's mountpoint is root-owned and this script is not run as root.
docker run --rm -v "$MP":/mp -v "$PRUNE_CLI":/in.cjs:ro "$SESSION_IMG" cp /in.cjs /mp/prune-cli.cjs
echo "    docker $(docker version -f '{{.Server.Version}}')  kernel $(uname -r)"
echo "    builder pnpm $(docker run --rm $BUILDER_IMG pnpm --version)  session pnpm $(docker run --rm $SESSION_IMG pnpm --version)"
echo "    volume fs $(docker run --rm -v "$VOL":/v "$SESSION_IMG" stat -f -c %T /v)  base owner root:$GID (g+rw), session uids $UID1/$UID2"

# ---------------------------------------------------------------------------------- 1. the base
hdr "1. Build the base the way the builder does: whole tree, --ignore-scripts"
build_base(){ # $1 dir  $2 dependency json
  docker run --rm -v "$MP":/mp "$BUILDER_IMG" bash -c "
    mkdir -p /mp/$1/proj && cd /mp/$1/proj
    printf '{\"name\":\"b\",\"version\":\"1.0.0\",\"dependencies\":{$2}}' > package.json
    printf 'allowBuilds:\n  $NATIVE_PKG@$NATIVE_VER: true\n' > pnpm-workspace.yaml
    pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy \
         install --ignore-scripts --ignore-pnpmfile --silent >/mp/$1.log 2>&1
    echo RC=\$? PKGS=\$(ls node_modules/.pnpm | wc -l)" | tail -1; }

r=$(build_base full "$DEPS"); echo "    $r"
[ "$(field "$r" RC)" = 0 ] || { fail "base build failed"; mp 'tail -5 /mp/full.log'; exit 1; }
pass "the base built whole, $(field "$r" PKGS) virtual-store entries"
FULL_NM="/mp/full/proj/node_modules"
ADDON="$FULL_NM/.pnpm/$NATIVE_PKG@$NATIVE_VER/node_modules/$NATIVE_PKG/build/Release"
mp "[ -d $FULL_NM/.pnpm/$NATIVE_PKG@$NATIVE_VER ] && echo PRESENT=yes || echo PRESENT=no; \
    [ -d $ADDON ] && echo BUILT=yes || echo BUILT=no" > /tmp/pb.native
n=$(tr '\n' ' ' < /tmp/pb.native); echo "    $n"
[ "$(field "$n" PRESENT)" = yes ] && [ "$(field "$n" BUILT)" = no ] \
  && pass "the native package is in the tree and UNBUILT, which is why it cannot stay" \
  || { fail "the premise does not hold: $n"; exit 1; }

# A scriptless-only base, for the base-hit arm of the cost table.
r=$(build_base lean "$SCRIPTLESS"); echo "    lean base: $r"
[ "$(field "$r" RC)" = 0 ] || { fail "the lean base failed to build"; exit 1; }

# ---------------------------------------------------------------------------------- 2. the prune
hdr "2. The shipped prune over the built tree"
# A copy, so cell 3's control can consume the UNPRUNED tree the builder produced.
mp "cp -a /mp/full /mp/pruned"
PRUNED_NM="/mp/pruned/proj/node_modules"
OUT=$(mp "node /mp/prune-cli.cjs $PRUNED_NM $NATIVE_PKG@$NATIVE_VER"); RC=$?
echo "    $OUT"
[ "$RC" = 0 ] && pass "the prune verifies" || { fail "the prune did not verify"; exit 1; }
mp "[ -d $PRUNED_NM/.pnpm/$NATIVE_PKG@$NATIVE_VER ] && echo GONE=no || echo GONE=yes; \
    grep -c '$NATIVE_PKG' $PRUNED_NM/.pnpm/lock.yaml | sed 's/^/LOCK=/'; \
    ls -a $PRUNED_NM | grep -c '^.pnpm-workspace-state' | sed 's/^/STATE=/'" > /tmp/pb.pruned
p=$(tr '\n' ' ' < /tmp/pb.pruned); echo "    $p"
[ "$(field "$p" GONE)" = yes ] && pass "the package is out of the tree" || fail "it is still in the tree"
[ "$(field "$p" LOCK)" = 0 ] && pass "and out of the carried lockfile" || fail "the carried lockfile still names it"
[ "$(field "$p" STATE)" = 0 ] && pass "and the carried install state is gone, so no install can short-circuit" \
  || fail "the install state survived: a session's own install would say 'Already up to date'"

for b in full pruned lean; do
  mp "chgrp -R $GID /mp/$b/proj/node_modules && chmod -R g+rwX /mp/$b/proj/node_modules"
done
BASE_SUM0=$(tree_sum "$PRUNED_NM")

# ------------------------------------------------------------------------- session plumbing
# A transcription of overlay-bin-seed.ts: the chmod repair planning#606 shipped, which every
# cell below needs — `bin-seed-host-spike.sh` is what holds the seeder itself honest.
mp "cat > /mp/seed.js <<'EOF'
const fs=require('fs'), path=require('path');
const [lower, upper] = process.argv.slice(2);
const within=(root,p)=>{const r=path.relative(root,p); return r!=='' && !r.startsWith('..') && !path.isAbsolute(r);};
function filesUnder(d,depth){ if(depth>16) return [];
  let out=[]; let es; try{ es=fs.readdirSync(d,{withFileTypes:true}); }catch{ return []; }
  for(const e of es){ const p=path.join(d,e.name);
    if(e.isDirectory()) out=out.concat(filesUnder(p,depth+1)); else if(e.isFile()) out.push(p); }
  return out; }
function binTargets(dir){
  let j; try{ j=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')); }catch{ return []; }
  const declared=[];
  if(typeof j.bin==='string') declared.push(j.bin);
  else if(j.bin && typeof j.bin==='object')
    for(const v of Object.values(j.bin)) if(typeof v==='string') declared.push(v);
  if(typeof j.directories?.bin==='string'){
    const abs=path.resolve(dir,j.directories.bin);
    if(within(dir,abs)) for(const f of filesUnder(abs,0)) declared.push(path.relative(dir,f));
  }
  const out=new Set();
  for(const d of declared){ if(d==='') continue; const abs=path.resolve(dir,d); if(!within(dir,abs)) continue;
    try{ if(fs.lstatSync(abs).isFile()) out.add(path.relative(dir,abs)); }catch{} }
  return [...out];
}
function scan(dir,out){
  let es; try{ es=fs.readdirSync(dir,{withFileTypes:true}); }catch{ return; }
  for(const e of es){ if(!e.isDirectory()) continue; const p=path.join(dir,e.name);
    if(e.name.startsWith('@')){ scan(p,out); continue; }
    for(const t of binTargets(p)) out.add(path.relative(lower,path.join(p,t))); } }
const set=new Set();
for(const e of (()=>{try{return fs.readdirSync(path.join(lower,'.pnpm'),{withFileTypes:true})}catch{return[]}})())
  if(e.isDirectory()) scan(path.join(lower,'.pnpm',e.name,'node_modules'),set);
let files=0,bytes=0;
for(const rel of [...set].sort()){
  const src=path.join(lower,rel); let st,data;
  try{ st=fs.lstatSync(src); if(!st.isFile()) continue; data=fs.readFileSync(src); }catch{ continue; }
  fs.mkdirSync(path.join(upper,path.dirname(rel)),{recursive:true});
  const dest=path.join(upper,rel);
  let fd; try{ fd=fs.openSync(dest,'wx',st.mode & 0o7777); }catch{ continue; }
  try{ fs.writeSync(fd,data); } finally { fs.closeSync(fd); }
  fs.chmodSync(dest, st.mode & 0o7777); files++; bytes+=data.length;
}
console.log('SEEDED='+files+' BYTES='+bytes);
EOF
true"

new_session(){ # $1 name, $2 uid, $3 base dir under /mp (empty = no overlay), $4 dependency json
  mp "rm -rf /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  if [ -n "$3" ]; then
    mp "cp /mp/$3/proj/package.json /mp/$3/proj/pnpm-lock.yaml /mp/$3/proj/pnpm-workspace.yaml /mp/$1-proj/"
    # The session's checkout PREDATES the base build, which is the shape pnpm's carried install
    # state short-circuits on. Making it current would hide exactly what cell 2 removed.
    mp "touch -d '1 hour ago' /mp/$1-proj/package.json /mp/$1-proj/pnpm-lock.yaml /mp/$1-proj/pnpm-workspace.yaml"
    mp "node /mp/seed.js /mp/$3/proj/node_modules /mp/$1-up" >/dev/null
    mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
    make_ovl "pb-$1" "$MP/$3/proj/node_modules" "$MP/$1-up" "$MP/$1-wk"
  else
    mp "cd /mp/$1-proj && printf '{\"name\":\"b\",\"version\":\"1.0.0\",\"dependencies\":{$4}}' > package.json
        printf 'allowBuilds:\n  $NATIVE_PKG@$NATIVE_VER: true\n' > pnpm-workspace.yaml"
    mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  fi; }

in_session(){ # $1 name, $2 uid, $3 script, $4 overlay(1|0)
  local mount=()
  [ "$4" = 1 ] && mount=(-v "pb-$1":/proj/node_modules)
  docker run --rm --user "$2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy \
    -v "$MP/$1-cache":/cache -v "$MP/$1-store":/workspace/.pnpm-store \
    -v "$MP/$1-proj":/proj "${mount[@]}" "$SESSION_IMG" \
    bash -c "cd /proj; $3" 2>&1; }

# Loads the addon, rather than only requiring the package: `require` succeeds with no binding.
LOADS="node -e \"const D=require('$NATIVE_PKG'); const d=new D(':memory:'); d.prepare('select 1 as x').get();\" >/dev/null 2>&1 && echo yes || echo no"

# ------------------------------------------------------------------- 3. control: an UNPRUNED base
hdr "3. CONTROL: the same base UNPRUNED, which is what a v2 base is"
new_session ctl "$UID1" full ""
r=$(in_session ctl "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1
  echo RC=\$? UPTODATE=\$(grep -ci 'already up to date' /tmp/i.log) LOADS=\$($LOADS)" 1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" LOADS)" = no ] \
  && pass "planning#604's defect reproduces: the install exits 0 and the addon does NOT load" \
  || fail "the control did not reproduce; every cell below would pass for free: $r"

# ------------------------------------------------------------------------- 4. the pruned base
hdr "4. PRUNED: the session's own bare install as its own uid"
new_session live "$UID1" pruned ""
T0=$(date +%s%N)
r=$(in_session live "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1
  echo RC=\$? UPTODATE=\$(grep -ci 'already up to date' /tmp/i.log) \
       RESTORED=\$([ -d node_modules/.pnpm/$NATIVE_PKG@$NATIVE_VER ] && echo yes || echo no) \
       LOADS=\$($LOADS) EPERM=\$(grep -ci 'not permitted' /tmp/i.log)
  tail -3 /tmp/i.log | sed 's/^/      | /'" 1)
T1=$(date +%s%N); LIVE_MS=$(( (T1-T0)/1000000 ))
echo "$r" | grep '|'; l=$(echo "$r" | grep '^RC='); echo "    $l   ${LIVE_MS}ms"
[ "$(field "$l" RC)" = 0 ] && pass "the install succeeds as a non-owner uid over the pruned base" \
  || { fail "the install failed: $l"; }
[ "$(field "$l" UPTODATE)" = 0 ] && pass "it did NOT short-circuit on a stale checkout" \
  || fail "it reported 'Already up to date' — the prune was hidden from it"
[ "$(field "$l" RESTORED)" = yes ] && pass "the pruned package is re-imported into the PRIVATE store" \
  || fail "the pruned package was not restored"
[ "$(field "$l" LOADS)" = yes ] && pass "REPAIR: it was BUILT as the session's own uid and the addon LOADS" \
  || fail "the addon does not load, so the build did not happen"
[ "$(field "$l" EPERM)" = 0 ] && pass "not one 'Operation not permitted'" || fail "an EPERM remains"

LIVE_UP=$(sz "/mp/live-up"); LIVE_ST=$(sz "/mp/live-store")

# ------------------------------------------------------------------------ 5. add and rebuild
hdr "5. pnpm add and pnpm rebuild over the pruned base"
r=$(in_session live "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1; ADD=\$?
  pnpm --store-dir /workspace/.pnpm-store rebuild >/tmp/r.log 2>&1; REB=\$?
  echo ADD=\$ADD REB=\$REB ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no) \
       LOADS=\$($LOADS) EPERM=\$(cat /tmp/a.log /tmp/r.log | grep -ci 'not permitted')" 1)
echo "    $r"
[ "$(field "$r" ADD)" = 0 ] && [ "$(field "$r" ADDED)" = yes ] \
  && pass "pnpm add succeeds as the session's own uid (req 9)" || fail "pnpm add failed: $r"
[ "$(field "$r" REB)" = 0 ] && pass "pnpm rebuild succeeds" || fail "pnpm rebuild failed: $r"
[ "$(field "$r" LOADS)" = yes ] && pass "and the addon still loads afterwards" || fail "the rebuild broke the addon"
[ "$(field "$r" EPERM)" = 0 ] && pass "no EPERM in either log" || fail "an EPERM remains: $r"

# ------------------------------------------------------------------------------ 6. the cost
hdr "6. Cost: pruned base vs a base hit vs no base"
new_session hit "$UID1" lean ""
T0=$(date +%s%N)
r=$(in_session hit "$UID1" "pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1; echo RC=\$?" 1)
T1=$(date +%s%N); HIT_MS=$(( (T1-T0)/1000000 ))
[ "$(field "$r" RC)" = 0 ] || fail "the base-hit arm failed: $r"
HIT_UP=$(sz "/mp/hit-up"); HIT_ST=$(sz "/mp/hit-store")

new_session none "$UID2" "" "$DEPS"
T0=$(date +%s%N)
r=$(in_session none "$UID2" "
  pnpm --store-dir /workspace/.pnpm-store install --no-frozen-lockfile >/tmp/i.log 2>&1
  echo RC=\$? LOADS=\$($LOADS)" 0)
T1=$(date +%s%N); NONE_MS=$(( (T1-T0)/1000000 ))
echo "    no-base control: $r"
[ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" LOADS)" = yes ] \
  && pass "the no-base control installs and builds, as the repo does today" || fail "the control failed: $r"
NONE_TREE=$(sz "/mp/none-proj/node_modules"); NONE_ST=$(sz "/mp/none-store")

kib(){ echo "$(( $1 / 1024 )) KiB"; }
printf '    %-22s %12s %12s %10s\n' arm upper/tree store wall
printf '    %-22s %12s %12s %10s\n' "pruned base"  "$(kib "$LIVE_UP")" "$(kib "$LIVE_ST")" "${LIVE_MS}ms"
printf '    %-22s %12s %12s %10s\n' "base hit (scriptless)" "$(kib "$HIT_UP")" "$(kib "$HIT_ST")" "${HIT_MS}ms"
printf '    %-22s %12s %12s %10s\n' "no base at all" "$(kib "$NONE_TREE")" "$(kib "$NONE_ST")" "${NONE_MS}ms"
[ "$LIVE_UP" -lt "$NONE_TREE" ] \
  && pass "a pruned base costs less than no base ($(kib "$LIVE_UP") vs $(kib "$NONE_TREE"))" \
  || fail "the pruned base costs as much as no base, so it buys nothing"

# ------------------------------------------------------------------------------ 7. isolation
hdr "7. Isolation"
[ "$(tree_sum "$PRUNED_NM")" = "$BASE_SUM0" ] && pass "the base tree is byte-unchanged" \
  || fail "a session wrote into the shared base"
new_session s2 "$UID2" pruned ""
r=$(in_session s2 "$UID2" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  echo ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no) \
       RESTORED=\$([ -d node_modules/.pnpm/$NATIVE_PKG@$NATIVE_VER ] && echo yes || echo no) \
       LOADS=\$($LOADS)" 1)
echo "    session 2 sees: $r"
[ "$(field "$r" ADDED)" = no ] && pass "a second session inherits nothing session 1 added" \
  || fail "session 2 inherited session 1's upper: $r"
[ "$(field "$r" RESTORED)" = yes ] && [ "$(field "$r" LOADS)" = yes ] \
  && pass "and builds its OWN copy of the pruned package, which loads" || fail "session 2 did not build its own: $r"
[ "$(tree_sum "$PRUNED_NM")" = "$BASE_SUM0" ] && pass "the base is still byte-unchanged after both sessions" \
  || fail "a session wrote into the shared base"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
