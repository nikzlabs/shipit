#!/usr/bin/env bash
#
# ineligible-sharing-host-spike.sh — the overlay + distinct-uid half of the "sharing for
#   ineligible repos" measurements (docs/276 plan.md section 5, planning#414).
#
# `ineligible-sharing-spike.sh` runs in a session container and names, with an LD_PRELOAD
# interposer, WHICH files pnpm chmods: a base hit and an in-package edit chmod nothing, while
# `pnpm add` chmods eight files that are all base files. This harness is the other half — it puts
# those files on a real overlay lowerdir owned by another uid with group write (`shareOne`,
# session-worker-uid.ts:124) and asks whether the chmod actually EPERMs there, which the
# interposer cannot answer.
#
# Cells (hard-asserted; exit non-zero on any failure):
#   1. the base builds the builder's way and carries a bin-bearing package unbuilt.
#   2. base hit as a session uid: rc=0 — the non-vacuity control for cells 3 and 4.
#   3. `pnpm add` over that base as the session uid (req 9).
#   4. a PRUNED base — the build-bearing package removed from the tree AND from the carried
#      `node_modules/.pnpm/lock.yaml` — installed with a bare `pnpm install`: is the package
#      re-imported, does its build run, and what does the upper cost?
#   5. the candidate repair: pre-seed the tree's bin-target files into the session's upper owned
#      by the session uid, then re-run 3 and 4.
#   6. isolation: the base stays byte-unchanged and a second session inherits nothing.
#
# Run on a host with the Docker daemon (the "services" host); it cannot run in a session
# container. Cleans up its volumes on exit.
set -uo pipefail

BUILDER_IMG="pnpm-ineligible-builder:local"
SESSION_IMG="pnpm-ineligible-session:local"
BUILDER_PNPM="12.4.1"     # the pinned builder pnpm
SESSION_PNPM="12.5.1"     # the image's corepack default, as production pairs them
BUILD_PKG="better-sqlite3"; BUILD_PKG_VER="11.5.0"
ARTIFACT="node_modules/$BUILD_PKG/build/Release/better_sqlite3.node"
ADDON_PROBE="node -e \"new (require('$BUILD_PKG'))(':memory:').close()\" >/dev/null 2>&1 && echo yes || echo no"
# rimraf and semver carry `bin` entries, which is what puts pnpm's unconditional bin chmod on the
# path; a tree of bin-less packages would measure nothing.
SCRIPTLESS='"rimraf":"5.0.10","semver":"7.6.3","lodash":"4.17.21","chalk":"5.3.0"'
ADD_PKG="left-pad"        # scriptless and bin-less: the add itself cannot be what fails
GID=2000; UID1=2001; UID2=2002

ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }; hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0; pass(){ ok "$1"; PASS=$((PASS+1)); }; fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }

build_img(){ docker image inspect "$1" >/dev/null 2>&1 && return
  docker build -q -t "$1" - >/dev/null <<DOCKER
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@$2 && pnpm --version
DOCKER
}

