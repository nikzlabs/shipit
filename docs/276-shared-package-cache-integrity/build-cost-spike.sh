#!/usr/bin/env bash
#
# build-cost-spike.sh — what a base hit costs, and what it DOES, when the repo has a package
#   that builds (checklist: "Measure the build-inclusive base-hit install cost").
#
# The 8 KB base-hit figure from tree-overlay-spike.sh used scriptless dependencies and ran as
# root. This closes both gaps:
#
#   - the base is built the way the real builder builds it — pinned pnpm 12.4.1,
#     `--frozen-lockfile --ignore-scripts --ignore-pnpmfile`, so a script-bearing package lands
#     UNBUILT — and the consumer runs the image's corepack default (12.5.1), the version
#     pairing production has;
#   - every session container runs as its OWN non-root uid over a base owned by another uid
#     with group write (`shareOne`, session-worker-uid.ts:124), the docs/270 shape the earlier
#     spikes never exercised.
#
# The experiment is one project, one approval file, run two ways: over the base, and with no
# base. The no-base arm is what makes the base arm's result mean something.
#
# Cells (hard-asserted; exit non-zero on any failure):
#   1. the base carries the package but NOT its build output.
#   2. base hit, build NOT approved: time + upper.
#   3. base hit, build APPROVED (`allowBuilds` keyed by the package id pnpm itself recorded in
#      `pendingBuilds`): time + upper + whether the build ran.
#   4. the SAME project and approval with NO base: whether the build ran, and what it costs.
#   5. the remedies a user would reach for over a base: `pnpm rebuild`, `pnpm install --force`.
#   6. isolation: the base stays byte-unchanged and a second session inherits nothing.
#
# Run on a host with the Docker daemon (the "services" host); it cannot run in a session
# container. Cleans up its volumes on exit.
set -uo pipefail

BUILDER_IMG="pnpm-build-spike-builder:local"   # the pinned builder pnpm
SESSION_IMG="pnpm-build-spike-session:local"   # the consumer's corepack default
BUILDER_PNPM="12.4.1"
SESSION_PNPM="12.5.1"
# A package whose build script genuinely PRODUCES the artifact: better-sqlite3's `install`
# fetches a prebuilt binding or compiles one, and `build/Release/better_sqlite3.node` does not
# exist without it. esbuild was tried first and rejected — its binary ships in an optional
# dependency, so it works with scripts suppressed and the harness would have measured a no-op.
BUILD_PKG="better-sqlite3"
BUILD_PKG_VER="11.5.0"
ARTIFACT="node_modules/$BUILD_PKG/build/Release/better_sqlite3.node"
# Loading the addon, not just requiring the package: better-sqlite3's `require` succeeds with no
# binding at all (measured), so the file check and this check are both needed.
ADDON_PROBE="node -e \"new (require('$BUILD_PKG'))(':memory:').close();console.log('ok')\" >/dev/null 2>&1 && echo yes || echo no"
SCRIPTLESS='"lodash":"4.17.21","react":"18.3.1","chalk":"5.3.0","date-fns":"4.1.0","zod":"3.23.8"'
RUNS=3
GID=2000; UID1=2001; UID2=2002

ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }; hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0; pass(){ ok "$1"; PASS=$((PASS+1)); }; fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }

# The session image carries a toolchain because an approved build may have to COMPILE; without
# it a node-gyp fallback would fail and a cell would measure a failure, not a build.
build_img(){ # $1 tag, $2 pnpm version
  docker image inspect "$1" >/dev/null 2>&1 && return
  docker build -q -t "$1" - >/dev/null <<DOCKER
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@$2 && pnpm --version
DOCKER
}

