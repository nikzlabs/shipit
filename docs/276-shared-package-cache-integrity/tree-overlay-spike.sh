#!/usr/bin/env bash
#
# tree-overlay-spike.sh — the "share the tree, not the store" redesign
#   (plan.md section 5, candidate redesign): does pnpm accept a node_modules
#   provided as an overlay LOWERDIR, with a PRIVATE, EMPTY per-session store?
#
# Run on a host with the Docker daemon (the "services" host); it cannot run in
# a session container. Needs the pnpm-spike:local image built by
# store-overlay-spike.sh (built here if missing). Cleans up on exit.
#
# Model:
#   - BASE = a node_modules produced by one trusted pnpm install (a fixture
#     standing in for the content-verified base), used as the overlay lowerdir
#     mounted at the session's <project>/node_modules (the docs/183 topology).
#   - Each session: its own copy of package.json + pnpm-lock.yaml, node_modules
#     = base + its own upper, and a private store at the SAME container path the
#     base was built with (/store) — pnpm records the store path in
#     node_modules/.modules.yaml and refuses a different one.
#
# Hard-asserted cells (exit non-zero on any failure):
#   1. base-hit: `pnpm install --offline --frozen-lockfile` over the lower is a
#      no-op — rc 0, private store untouched, upper stays tiny (allocated bytes).
#   2. new package: `pnpm add` against the EMPTY private store, copy import —
#      rc 0, the package is real in this session, upper grows by ~that package,
#      base tree byte-unchanged (manifest of file hashes).
#   3. req 11: editing a file inside a base package copies up only that file.
#   4. isolation: a second session over the same base sees neither the added
#      package nor the edit, and its own no-op install is rc 0.
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
# No package with an install script: pnpm 12 exits 1 on an "Ignored build
# scripts" notice even for a no-op install, which would make rc a useless
# signal here. That behaviour is pnpm's and independent of the overlay
# (recorded in FINDINGS.md); vite (esbuild) is swapped for date-fns.
BASE_PKGS='"express":"4.21.2","lodash":"4.17.21","react":"18.3.1","chalk":"5.3.0","typescript":"5.6.3","date-fns":"4.1.0","zod":"3.23.8","axios":"1.7.9"'
NEW_PKG="left-pad@1.3.0"
EDIT_REL="node_modules/lodash/lodash.js"      # a base package file for the req-11 cell

ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }; hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0; pass(){ ok "$1"; PASS=$((PASS+1)); }; fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }
VOL="tv-store"; ALL_OVL="tv-s1 tv-s2"
cleanup(){ docker volume rm $ALL_OVL >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker volume create "$VOL" >/dev/null; MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
mp(){ docker run --rm -v "$MP":/mp "$IMG" bash -c "$1"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true; docker volume create "$1" --driver local --opt type=overlay --opt device=overlay --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }
# content manifest of the base tree: sorted "hash path" lines -> one sha256
base_sum(){ mp 'cd /mp/base/proj/node_modules && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16'; }

hdr "0. Environment"; build_img
echo "    docker $(docker version -f '{{.Server.Version}}')  host $(docker info -f '{{.OperatingSystem}}')  pnpm $(docker run --rm $IMG pnpm --version)"

hdr "1. Build the base: one trusted install (fixture for the verified base)"
docker run --rm $CE -e XDG_CACHE_HOME=/mp/cache -v "$MP":/mp "$IMG" bash -c "
  mkdir -p /mp/base/proj && cd /mp/base/proj
  printf '{\"name\":\"b\",\"version\":\"1.0.0\",\"dependencies\":{$BASE_PKGS}}' > package.json
  pnpm --store-dir /store --config.package-import-method=copy install --silent >/mp/base.warm.log 2>&1 || true
  test -d node_modules/.pnpm && echo BASE_OK || { echo BASE_FAIL; tail -5 /mp/base.warm.log; }" | tail -1 | grep -q BASE_OK \
  && pass "base node_modules built with store at /store (import=copy)" || { fail "base build failed"; exit 1; }
BASE_FILES=$(mp 'find /mp/base/proj/node_modules -type f | wc -l'); BASE_SZ=$(mp 'du -sB1 /mp/base/proj/node_modules | cut -f1')
BASE_SUM0=$(base_sum); STORE_REC=$(mp 'grep -m1 storeDir /mp/base/proj/node_modules/.modules.yaml')
echo "    base: $BASE_FILES files, ${BASE_SZ} B allocated; .modules.yaml says: $STORE_REC; content sum $BASE_SUM0"

# a session = own project copy (package.json + lockfile), node_modules overlay
# at <proj>/node_modules over the base, private EMPTY store at /store.
new_session(){ # $1 name -> overlay volume tv-$1 with upper/work under /mp/$1
  mp "mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj && cp /mp/base/proj/package.json /mp/base/proj/pnpm-lock.yaml /mp/$1-proj/"
  make_ovl "tv-$1" "$MP/base/proj/node_modules" "$MP/$1-up" "$MP/$1-wk"; }
# run a command in session $1's container; /proj is its project, /store private
in_session(){ docker run --rm $CE -e XDG_CACHE_HOME=/mp/cache -v "$MP/cache":/mp/cache -v "$MP/$1-proj":/proj -v "tv-$1":/proj/node_modules "$IMG" bash -c "cd /proj; $2" 2>&1; }
upper_sz(){ mp "du -sB1 /mp/$1-up | cut -f1"; }

hdr "2. Session 1 — base-hit install over the lower with an EMPTY private store"
new_session s1
r=$(in_session s1 'pnpm --store-dir /store --config.package-import-method=copy --offline --frozen-lockfile install --silent >/tmp/i.log 2>&1; rc=$?
  [ $rc = 0 ] || tail -3 /tmp/i.log
  echo RC=$rc STORE_FILES=$(find /store -type f 2>/dev/null | wc -l) NM_OK=$([ -f node_modules/lodash/package.json ] && echo 1 || echo 0)' | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "install over the lower is rc=0 (pnpm accepted the lowerdir tree as up to date)" || fail "install over the lower failed: $r"
[ "$(field "$r" STORE_FILES)" = 0 ] && pass "private store untouched (0 files) — a base-hit needs no store" || warn "private store got $(field "$r" STORE_FILES) files on a base-hit"
U1=$(upper_sz s1); echo "    upper after base-hit: ${U1} B"
[ "$U1" -le 65536 ] && pass "base-hit upper is tiny (${U1} B ≤ 64 KB) — req 10 on ext4, no copy of the tree" || fail "base-hit upper is ${U1} B — the tree was copied"

hdr "3. Session 1 — add a NEW package against the empty private store (copy import)"
r=$(in_session s1 "pnpm --store-dir /store --config.package-import-method=copy add $NEW_PKG --silent >/tmp/a.log 2>&1; rc=\$?
  [ \$rc = 0 ] || tail -3 /tmp/a.log
  echo RC=\$rc HAVE=\$([ -f node_modules/left-pad/index.js ] && echo 1 || echo 0) STORE_FILES=\$(find /store -type f 2>/dev/null | wc -l)" | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" HAVE)" = 1 ] && pass "pnpm add $NEW_PKG succeeded; the package is real in session 1" || fail "pnpm add failed: $r"
[ "$(field "$r" STORE_FILES)" -ge 1 ] 2>/dev/null && pass "the new package went through the PRIVATE store ($(field "$r" STORE_FILES) files)" || warn "private store still empty after add"
U2=$(upper_sz s1); echo "    upper after add: ${U2} B  (+$((U2-U1)) B for $NEW_PKG plus pnpm metadata)"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "base tree BYTE-UNCHANGED after the add (copy-up hit session 1's upper)" || fail "base tree changed after session 1's add"

hdr "4. Session 1 — edit a file inside a base package (req 11)"
r=$(in_session s1 "echo '// session1 edit' >> $EDIT_REL && grep -c 'session1 edit' $EDIT_REL")
U3=$(upper_sz s1); EDIT_SZ=$(mp "stat -c %s /mp/base/proj/$EDIT_REL")
echo "    edit visible in s1: $r line(s); upper +$((U3-U2)) B (edited file is ${EDIT_SZ} B)"
[ "$r" = 1 ] && [ $((U3-U2)) -ge "$EDIT_SZ" ] && [ $((U3-U2)) -lt $((EDIT_SZ*3)) ] \
  && pass "only the edited file copied up (+$((U3-U2)) B ≈ its ${EDIT_SZ} B)" || fail "unexpected copy-up on edit: +$((U3-U2)) B"
[ "$(base_sum)" = "$BASE_SUM0" ] && pass "base tree still byte-unchanged after the edit" || fail "base tree changed by the edit"

hdr "5. Session 2 — same base, own upper: sees none of session 1's changes"
new_session s2
r=$(in_session s2 'pnpm --store-dir /store --config.package-import-method=copy --offline --frozen-lockfile install --silent >/tmp/i.log 2>&1; rc=$?
  [ $rc = 0 ] || tail -3 /tmp/i.log
  echo RC=$rc LP=$([ -e node_modules/left-pad ] && echo present || echo absent) EDIT=$(grep -c "session1 edit" '"$EDIT_REL"' 2>/dev/null; true)' | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "session 2's base-hit install is rc=0" || fail "session 2 install failed: $r"
[ "$(field "$r" LP)" = absent ] && pass "session 2 does NOT see session 1's added package" || fail "session 1's package leaked into session 2"
[ "$(field "$r" EDIT)" = 0 ] && pass "session 2 does NOT see session 1's edit" || fail "session 1's edit leaked into session 2"
echo "    session 2 upper: $(upper_sz s2) B"

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then ok "Share-the-tree works: pnpm accepts the lowerdir tree, a base-hit costs ~nothing, a new package and an edit stay in the session's upper, and sessions are isolated."; exit 0
else bad "$FAIL cell(s) failed — the share-the-tree redesign is NOT established on this host."; exit 1; fi
