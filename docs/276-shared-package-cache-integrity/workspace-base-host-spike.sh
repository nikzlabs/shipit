#!/usr/bin/env bash
#
# workspace-base-host-spike.sh — a WORKSPACE base as a real overlay lowerdir under distinct uids
#   (planning#414; checklist: "Run the workspace admission's overlay cells on the services host").
#
# `local-specifier-spike.sh` settled what pnpm does with `workspace:`/`link:`/`file:`, and the
# workspace cell in `integration_tests/pnpm-verified-base-build.test.ts` consumes a root-only base
# on the real builder pipeline — but as an ordinary writable copy under one identity. Neither can
# answer what only a host can: a workspace base is published as `projectDir/node_modules` ALONE,
# so a consuming session must build every `packages/*/node_modules` itself, over a read-only
# lowerdir owned by another uid, on the overlay where planning#606's chmod defect lives.
#
# The shape that makes this different from `bin-seed-host-spike.sh`, whose plumbing it reuses:
# the base carries the member as a RELATIVE SYMLINK and none of its source, so every member tree
# is work the session does, and the member's `.bin` shims chmod targets that resolve back through
# that symlink into the base's own virtual store.
#
# Cells (hard-asserted; exit non-zero on any failure):
#   1. a workspace base built from MANIFESTS ONLY, the way the builder stages: it carries
#      `node_modules/<member> -> ../packages/<member>` and no member content.
#   2. the seed set, and that it covers the targets a MEMBER's shims name.
#   3. CONTROL, unseeded: the member-tree rebuild or a `pnpm add` fails EPERM.
#   4. seeded: a base hit with every member tree ABSENT rebuilds them as the session's own uid,
#      and the member resolves its dependency through the base.
#   5. the member symlink resolves to the SESSION's own source, which the base never saw, and an
#      edit inside a workspace package is visible at once and survives an install (req 11).
#   6. `pnpm add` in the ROOT and in a MEMBER, both as the session uid (req 9).
#   7. isolation: the base is byte-unchanged and a second session inherits nothing.
#
# Run on a host with the Docker daemon (the "services" host); it cannot run in a session
# container. Cleans up its volumes on exit.
set -uo pipefail

BUILDER_IMG="pnpm-ws-builder:local"
SESSION_IMG="pnpm-ws-session:local"
BUILDER_PNPM="12.4.1"     # the pinned builder pnpm
SESSION_PNPM="12.5.1"     # the image's corepack default, as production pairs them
# The ROOT's dependencies, and the MEMBER's. Both carry `bin` entries, so pnpm's unconditional
# bin chmod is on the path from the root tree AND from the member tree — the latter is the one
# no previous harness exercised.
ROOT_DEPS='"rimraf":"5.0.10","lodash":"4.17.21"'
MEMBER_DEPS='"semver":"7.6.3","chalk":"5.3.0"'
MEMBER="wsmember"   # deliberately not a substring of any transitive (`ui` matched @isaacs/cliui)
MEMBER_BIN="semver"       # the member's bin-bearing dependency
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@$2 && pnpm --version
DOCKER
}

VOL="ws-store"; OVLS="ws-ctl ws-live ws-s2"
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
BASE_NM="/mp/base/proj/node_modules"

hdr "0. Environment"
build_img "$BUILDER_IMG" "$BUILDER_PNPM"; build_img "$SESSION_IMG" "$SESSION_PNPM"
echo "    docker $(docker version -f '{{.Server.Version}}')  host $(docker info -f '{{.OperatingSystem}}')  kernel $(uname -r)"
echo "    builder pnpm $(docker run --rm $BUILDER_IMG pnpm --version)  session pnpm $(docker run --rm $SESSION_IMG pnpm --version)"
echo "    base owner root:$GID (g+rw), session uids $UID1/$UID2"

