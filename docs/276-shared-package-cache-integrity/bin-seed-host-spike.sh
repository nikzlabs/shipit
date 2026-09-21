#!/usr/bin/env bash
#
# bin-seed-host-spike.sh — planning#606's repair, measured as the orchestrator actually applies it.
#
# `ineligible-sharing-host-spike.sh` established the defect and that seeding removes it. It seeds
# by deleting each upper first, so it measures the MECHANISM and not the RULE the implementation
# states: seed once when the upper is created, never overwrite an entry that already exists, and
# record the seed in a marker BESIDE the upper so a container restart within a generation does not
# seed again (docs/276 req 11 — a re-seed would put the base's copy back over the agent's own edit).
# This harness measures that rule, on a real overlay under distinct uids.
#
# Cells (hard-asserted; exit non-zero on any failure):
#   1. a base the builder's way, bin-bearing, owned by another uid with group write.
#   2. the seed set and its cost, and that it contains every target pnpm's own `.bin` shims name.
#   3. CONTROL, unseeded: `pnpm add` fails EPERM on a chmod of a base file.
#   4. seeded: a base hit, an edit inside a base package, `pnpm add` and `pnpm rebuild` all
#      succeed as the session's own uid.
#   5. seed-once: a second container start over the SAME upper skips the seed on its marker, and
#      both the agent's edit to a seeded bin file and its edit inside a package survive.
#   6. isolation: the base is byte-unchanged and a second session inherits nothing.
#
# Run on a host with the Docker daemon (the "services" host); it cannot run in a session
# container. Cleans up its volumes on exit.
set -uo pipefail

BUILDER_IMG="pnpm-ineligible-builder:local"
SESSION_IMG="pnpm-ineligible-session:local"
BUILDER_PNPM="12.4.1"     # the pinned builder pnpm
SESSION_PNPM="12.5.1"     # the image's corepack default, as production pairs them
# rimraf and semver carry `bin` entries, which is what puts pnpm's unconditional bin chmod on the
# path; a tree of bin-less packages would measure nothing.
DEPS='"rimraf":"5.0.10","semver":"7.6.3","lodash":"4.17.21","chalk":"5.3.0"'
ADD_PKG="left-pad"        # scriptless and bin-less: the add itself cannot be what fails
EDIT_PKG="lodash"         # bin-less, so the in-package edit is not also a seeded file
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

VOL="bs-store"; OVLS="bs-ctl bs-live bs-s2"
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
  mkdir -p /mp/base/proj && cd /mp/base/proj
  printf '{\"name\":\"b\",\"version\":\"1.0.0\",\"dependencies\":{$DEPS}}' > package.json
  pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy \
       install --ignore-scripts --ignore-pnpmfile --silent >/mp/base.log 2>&1
  echo RC=\$? PKGS=\$(ls node_modules/.pnpm | wc -l)" | tail -1 > /tmp/bs.base
r=$(cat /tmp/bs.base); echo "    $r"
[ "$(field "$r" RC)" = 0 ] || { fail "base build failed"; mp 'tail -5 /mp/base.log'; exit 1; }
pass "the base built, $(field "$r" PKGS) virtual-store entries"

# Group-writable and owned by another uid: `shareOne` (session-worker-uid.ts), which is exactly
# the ownership that lets a session copy up a base file but not chmod it.
mp "chgrp -R $GID /mp/base/proj/node_modules && chmod -R g+rwX /mp/base/proj/node_modules"
BASE_SUM0=$(base_sum)
BASE_NM="/mp/base/proj/node_modules"