VOL="bc-store"; OVLS="bc-nobuild bc-build bc-s2"
cleanup(){ for v in $OVLS; do docker volume rm "$v" >/dev/null 2>&1 || true; done
           docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker volume create "$VOL" >/dev/null; MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"

mp(){ docker run --rm -v "$MP":/mp "$SESSION_IMG" bash -c "$1"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true
  docker volume create "$1" --driver local --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
upper_sz(){ mp "du -sB1 /mp/$1-up | cut -f1"; }
base_sum(){ mp 'cd /mp/base/proj/node_modules && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16'; }

hdr "0. Environment"
build_img "$BUILDER_IMG" "$BUILDER_PNPM"; build_img "$SESSION_IMG" "$SESSION_PNPM"
echo "    docker $(docker version -f '{{.Server.Version}}')  host $(docker info -f '{{.OperatingSystem}}')"
echo "    builder pnpm $(docker run --rm $BUILDER_IMG pnpm --version)  session pnpm $(docker run --rm $SESSION_IMG pnpm --version)"
echo "    volume fs $(docker run --rm -v "$VOL":/v "$SESSION_IMG" stat -f -c %T /v)   base owner root:$GID (g+rw), session uids $UID1/$UID2"

hdr "1. Resolve a lockfile, then build the base the way the builder does"
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
  echo RC=\$rc NM=\$([ -d node_modules/.pnpm ] && echo 1 || echo 0) \
       BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent) ADDON=\$($ADDON_PROBE)" | tail -1 > /tmp/bc.base
r=$(cat /tmp/bc.base); echo "    $r"
[ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" NM)" = 1 ] && pass "base built with the builder's flags" || { fail "base build failed: $r"; exit 1; }
[ "$(field "$r" BUILT)" = absent ] && [ "$(field "$r" ADDON)" = no ] \
  && pass "the base carries the package but NOT its build output — what --ignore-scripts is for" \
  || { fail "the base already carries the build output; the cells below would measure nothing"; exit 1; }

# The id pnpm ITSELF recorded, so the approval cannot be keyed wrong: pnpm 12 keys `allowBuilds`
# by `<name>@<version>`, and a bare name silently approves nothing.
BUILD_ID=$(mp "node -e \"const m=require('/mp/base/proj/node_modules/.modules.yaml');\" 2>/dev/null; \
  grep -A2 '\"pendingBuilds\"' /mp/base/proj/node_modules/.modules.yaml | grep -o '$BUILD_PKG@[0-9.]*' | head -1")
[ -n "$BUILD_ID" ] && pass "the base records the build as pending: $BUILD_ID" || { fail "no pendingBuilds entry in the base"; exit 1; }

BASE_FILES=$(mp 'find /mp/base/proj/node_modules -type f | wc -l')
BASE_SZ=$(mp 'du -sB1 /mp/base/proj/node_modules | cut -f1')
# Production's `shareOne`: the orchestrator's uid keeps ownership, the session gid gets group write.
mp "chgrp -R $GID /mp/base/proj/node_modules && chmod -R g+rwX /mp/base/proj/node_modules"
BASE_SUM0=$(base_sum)
echo "    base: $BASE_FILES files, $((BASE_SZ/1024/1024)) MiB allocated, content sum $BASE_SUM0"

approve_file(){ # $1 dir — printf's FORMAT string expands \n; `printf %s` would not.
  mp "printf 'allowBuilds:\n  $BUILD_ID: true\n' > $1/pnpm-workspace.yaml"; }

new_session(){ # $1 name, $2 uid, $3 approve(1|0)
  mp "rm -rf /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache
      cp /mp/base/proj/package.json /mp/base/proj/pnpm-lock.yaml /mp/$1-proj/"
  [ "$3" = 1 ] && approve_file "/mp/$1-proj"
  mp "chown -R $2:$GID /mp/$1-up /mp/$1-wk /mp/$1-proj /mp/$1-store /mp/$1-cache"
  make_ovl "bc-$1" "$MP/base/proj/node_modules" "$MP/$1-up" "$MP/$1-wk"; }

in_session(){ docker run --rm --user "$2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -v "$MP/$1-cache":/cache -v "$MP/$1-store":/workspace/.pnpm-store \
  -v "$MP/$1-proj":/proj -v "bc-$1":/proj/node_modules "$SESSION_IMG" \
  bash -c "cd /proj; $3" 2>&1; }

timed_install(){ # $1 name, $2 uid, $3 approve, $4 extra args, $5 runs
  local best=999999 last="" ms
  for _ in $(seq 1 "$5"); do
    new_session "$1" "$2" "$3"
    last=$(in_session "$1" "$2" "
      s=\$(date +%s%N)
      pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy install $4 --silent >/tmp/i.log 2>&1
      rc=\$?; e=\$(( (\$(date +%s%N) - s) / 1000000 ))
      [ \$rc = 0 ] || tail -4 /tmp/i.log
      echo RC=\$rc MS=\$e BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent) ADDON=\$($ADDON_PROBE) \
           STORE=\$(find /workspace/.pnpm-store -type f 2>/dev/null | wc -l)" | tail -1)
    ms=$(field "$last" MS)
    [ -n "$ms" ] && [ "$ms" -lt "$best" ] 2>/dev/null && best=$ms
  done
  echo "$last BEST_MS=$best"; }

hdr "2. Base hit, build NOT approved"
r=$(timed_install nobuild "$UID1" 0 "" "$RUNS"); echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "rc=0 as a non-root uid over a base owned by another uid" || fail "base hit failed: $r"
[ "$(field "$r" STORE)" = 0 ] && pass "private store untouched — a base hit imports nothing" || warn "store got $(field "$r" STORE) files"
[ "$(field "$r" BUILT)" = absent ] && pass "unbuilt, as expected with no approval" || fail "built without approval"
U_NOBUILD=$(upper_sz nobuild); T_NOBUILD=$(field "$r" BEST_MS)
echo "    upper ${U_NOBUILD} B, best of $RUNS: ${T_NOBUILD} ms"

hdr "3. Base hit, build APPROVED by the id pnpm recorded"
r=$(timed_install build "$UID1" 1 "" "$RUNS"); echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "rc=0 — the session's own install reports success" || fail "approved install failed: $r"
U_BUILD=$(upper_sz build); T_BUILD=$(field "$r" BEST_MS)
echo "    upper ${U_BUILD} B, best of $RUNS: ${T_BUILD} ms"
echo "    marginal over cell 2: $(( (U_BUILD-U_NOBUILD)/1024 )) KiB, $((T_BUILD-T_NOBUILD)) ms"
BUILD_RAN_OVER_BASE=$(field "$r" BUILT)
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "base tree byte-unchanged" || fail "the session wrote into the shared base"

hdr "4. The SAME project and approval with NO base — the arm that gives cell 3 meaning"
mp "rm -rf /mp/nb-proj /mp/nb-store /mp/nb-cache && mkdir -p /mp/nb-proj /mp/nb-store /mp/nb-cache
    cp /mp/base/proj/package.json /mp/base/proj/pnpm-lock.yaml /mp/nb-proj/"
approve_file /mp/nb-proj
mp "chown -R $UID2:$GID /mp/nb-proj /mp/nb-store /mp/nb-cache"
r=$(docker run --rm --user "$UID2:$GID" -e HOME=/tmp -e XDG_CACHE_HOME=/cache -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -v "$MP/nb-cache":/cache -v "$MP/nb-store":/workspace/.pnpm-store -v "$MP/nb-proj":/proj "$SESSION_IMG" bash -c "
  cd /proj; s=\$(date +%s%N)
  pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy install --silent >/tmp/i.log 2>&1
  rc=\$?; e=\$(( (\$(date +%s%N) - s) / 1000000 )); [ \$rc = 0 ] || tail -4 /tmp/i.log
  echo RC=\$rc MS=\$e BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent) ADDON=\$($ADDON_PROBE)" 2>&1 | tail -1)
echo "    $r"
NB_MS=$(field "$r" MS)
NB_NM=$(mp 'du -sB1 /mp/nb-proj/node_modules | cut -f1'); NB_STORE=$(mp 'du -sB1 /mp/nb-store | cut -f1')
[ "$(field "$r" RC)" = 0 ] && pass "no-base install is rc=0" || fail "no-base install failed: $r"
[ "$(field "$r" BUILT)" = present ] && [ "$(field "$r" ADDON)" = yes ] \
  && pass "the SAME approval DOES build without a base — so the approval file and key are right" \
  || fail "the approval does not build even without a base; this harness proves nothing"
echo "    no-base cost: tree $((NB_NM/1024/1024)) MiB + store $((NB_STORE/1024/1024)) MiB, ${NB_MS} ms (cold)"

hdr "3b. The verdict on cell 3, now that cell 4 has validated the approval"
if [ "$BUILD_RAN_OVER_BASE" = present ]; then
  pass "the approved build RAN over the base; the marginal cost above is the answer"
else
  fail "the approved build did NOT run over the base — rc=0, silently unbuilt (see FINDINGS.md)"
fi

hdr "5. The remedies a user would reach for, over the base"
for cmd in "rebuild" "install --force"; do
  r=$(in_session build "$UID1" "
    pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy $cmd >/tmp/c.log 2>&1
    rc=\$?; echo RC=\$rc BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent) \
      ERR=\$(grep -oE 'Operation not permitted|Ignored build scripts|EACCES' /tmp/c.log | head -1 | tr ' ' '_')" | tail -1)
  echo "    pnpm $cmd -> $r"
  if [ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" BUILT)" = present ]; then
    pass "pnpm $cmd repairs it"
  else
    warn "pnpm $cmd does NOT repair it (rc=$(field "$r" RC) $(field "$r" ERR))"
  fi
done

hdr "6. A second session over the same base"
new_session s2 "$UID2" 0
r=$(in_session s2 "$UID2" "
  pnpm --store-dir /workspace/.pnpm-store --config.package-import-method=copy install --silent >/tmp/i.log 2>&1
  rc=\$?; [ \$rc = 0 ] || tail -3 /tmp/i.log
  echo RC=\$rc BUILT=\$([ -f $ARTIFACT ] && echo present || echo absent)" | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "session 2 (a different uid) installs over the same base" || fail "session 2 failed: $r"
[ "$(field "$r" BUILT)" = absent ] && pass "session 2 inherits nothing of session 1's upper" || fail "session 1's upper leaked into session 2"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "base still byte-unchanged at the end" || fail "base changed"

hdr "Summary"
echo "    base               : $BASE_FILES files, $((BASE_SZ/1024/1024)) MiB, built unbuilt ($BUILD_ID pending)"
echo "    base hit, no approval : ${U_NOBUILD} B upper, ${T_NOBUILD} ms"
echo "    base hit, approved    : ${U_BUILD} B upper, ${T_BUILD} ms, build ran: $BUILD_RAN_OVER_BASE"
echo "    no base, approved     : $((NB_NM/1024/1024)) MiB tree + $((NB_STORE/1024/1024)) MiB store, ${NB_MS} ms, build ran: present"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { ok "Measured."; exit 0; } || { bad "$FAIL cell(s) failed."; exit 1; }