VOL="is-store"; OVLS="is-hit is-add is-prune is-add2 is-prune2 is-s2"
cleanup(){ for v in $OVLS; do docker volume rm "$v" >/dev/null 2>&1 || true; done
           docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker volume create "$VOL" >/dev/null; MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"

mp(){ docker run --rm -v "$MP":/mp "$SESSION_IMG" bash -c "$1"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true
  docker volume create "$1" --driver local --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
upper_sz(){ mp "du -sB1 /mp/$1-up 2>/dev/null | cut -f1"; }
base_sum(){ mp 'cd /mp/base/proj/node_modules && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16'; }

hdr "0. Environment"
build_img "$BUILDER_IMG" "$BUILDER_PNPM"; build_img "$SESSION_IMG" "$SESSION_PNPM"
echo "    docker $(docker version -f '{{.Server.Version}}')  host $(docker info -f '{{.OperatingSystem}}')  kernel $(uname -r)"
echo "    builder pnpm $(docker run --rm $BUILDER_IMG pnpm --version)  session pnpm $(docker run --rm $SESSION_IMG pnpm --version)"
echo "    volume fs $(docker run --rm -v "$VOL":/v "$SESSION_IMG" stat -f -c %T /v)  base owner root:$GID (g+rw), session uids $UID1/$UID2"

hdr "1. Build the base the way the builder does"
docker run --rm -v "$MP":/mp "$BUILDER_IMG" bash -c "
  mkdir -p /mp/resolve && cd /mp/resolve
  printf '{\"name\":\"r\",\"version\":\"1.0.0\",\"dependencies\":{\"$BUILD_PKG\":\"$BUILD_PKG_VER\",$SCRIPTLESS}}' > package.json
  pnpm install --lockfile-only --ignore-scripts --silent >/mp/resolve.log 2>&1
  test -f pnpm-lock.yaml && echo LOCK_OK || { echo LOCK_FAIL; tail -5 /mp/resolve.log; }" | tail -1 | grep -q LOCK_OK \
  && pass "lockfile resolved" || { fail "could not resolve a lockfile"; exit 1; }

docker run --rm -v "$MP":/mp "$BUILDER_IMG" bash -c "
  mkdir -p /mp/base/proj && cd /mp/base/proj
  cp /mp/resolve/package.json /mp/resolve/pnpm-lock.yaml .
  pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy \
       install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --silent >/mp/base.log 2>&1
  rc=\$?; [ \$rc = 0 ] || tail -5 /mp/base.log
  echo RC=\$rc BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent)" | tail -1 > /tmp/is.base
r=$(cat /tmp/is.base); echo "    $r"
[ "$(field "$r" RC)" = 0 ] || { fail "base build failed: $r"; exit 1; }
[ "$(field "$r" BUILT)" = absent ] && pass "the base carries the package UNBUILT (what --ignore-scripts is for)" \
  || { fail "the base already carries build output"; exit 1; }

BUILD_ID=$(mp "grep -o '$BUILD_PKG@[0-9.]*' /mp/base/proj/node_modules/.modules.yaml | head -1")
[ -n "$BUILD_ID" ] && pass "the base records the build as pending: $BUILD_ID" || { fail "no pendingBuilds entry"; exit 1; }
# The chmod target set, computed the way the orchestrator would: every `bin` entry of every
# package in the finished tree. This is both cell 5's seed list and its cost.
mp "cat > /mp/binlist.js <<'EOF'
const fs=require('fs'),path=require('path'),root='/mp/base/proj/node_modules';
const out=new Set();
for(const d of fs.readdirSync(root+'/.pnpm')){ const nm=path.join(root,'.pnpm',d,'node_modules'); if(!fs.existsSync(nm))continue;
  const scan=(dir,pref)=>{ for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(!e.isDirectory())continue; if(e.name.startsWith('@')){scan(path.join(dir,e.name),pref+e.name+'/');continue}
    const p=path.join(dir,e.name),mf=path.join(p,'package.json'); if(!fs.existsSync(mf))continue;
    let j; try{j=JSON.parse(fs.readFileSync(mf,'utf8'))}catch{continue}
    // pnpm links executables from `bin`, and from `directories.bin` when `bin` is absent —
    // measured, and a `bin`-only list silently misses the second form.
    let t=[];
    if(j.bin) t=typeof j.bin==='string'?[j.bin]:Object.values(j.bin);
    else if(j.directories&&typeof j.directories.bin==='string'){ const bd=path.resolve(p,j.directories.bin);
      try{ for(const e of fs.readdirSync(bd,{withFileTypes:true})) if(e.isFile()) t.push(path.join(j.directories.bin,e.name)); }catch{} }
    if(t.length===0)continue;
    for(const x of t){ const f=path.resolve(p,x); if(fs.existsSync(f)) out.add(path.relative(root,f)); } } };
  scan(nm,''); }
console.log([...out].sort().join('\n'));
EOF
node /mp/binlist.js > /mp/binlist.txt; wc -l < /mp/binlist.txt"
NBIN=$(mp "grep -c . /mp/binlist.txt || echo 0")
BINSZ=$(mp "cd /mp/base/proj/node_modules && xargs -a /mp/binlist.txt du -cb 2>/dev/null | tail -1 | cut -f1")
BASE_FILES=$(mp 'find /mp/base/proj/node_modules -type f | wc -l')
BASE_SZ=$(mp 'du -sB1 /mp/base/proj/node_modules | cut -f1')
echo "    base: $BASE_FILES files, $((BASE_SZ/1024/1024)) MiB;  bin targets: $NBIN files, $((BINSZ/1024)) KiB"
[ "$NBIN" -gt 0 ] && pass "the tree has $NBIN bin target(s), so pnpm's bin chmod is on the path" \
  || { fail "no bin targets — the harness would measure nothing"; exit 1; }

mp "chgrp -R $GID /mp/base/proj/node_modules && chmod -R g+rwX /mp/base/proj/node_modules"
BASE_SUM0=$(base_sum)