hdr "2. The seed set, and the seeder the orchestrator runs"
# A transcription of src/server/orchestrator/overlay-bin-seed.ts. The shipped resolver is bound by
# its own unit and integration tests; what only this host can answer is whether the copies make
# pnpm's chmod succeed under a foreign uid.
mp "cat > /mp/seed.js <<'EOF'
const fs=require('fs'), path=require('path');
const [lower, upper, marker] = process.argv.slice(2);
const within=(root,p)=>{const r=path.relative(root,p); return r!=='' && !r.startsWith('..') && !path.isAbsolute(r);};
// The union of `bin` and every file under `directories.bin`, RECURSIVELY. pnpm shims a
// `directories.bin` file four levels down (measured), so a non-recursive walk under-seeds.
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
    for(const t of binTargets(p)){ const rel=path.relative(lower,path.join(p,t)); if(within(lower,path.join(lower,rel))) out.add(rel); } }
}
const set=new Set();
for(const e of (()=>{try{return fs.readdirSync(path.join(lower,'.pnpm'),{withFileTypes:true})}catch{return[]}})())
  if(e.isDirectory()) scan(path.join(lower,'.pnpm',e.name,'node_modules'),set);
const targets=[...set].sort();
if(process.env.LIST_ONLY){ console.log(targets.join('\n')); process.exit(0); }
if(fs.existsSync(marker)){ console.log('SEEDED=0 PRESENT=0 BYTES=0 SKIPPED=marker'); process.exit(0); }
let files=0,bytes=0,present=0,failed=0;
for(const rel of targets){
  const src=path.join(lower,rel); let st,data;
  try{ st=fs.lstatSync(src); if(!st.isFile()) continue; data=fs.readFileSync(src); }catch{ failed++; continue; }
  let cur=upper, ok=true;
  for(const seg of path.dirname(rel).split(path.sep)){
    cur=path.join(cur,seg); let s=null; try{ s=fs.lstatSync(cur); }catch{}
    if(s===null){ try{ fs.mkdirSync(cur); fs.chmodSync(cur, (()=>{try{return fs.lstatSync(path.join(lower,path.relative(upper,cur))).mode & 0o7777}catch{return 0o775}})()); }catch{ ok=false; break; } }
    else if(s.isSymbolicLink() || !s.isDirectory()){ ok=false; break; }
  }
  if(!ok){ failed++; continue; }
  const dest=path.join(upper,rel);
  let fd; try{ fd=fs.openSync(dest,'wx',st.mode & 0o7777); }
  catch(e){ if(e.code==='EEXIST') present++; else failed++; continue; }
  try{ fs.writeSync(fd,data); }catch{ failed++; continue; } finally{ fs.closeSync(fd); }
  fs.chmodSync(dest, st.mode & 0o7777); files++; bytes+=data.length;
}
if(failed===0) fs.writeFileSync(marker, JSON.stringify({version:1,files,bytes}));
console.log('SEEDED='+files+' PRESENT='+present+' BYTES='+bytes+' FAILED='+failed);
EOF
LIST_ONLY=1 node /mp/seed.js $BASE_NM /mp/ignored /mp/ignored.json > /mp/binlist.txt; true"
NBIN=$(mp "grep -c . /mp/binlist.txt || echo 0")
BINSZ=$(mp "cd $BASE_NM && xargs -a /mp/binlist.txt du -cb 2>/dev/null | tail -1 | cut -f1")
BASE_FILES=$(mp "find $BASE_NM -type f | wc -l")
BASE_SZ=$(mp "du -sB1 $BASE_NM | cut -f1")
echo "    base: $BASE_FILES files, $((BASE_SZ/1024/1024)) MiB;  seed set: $NBIN files, $((BINSZ/1024)) KiB"
[ "$NBIN" -gt 0 ] && pass "the tree has $NBIN executable target(s), so pnpm's bin chmod is on the path" \
  || { fail "no bin targets — this harness would measure nothing"; exit 1; }

# The independent check on completeness: pnpm's own shim writer leaves the target in a trailer.
mp "cat > /mp/shims.js <<'EOF'
const fs=require('fs'), path=require('path'), root=process.argv[2], dirs=[];
(function walk(d,depth){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ if(!e.isDirectory()) continue;
  const p=path.join(d,e.name); if(e.name==='.bin') dirs.push(p); else if(depth<5) walk(p,depth+1); } })(root,0);