# The committed inputs. `$1` = destination, `$2` = 1 to write member SOURCE as well. The builder
# gets 0 — it stages manifests, never package source — and a session gets 1, because a session
# has the whole checkout. That asymmetry is the point of cells 1 and 5.
write_project(){ mp "
  mkdir -p $1/packages/$MEMBER
  printf '{\"name\":\"root\",\"version\":\"1.0.0\",\"private\":true,\"dependencies\":{$ROOT_DEPS,\"$MEMBER\":\"workspace:*\"}}' > $1/package.json
  printf 'packages:\n  - packages/*\n' > $1/pnpm-workspace.yaml
  printf '{\"name\":\"$MEMBER\",\"version\":\"1.0.0\",\"main\":\"index.js\",\"dependencies\":{$MEMBER_DEPS}}' > $1/packages/$MEMBER/package.json
  [ '$2' = 1 ] && printf 'module.exports=\"MEMBER-SOURCE\";\n' > $1/packages/$MEMBER/index.js
  true"; }

hdr "1. Build the workspace base the way the builder does — manifests only"
write_project /mp/base/proj 0
docker run --rm -v "$MP":/mp "$BUILDER_IMG" bash -c "
  cd /mp/base/proj
  pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy \
       install --ignore-scripts --ignore-pnpmfile --silent >/mp/base.log 2>&1
  echo RC=\$? PKGS=\$(ls node_modules/.pnpm | wc -l)" | tail -1 > /tmp/ws.base
r=$(cat /tmp/ws.base); echo "    $r"
[ "$(field "$r" RC)" = 0 ] || { fail "base build failed"; mp 'tail -5 /mp/base.log'; exit 1; }
pass "the workspace base built from manifests alone, $(field "$r" PKGS) virtual-store entries"

# What the base carries for the member: one relative symlink, and none of its content.
LINK=$(mp "readlink $BASE_NM/$MEMBER 2>/dev/null || echo NONE")
[ "$LINK" = "../packages/$MEMBER" ] \
  && pass "the base carries $MEMBER as the relative symlink $LINK" \
  || fail "the base does not carry the member as a relative symlink: $LINK"
# The shape an injected/`file:` copy has in the virtual store, measured in local-specifier-spike
# cell A: `<name>@file+<path>`. A substring match on the member name is not that, and matches
# ordinary transitives.
COPIED=$(mp "ls -d $BASE_NM/.pnpm/$MEMBER@file+* 2>/dev/null | wc -l")
[ "$COPIED" = 0 ] && pass "and no copy of the member in the virtual store — nothing of it entered the base" \
  || fail "the base carries $COPIED copied member director(ies): the snapshot's content leaked in"
# The member's own tree is produced by the build but is NOT what gets published.
MEMNM=$(mp "[ -d /mp/base/proj/packages/$MEMBER/node_modules ] && echo yes || echo no")
[ "$MEMNM" = yes ] && pass "the builder DID produce packages/$MEMBER/node_modules, which the publish leaves behind" \
  || fail "the builder produced no member tree, so cell 4 would measure nothing"

# `shareOne` (session-worker-uid.ts): group-share every file, which is what lets a session copy
# up a base file but not chmod it — and what makes pnpm's 0600 workspace-state file readable.
mp "chgrp -R $GID $BASE_NM && chmod -R g+rwX $BASE_NM"
STATE_MODE=$(mp "stat -c %a $BASE_NM/.pnpm-workspace-state-v1.json 2>/dev/null || echo NONE")
[ "$STATE_MODE" != NONE ] && [ "${STATE_MODE:1:1}" -ge 6 ] \
  && pass "pnpm's 0600 .pnpm-workspace-state-v1.json is published $STATE_MODE, so a foreign uid can read it" \
  || fail "the workspace state file is not group-readable ($STATE_MODE): a consumer could not read it"
BASE_SUM0=$(base_sum)

hdr "2. The seed set (overlay-bin-seed.ts), and whether it covers a MEMBER's shims"
mp "cat > /mp/seed.js <<'EOF'
const fs=require('fs'), path=require('path');
const [lower, upper, marker] = process.argv.slice(2);
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
echo "    seed set: $NBIN files"
[ "$NBIN" -gt 0 ] || { fail "no bin targets — this harness would measure nothing"; exit 1; }
# The member's dependency is bin-bearing, and its target lives in the ROOT virtual store, which
# is exactly the tree the seed walks. That containment is what makes the repair cover a member.
mp "grep -q '^\.pnpm/$MEMBER_BIN@' /mp/binlist.txt" \
  && pass "the seed set covers the MEMBER's bin-bearing dependency, in the root virtual store" \
  || { fail "the member's bin target is not in the seed set:"; mp "head -5 /mp/binlist.txt"; }

# ---------------------------------------------------------------- session plumbing
# A session gets the FULL checkout — member source included — and NO member tree: that is the
# state a container start leaves, since only `node_modules` is an overlay.
new_session(){ # $1 name, $2 uid, $3 seed(1|0)
  mp "rm -rf /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache /mp/$1-seed.json
      mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-store /mp/$1-cache"
  write_project "/mp/$1-proj" 1
  mp "cp /mp/base/proj/pnpm-lock.yaml /mp/$1-proj/"
  [ "$3" = 1 ] && seed "$1"
  mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  make_ovl "ws-$1" "$MP/base/proj/node_modules" "$MP/$1-up" "$MP/$1-wk"; }

seed(){ mp "node /mp/seed.js $BASE_NM /mp/$1-up /mp/$1-seed.json"; }

in_session(){ docker run --rm --user "$2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e PNPM_CONFIG_PACKAGE_IMPORT_METHOD=copy \
  -v "$MP/$1-cache":/cache -v "$MP/$1-store":/workspace/.pnpm-store \
  -v "$MP/$1-proj":/proj -v "ws-$1":/proj/node_modules "$SESSION_IMG" \
  bash -c "cd /proj; $3" 2>&1; }

hdr "3. CONTROL, unseeded: the session uid hits the chmod defect"
new_session ctl "$UID1" 0
r=$(in_session ctl "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1; I=\$?
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/a.log 2>&1
  echo INSTALL=\$I RC=\$? EPERM=\$(cat /tmp/i.log /tmp/a.log | grep -ci 'not permitted')
  grep -i 'chmod\|not permitted' /tmp/i.log /tmp/a.log | head -2 | sed 's/^/      | /'")
echo "$r" | grep '|'; c=$(echo "$r" | grep '^INSTALL='); echo "    $c"
[ "$(field "$c" EPERM)" != 0 ] \
  && pass "unseeded, a workspace consumer hits EPERM — the cells below are not vacuous" \
  || fail "the defect did not reproduce, so seeding cannot be shown to fix anything: $c"

hdr "4. Seeded: a base hit rebuilds every member tree as the session's own uid"
new_session live "$UID1" 1
MEMNM_BEFORE=$(mp "[ -d /mp/live-proj/packages/$MEMBER/node_modules ] && echo yes || echo no")
[ "$MEMNM_BEFORE" = no ] && pass "the session starts with NO packages/$MEMBER/node_modules, as a container start leaves it" \
  || fail "the member tree was already there, so the rebuild below proves nothing"
r=$(in_session live "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i.log 2>&1
  echo INSTALL=\$? EPERM=\$(grep -ci 'not permitted' /tmp/i.log) \
       MEMTREE=\$([ -d packages/$MEMBER/node_modules ] && echo yes || echo no) \
       MEMDEP=\$(readlink packages/$MEMBER/node_modules/$MEMBER_BIN 2>/dev/null || echo NONE) \
       OWNER=\$(stat -c %u packages/$MEMBER/node_modules 2>/dev/null || echo NONE)
  tail -2 /tmp/i.log | sed 's/^/      | /'")
echo "$r" | grep '|'; l=$(echo "$r" | grep '^INSTALL='); echo "    $l   upper $(upper_sz live) B"
[ "$(field "$l" INSTALL)" = 0 ] && [ "$(field "$l" EPERM)" = 0 ] \
  || { fail "the base hit itself failed — every cell below is confounded: $l"; exit 1; }
pass "a workspace base hit succeeds as a non-owner uid, with no EPERM"
[ "$(field "$l" MEMTREE)" = yes ] && [ "$(field "$l" OWNER)" = "$UID1" ] \
  && pass "it rebuilt packages/$MEMBER/node_modules, owned by the session ($UID1)" \
  || fail "the member tree was not rebuilt as the session's own: $l"
case "$(field "$l" MEMDEP)" in
  *node_modules/.pnpm/$MEMBER_BIN@*) pass "and the member resolves $MEMBER_BIN through the BASE's virtual store";;
  *) fail "the member's dependency does not link into the base: $(field "$l" MEMDEP)";;
esac
# The member's own shims are new files in the checkout, but they chmod targets in the base.
r=$(in_session live "$UID1" "
  S=packages/$MEMBER/node_modules/.bin/$MEMBER_BIN
  # pnpm writes the shim as a SCRIPT naming its target in a trailer, not as a symlink, so
  # \`readlink -f\` returns the shim itself. The trailer is where the chmod target is.
  T=\$(readlink -f \"\$(sed -n 's/.*# cmd-shim-target=//p' \"\$S\" | head -1)\" 2>/dev/null)
  echo SHIM=\$([ -e \"\$S\" ] && echo yes || echo no) TARGET=\$T \
       TARGET_X=\$([ -x \"\$T\" ] && echo yes || echo no) \
       IN_BASE=\$(case \"\$T\" in /proj/node_modules/.pnpm/*) echo yes;; *) echo no;; esac) \
       RUNS=\$(\"\$S\" 1.2.3 >/dev/null 2>&1 && echo yes || echo no)")
echo "    $r"
[ "$(field "$r" SHIM)" = yes ] && [ "$(field "$r" RUNS)" = yes ] \
  && pass "the member's own .bin shim exists and executes over the base" \
  || fail "the member's shim is missing or not executable: $r"
# The point of the cell: that shim's chmod target is a file in the BASE, not in the checkout.
[ "$(field "$r" IN_BASE)" = yes ] && [ "$(field "$r" TARGET_X)" = yes ] \
  && pass "and its chmod target is an executable file inside the BASE — which is why the seed covers it" \
  || fail "the member's shim does not target a base file: $r"

hdr "5. The member link resolves to the SESSION's source, and an edit stays per session (req 11)"
r=$(in_session live "$UID1" "
  echo SEES=\$(node -e \"process.stdout.write(require('/proj/node_modules/$MEMBER'))\" 2>/dev/null || echo NONE)")
echo "    $r"
[ "$(field "$r" SEES)" = "MEMBER-SOURCE" ] \
  && pass "the base's symlink resolves to the session's own member source, which the base never saw" \
  || fail "the member link does not resolve to the session's source: $r"
r=$(in_session live "$UID1" "
  printf 'module.exports=\"EDITED-BY-AGENT\";\n' > packages/$MEMBER/index.js; E=\$?
  pnpm --store-dir /workspace/.pnpm-store install >/tmp/i2.log 2>&1; I=\$?
  echo EDIT=\$E INSTALL=\$I SEES=\$(node -e \"process.stdout.write(require('/proj/node_modules/$MEMBER'))\" 2>/dev/null || echo NONE)")
echo "    $r"
[ "$(field "$r" EDIT)" = 0 ] && [ "$(field "$r" INSTALL)" = 0 ] && [ "$(field "$r" SEES)" = "EDITED-BY-AGENT" ] \
  && pass "an edit inside the workspace package is visible AT ONCE and survives an install (req 11)" \
  || fail "the in-member edit did not hold: $r"

hdr "6. pnpm add, in the root and in a member (req 9)"
r=$(in_session live "$UID1" "
  pnpm --store-dir /workspace/.pnpm-store add $ADD_PKG >/tmp/ar.log 2>&1; AR=\$?
  pnpm --store-dir /workspace/.pnpm-store --filter $MEMBER add $ADD_PKG >/tmp/am.log 2>&1; AM=\$?
  echo ADD_ROOT=\$AR ADD_MEMBER=\$AM \
       ROOT_OK=\$([ -e node_modules/$ADD_PKG ] && echo yes || echo no) \
       MEM_OK=\$([ -e packages/$MEMBER/node_modules/$ADD_PKG ] && echo yes || echo no) \
       EPERM=\$(cat /tmp/ar.log /tmp/am.log | grep -ci 'not permitted')
  tail -2 /tmp/am.log | sed 's/^/      | /'")
echo "$r" | grep '|'; l=$(echo "$r" | grep '^ADD_ROOT='); echo "    $l   upper $(upper_sz live) B"
[ "$(field "$l" ADD_ROOT)" = 0 ] && [ "$(field "$l" ROOT_OK)" = yes ] \
  && pass "REPAIR: pnpm add in the ROOT succeeds as the session's own uid" || fail "root add failed: $l"
[ "$(field "$l" ADD_MEMBER)" = 0 ] && [ "$(field "$l" MEM_OK)" = yes ] \
  && pass "REPAIR: pnpm add in a WORKSPACE MEMBER succeeds as the session's own uid" || fail "member add failed: $l"
[ "$(field "$l" EPERM)" = 0 ] && pass "not one 'Operation not permitted' in either add log" || fail "an EPERM remains: $l"

hdr "7. Isolation"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "the base tree is byte-unchanged" || fail "a session wrote into the shared base"
new_session s2 "$UID2" 1
r=$(in_session s2 "$UID2" "
  pnpm --store-dir /workspace/.pnpm-store install >/dev/null 2>&1
  echo ADDED=\$([ -e node_modules/$ADD_PKG ] && echo yes || echo no) \
       MEMADD=\$([ -e packages/$MEMBER/node_modules/$ADD_PKG ] && echo yes || echo no) \
       SEES=\$(node -e \"process.stdout.write(require('/proj/node_modules/$MEMBER'))\" 2>/dev/null || echo NONE)")
echo "    session 2 sees: $r"
[ "$(field "$r" ADDED)" = no ] && [ "$(field "$r" MEMADD)" = no ] && [ "$(field "$r" SEES)" = "MEMBER-SOURCE" ] \
  && pass "a second session inherits neither add nor session 1's edit to the workspace package" \
  || fail "session 2 inherited session 1's state: $r"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "and the base is still byte-unchanged after both sessions" \
  || fail "a session wrote into the shared base"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