# ---------------------------------------------------------------- session plumbing
new_session(){ # $1 name, $2 uid, $3 lowerdir as a CONTAINER path under /mp, $4 seed-bins(1|0)
  mp "rm -rf /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      cp /mp/base/proj/package.json /mp/base/proj/pnpm-lock.yaml /mp/$1-proj/
      printf 'allowBuilds:\n  $BUILD_ID: true\n' > /mp/$1-proj/pnpm-workspace.yaml"
  if [ "$4" = 1 ]; then
    # The candidate repair: every bin target pre-copied into the upper and owned by the session,
    # so pnpm's unconditional chmod lands on a file the session owns instead of on a lower file.
    local seeded
    seeded=$(mp "cd $3 && n=0; while read -r f; do [ -n \"\$f\" ] || continue
          mkdir -p /mp/$1-up/\$(dirname \"\$f\") && cp -p \"\$f\" /mp/$1-up/\"\$f\" && n=\$((n+1))
        done < /mp/binlist.txt; echo \$n")
    [ "$seeded" = "$NBIN" ] || { fail "seeding copied $seeded of $NBIN bin targets"; return 1; }
  fi
  mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  # The overlay options need the HOST path for the same directory.
  make_ovl "is-$1" "$MP/${3#/mp/}" "$MP/$1-up" "$MP/$1-wk"; }

in_session(){ docker run --rm --user "$2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy \
  -v "$MP/$1-cache":/cache -v "$MP/$1-store":/workspace/.pnpm-store \
  -v "$MP/$1-proj":/proj -v "is-$1":/proj/node_modules "$SESSION_IMG" \
  bash -c "cd /proj; $3" 2>&1; }

# `pnpm install` bare, NOT --frozen-lockfile: a repo's own agent.install usually is, and the
# in-container harness showed a bare install short-circuits on a tree-only hole.
run_install(){ in_session "$1" "$2" "
  s=\$(date +%s%N)
  pnpm --store-dir /workspace/.pnpm-store install ${3:-} >/tmp/i.log 2>&1; rc=\$?
  e=\$(( (\$(date +%s%N) - s) / 1000000 ))
  echo RC=\$rc MS=\$e EPERM=\$(grep -ci 'not permitted' /tmp/i.log) CHMOD=\$(grep -ci 'failed to chmod' /tmp/i.log) \
       BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent) ADDON=\$($ADDON_PROBE) \
       PKG=\$([ -d node_modules/.pnpm/$BUILD_ID ] && echo present || echo absent)
  tail -3 /tmp/i.log | sed 's/^/      | /'"; }

BASE_NM="/mp/base/proj/node_modules"   # container path; new_session derives the host one

hdr "2. Base hit as a session uid — the control cells 3 and 4 rest on"
new_session hit "$UID1" "$BASE_NM" 0
r=$(run_install hit "$UID1"); echo "$r" | grep '|' ; r=$(echo "$r" | grep '^RC=')
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "a base hit succeeds as a non-owner uid (upper $(upper_sz hit) B)" \
  || { fail "the base hit itself failed — every cell below would be confounded: $r"; exit 1; }

hdr "3. pnpm add over the base, as the session uid (req 9)"
new_session add "$UID1" "$BASE_NM" 0
r=$(in_session add "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1; rc=\$?
  echo RC=\$rc EPERM=\$(grep -ci 'not permitted' /tmp/a.log) CHMOD=\$(grep -ci 'chmod' /tmp/a.log) \
       ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no)
  grep -i 'chmod\|not permitted' /tmp/a.log | head -2 | sed 's/^/      | /'")
echo "$r" | grep '|'; a=$(echo "$r" | grep '^RC=')
echo "    $a"
if [ "$(field "$a" RC)" != 0 ] && [ "$(field "$a" EPERM)" != 0 ]; then
  pass "CONFIRMED: pnpm add fails as the session uid, on a chmod of a base file — req 9 is unmet"
elif [ "$(field "$a" RC)" = 0 ]; then
  fail "pnpm add SUCCEEDED — the in-container inference does not hold on a real overlay"
else
  fail "pnpm add failed for some other reason: $a"
fi

hdr "4. A PRUNED base — tree and carried lockfile — with a bare pnpm install"
mp "cp -a /mp/base/proj/node_modules /mp/pruned
    rm -rf /mp/pruned/.pnpm/$BUILD_ID /mp/pruned/$BUILD_PKG
    cat > /mp/prune.js <<'EOF'
const fs=require('fs');const p='/mp/pruned/.pnpm/lock.yaml';const drop=process.argv[2];
const L=fs.readFileSync(p,'utf8').split('\n');const out=[];let skip=null;
const indent=s=>s.length-s.trimStart().length;
for(const line of L){ if(skip!==null){ if(line.trim()==='' || indent(line)>skip) continue; skip=null; }
  const t=line.trim();
  if(t.startsWith(drop+'@')&&t.endsWith(':')){ skip=indent(line); continue; }
  if(t===drop+':'){ skip=indent(line); continue; }
  out.push(line); }
fs.writeFileSync(p,out.join('\n'));
EOF
    node /mp/prune.js $BUILD_PKG"
LEFT=$(mp "grep -c '$BUILD_PKG@' /mp/pruned/.pnpm/lock.yaml; true" | head -1)
[ "$LEFT" = 0 ] && pass "the carried lock.yaml no longer names $BUILD_PKG" \
  || warn "$LEFT reference(s) to $BUILD_PKG remain in the carried lock.yaml"
mp "chgrp -R $GID /mp/pruned && chmod -R g+rwX /mp/pruned"
PRUNED_SUM0=$(mp 'cd /mp/pruned && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16')

new_session prune "$UID1" /mp/pruned 0
r=$(run_install prune "$UID1"); echo "$r" | grep '|'; p1=$(echo "$r" | grep '^RC=')
echo "    $p1   upper $(upper_sz prune) B"
if [ "$(field "$p1" RC)" = 0 ]; then
  pass "the pruned-base install succeeds as the session uid"
  [ "$(field "$p1" BUILT)" = present ] && pass "the pruned package was re-imported AND BUILT" \
    || fail "install succeeded but the package is still unbuilt: $p1"
else
  warn "the pruned-base install FAILS unseeded ($(field "$p1" RC)), EPERM=$(field "$p1" EPERM) — same constraint as cell 3"
fi

hdr "5. The candidate repair: pre-seed the bin targets into the session's upper"
echo "    seeding $NBIN files / $((BINSZ/1024)) KiB per session"
new_session add2 "$UID1" "$BASE_NM" 1
r=$(in_session add2 "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1; rc=\$?
  echo RC=\$rc EPERM=\$(grep -ci 'not permitted' /tmp/a.log) ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no)
  tail -3 /tmp/a.log | sed 's/^/      | /'")
echo "$r" | grep '|'; a2=$(echo "$r" | grep '^RC=')
echo "    $a2   upper $(upper_sz add2) B"
[ "$(field "$a2" RC)" = 0 ] && [ "$(field "$a2" ADDED)" = yes ] \
  && pass "REPAIR WORKS for pnpm add: rc=0 and the package is present" \
  || fail "seeding did not fix pnpm add: $a2"

new_session prune2 "$UID1" /mp/pruned 1
r=$(run_install prune2 "$UID1"); echo "$r" | grep '|'; p2=$(echo "$r" | grep '^RC=')
echo "    $p2   upper $(upper_sz prune2) B"
[ "$(field "$p2" RC)" = 0 ] && pass "REPAIR WORKS for the pruned base: rc=0" || fail "pruned base still fails seeded: $p2"
[ "$(field "$p2" BUILT)" = present ] && [ "$(field "$p2" ADDON)" = yes ] \
  && pass "the pruned package is re-imported, BUILT, and the addon loads" \
  || fail "the package is not built after the repair: $p2"
P2_STORE=$(mp "du -sB1 /mp/prune2-store 2>/dev/null | cut -f1")
HIT_STORE=$(mp "du -sB1 /mp/hit-store 2>/dev/null | cut -f1")
echo "    build-bearing repo, marginal over a base hit: upper $(( ($(upper_sz prune2) - $(upper_sz hit)) / 1024 / 1024 )) MiB \
+ private store $(( (P2_STORE - HIT_STORE) / 1024 / 1024 )) MiB  (base hit: upper $(upper_sz hit) B, store $HIT_STORE B)"

hdr "6. Isolation"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "the base tree is byte-unchanged" || fail "a session wrote into the shared base"
PRUNED_SUM1=$(mp 'cd /mp/pruned && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16')
[ "$PRUNED_SUM1" = "$PRUNED_SUM0" ] && pass "the pruned base is byte-unchanged" || fail "a session wrote into the pruned base"
new_session s2 "$UID2" /mp/pruned 1
r=$(in_session s2 "$UID2" "echo ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no) \
    BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent)")
echo "    session 2 sees: $r"
[ "$(field "$r" ADDED)" = no ] && [ "$(field "$r" BUILT)" = absent ] \
  && pass "a second session inherits neither the add nor the build" || fail "session 2 inherited session 1's upper: $r"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