const out=new Set();
for(const d of dirs) for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(e.name.endsWith('.cmd')||e.name.endsWith('.ps1')) continue; const f=path.join(d,e.name);
  if(e.isSymbolicLink()){ out.add(path.relative(root,fs.realpathSync(f))); continue; }
  const m=/# cmd-shim-target=(.*)/.exec(fs.readFileSync(f,'utf8'));
  if(!m){ console.error('NO TRAILER '+f); continue; }
  try{ out.add(path.relative(root,fs.realpathSync(m[1].trim()))); }catch{}
}
console.log([...out].sort().join('\n'));
EOF
node /mp/shims.js $BASE_NM > /mp/shimlist.txt; true"
# Containment, not equality: a target pnpm links and the seed misses is the defect coming back,
# while a file the seed copies and pnpm never touches costs one byte-identical copy.
NSHIM=$(mp "grep -c . /mp/shimlist.txt")
MISSED=$(mp "comm -13 /mp/binlist.txt /mp/shimlist.txt | grep -c . || true")
[ "$NSHIM" -gt 0 ] || { fail "pnpm linked nothing, so containment would pass for free"; exit 1; }
if [ "$MISSED" = 0 ]; then
  pass "the seed set contains every one of the $NSHIM target(s) pnpm's own shims name"
else
  fail "the seed set misses $MISSED target(s) pnpm linked:"; mp "comm -13 /mp/binlist.txt /mp/shimlist.txt | head -10"
fi

# ---------------------------------------------------------------- session plumbing
new_session(){ # $1 name, $2 uid, $3 seed(1|0)
  mp "rm -rf /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache /mp/$1-seed.json
      mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      cp /mp/base/proj/package.json /mp/base/proj/pnpm-lock.yaml /mp/$1-proj/"
  [ "$3" = 1 ] && seed "$1"
  mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  make_ovl "bs-$1" "$MP/base/proj/node_modules" "$MP/$1-up" "$MP/$1-wk"; }

# What prepareOverlayDirs does: seed the upper, once, with the marker beside it.
seed(){ mp "node /mp/seed.js $BASE_NM /mp/$1-up /mp/$1-seed.json"; }

in_session(){ docker run --rm --user "$2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy \
  -v "$MP/$1-cache":/cache -v "$MP/$1-store":/workspace/.pnpm-store \
  -v "$MP/$1-proj":/proj -v "bs-$1":/proj/node_modules "$SESSION_IMG" \
  bash -c "cd /proj; $3" 2>&1; }

hdr "3. CONTROL, unseeded: pnpm add fails as the session uid"
new_session ctl "$UID1" 0
r=$(in_session ctl "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1
  echo RC=\$? EPERM=\$(grep -ci 'not permitted' /tmp/a.log) ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no)
  grep -i 'chmod\|not permitted' /tmp/a.log | head -2 | sed 's/^/      | /'")
echo "$r" | grep '|'; c=$(echo "$r" | grep '^RC='); echo "    $c"
[ "$(field "$c" RC)" != 0 ] && [ "$(field "$c" EPERM)" != 0 ] \
  && pass "unseeded, pnpm add fails EPERM — the cells below are not vacuous" \
  || fail "the defect did not reproduce, so seeding cannot be shown to fix anything: $c"

hdr "4. Seeded: base hit, in-package edit, pnpm add, pnpm rebuild"
new_session live "$UID1" 1
r=$(in_session live "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1
  echo INSTALL=\$? EPERM=\$(grep -ci 'not permitted' /tmp/i.log)")
echo "    $r"
[ "$(field "$r" INSTALL)" = 0 ] && pass "a base hit succeeds as a non-owner uid (upper $(upper_sz live) B)" \
  || { fail "the base hit itself failed — every cell below is confounded: $r"; exit 1; }

r=$(in_session live "$UID1" "
  echo '// the agent edits its dependency' >> node_modules/$EDIT_PKG/index.js 2>/dev/null
  EDIT=\$?
  SEEDED=\$(head -1 /mp/binlist.txt 2>/dev/null)
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1; ADD=\$?
  pnpm --store-dir /workspace/.pnpm-store rebuild >/tmp/r.log 2>&1; REB=\$?
  echo EDIT=\$EDIT ADD=\$ADD REB=\$REB ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no) \
       KEPT=\$(grep -c 'the agent edits' node_modules/$EDIT_PKG/index.js) \
       EPERM=\$(cat /tmp/a.log /tmp/r.log | grep -ci 'not permitted')
  tail -2 /tmp/a.log | sed 's/^/      | /'")
echo "$r" | grep '|'; l=$(echo "$r" | grep '^EDIT='); echo "    $l   upper $(upper_sz live) B"
[ "$(field "$l" EDIT)" = 0 ] && [ "$(field "$l" KEPT)" != 0 ] \
  && pass "the agent can edit a file inside a base package, and the edit survives the install (req 11)" \
  || fail "the in-package edit did not hold: $l"
[ "$(field "$l" ADD)" = 0 ] && [ "$(field "$l" ADDED)" = yes ] \
  && pass "REPAIR: pnpm add succeeds as the session's own uid (req 9)" || fail "pnpm add still fails seeded: $l"
[ "$(field "$l" REB)" = 0 ] && pass "REPAIR: pnpm rebuild succeeds as the session's own uid" \
  || fail "pnpm rebuild still fails seeded: $l"
[ "$(field "$l" EPERM)" = 0 ] && pass "not one 'Operation not permitted' in either log" || fail "an EPERM remains: $l"

hdr "5. Seed-once: a second container start over the same upper"
# The agent's own edit to a file that IS a seeded bin target — the thing a re-seed would overwrite.
BIN1=$(mp "head -1 /mp/binlist.txt")
in_session live "$UID1" "printf '// the agent edits a bin target\n' >> node_modules/$BIN1" >/dev/null
s=$(seed live); echo "    re-running the seed for the restart: $s"
[ "$(field "$s" SKIPPED)" = marker ] && pass "the seed is skipped on its marker, as prepareOverlayDirs skips it" \
  || fail "the second start re-seeded: $s"
r=$(in_session live "$UID1" "
  echo BIN_KEPT=\$(grep -c 'edits a bin target' node_modules/$BIN1) \
       PKG_KEPT=\$(grep -c 'the agent edits' node_modules/$EDIT_PKG/index.js) \
       ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no)")
echo "    $r"
[ "$(field "$r" BIN_KEPT)" != 0 ] && pass "the agent's edit to a SEEDED bin target survives the restart (req 11)" \
  || fail "the restart lost the agent's edit to a seeded file: $r"
[ "$(field "$r" PKG_KEPT)" != 0 ] && [ "$(field "$r" ADDED)" = yes ] \
  && pass "so does its in-package edit, and the package it added" || fail "the restart lost session state: $r"
# Even with the marker gone, the never-overwrite rule alone must protect the edit.
mp "rm -f /mp/live-seed.json"; s=$(seed live); echo "    with the marker deleted: $s"
r=$(in_session live "$UID1" "echo BIN_KEPT=\$(grep -c 'edits a bin target' node_modules/$BIN1)")
[ "$(field "$r" BIN_KEPT)" != 0 ] \
  && pass "a seed that runs again still refuses to overwrite an entry the upper has" \
  || fail "the never-overwrite rule does not hold: $r"

hdr "6. Isolation"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "the base tree is byte-unchanged" || fail "a session wrote into the shared base"
new_session s2 "$UID2" 1
r=$(in_session s2 "$UID2" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  echo ADDED=\$([ -d node_modules/$ADD_PKG ] && echo yes || echo no) \
       EDIT=\$(grep -c 'the agent edits' node_modules/$EDIT_PKG/index.js) \
       BIN=\$(grep -c 'edits a bin target' node_modules/$BIN1)")
echo "    session 2 sees: $r"
[ "$(field "$r" ADDED)" = no ] && [ "$(field "$r" EDIT)" = 0 ] && [ "$(field "$r" BIN)" = 0 ] \
  && pass "a second session inherits neither the add nor either edit" || fail "session 2 inherited session 1's upper: $r"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "and the base is still byte-unchanged after both sessions" \
  || fail "a session wrote into the shared base"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL   seed cost: $NBIN files / $((BINSZ/1024)) KiB per session"
[ "$FAIL" -eq 0 ]
