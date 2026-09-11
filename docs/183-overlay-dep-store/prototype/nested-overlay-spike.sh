#!/usr/bin/env bash
set -u

IMG="ubuntu:24.04"
BIND="dn-bind"
STORE="dn-store"
NM_LOWER="NM_FROM_LOWER"
PKG_LOWER="PKG_FROM_LOWER"
SRC_MARK="SOURCE_ON_BIND"

ok()   { echo -e "    \033[32m$1\033[0m"; }
bad()  { echo -e "    \033[31m$1\033[0m"; }
warn() { echo -e "    \033[33m$1\033[0m"; }
hdr()  { echo -e "\n\033[1m$1\033[0m"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1   || { echo "docker daemon not reachable"; exit 2; }

PASS=0; FAIL=0
pass() { ok "$1"; PASS=$((PASS+1)); }
fail() { bad "$1"; FAIL=$((FAIL+1)); }

ALL_VOLS="$BIND $STORE dn-nm-A dn-nm-B dn-pkg-A dn-ghost dn-nm-BIND"
ALL_CONS="dn-c1 dn-c2 dn-svc dn-agt"
cleanup() {
  docker rm -f $ALL_CONS >/dev/null 2>&1 || true
  docker volume rm $ALL_VOLS >/dev/null 2>&1 || true
  rm -f dn-err.txt
}
trap cleanup EXIT
cleanup

hdr "0. Environment"
DOCKER_OS="$(docker info -f '{{.OperatingSystem}}' 2>/dev/null)"
echo "    docker: $(docker version -f '{{.Server.Version}}' 2>/dev/null)  os/arch: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)"
echo "    daemon name: $(docker info -f '{{.Name}}' 2>/dev/null)  ($DOCKER_OS)"
IS_DESKTOP=0
case "$DOCKER_OS" in *"Docker Desktop"*) IS_DESKTOP=1 ;; esac

docker volume create "$BIND"  >/dev/null
docker volume create "$STORE" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$STORE")"
hdr "1. Seed — bind(clone) in $BIND, overlay base/upper/work in $STORE (_data: $MP)"
seed_out="$(docker run --rm -v "$BIND":/b -v "$STORE":/s "$IMG" bash -c "
  set -e
  # --- the clone stand-in (parent bind) ---
  mkdir -p /b/src /b/node_modules /b/packages/app /b/.git
  echo $SRC_MARK > /b/src/app.js
  echo 'ref: refs/heads/main' > /b/.git/HEAD
  # node_modules leaf exists (present mountpoint); packages/app/node_modules does NOT (auto-create test)
  # --- overlay subtrees in STORE ---
  mkdir -p /s/overlay-base/nm /s/overlay-base/pkg
  echo $NM_LOWER  > /s/overlay-base/nm/marker.txt
  echo $PKG_LOWER > /s/overlay-base/pkg/marker.txt
  for d in sessA sessB ghost bindrun; do mkdir -p /s/sessions/\$d/nm-upper /s/sessions/\$d/nm-work; done
  mkdir -p /s/sessions/sessA/pkg-upper /s/sessions/sessA/pkg-work
  # a clone copy for the real-bind rung (native Linux can bind STORE/_data/clone)
  mkdir -p /s/clone/src /s/clone/node_modules /s/clone/.git
  echo $SRC_MARK > /s/clone/src/app.js
  echo 'ref: refs/heads/main' > /s/clone/.git/HEAD
  echo seeded" 2>&1)"
[ "$seed_out" = "seeded" ] && pass "seeded bind(clone) + overlay subtrees" \
                          || { fail "seed failed: $seed_out"; echo "Summary: PASS=$PASS FAIL=$FAIL"; exit 1; }

make_ovl() {
  docker volume create "$1" --driver local \
    --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$MP/$2,upperdir=$MP/$3,workdir=$MP/$4" >/dev/null
}

hdr "2. Nested overlay under /workspace — merged dep view + source/.git coexist"
if ! make_ovl dn-nm-A overlay-base/nm sessions/sessA/nm-upper sessions/sessA/nm-work 2>dn-err.txt; then
  fail "overlay volume create rejected: $(cat dn-err.txt 2>/dev/null)"
else
  out="$(docker run --rm -v "$BIND":/workspace -v dn-nm-A:/workspace/node_modules "$IMG" bash -c '
    echo "NM=$(cat /workspace/node_modules/marker.txt 2>/dev/null || echo MISSING)"
    echo "SRC=$(cat /workspace/src/app.js 2>/dev/null || echo MISSING)"
    echo "GIT=$([ -f /workspace/.git/HEAD ] && echo HAVE_GIT || echo NO_GIT)"
    echo added > /workspace/node_modules/added.js 2>/dev/null && echo NM_WROTE || echo NM_WROFAIL
    echo edited >> /workspace/src/app.js          2>/dev/null && echo SRC_WROTE || echo SRC_WROFAIL
  ' 2>&1)"
  echo "$out" | grep -q "NM=$NM_LOWER" \
    && pass "nested overlay mounts under the parent and shows the dep LOWER (daemon did the mount)" \
    || { fail "nested overlay did NOT show merged lower:"; echo "$out" | sed 's/^/      /'; }
  { echo "$out" | grep -q "SRC=$SRC_MARK" && echo "$out" | grep -q "GIT=HAVE_GIT"; } \
    && pass "source + .git on the parent COEXIST with the nested overlay (dep-dir model holds)" \
    || { fail "parent source/.git not visible alongside the nested overlay:"; echo "$out" | sed 's/^/      /'; }
  echo "$out" | grep -q NM_WROTE && echo "$out" | grep -q SRC_WROTE \
    && pass "writable in both the merged dep view and the source tree" \
    || warn "a write failed (read-only env?): $(echo "$out" | tr '\n' ' ')"
fi

hdr "3. Copy-up isolation — dep delta in the per-session UPPER, source on the BIND"
chk="$(docker run --rm -v "$STORE":/s -v "$BIND":/b "$IMG" bash -c "
  [ -f /s/sessions/sessA/nm-upper/added.js ] && echo UPPER_HAS_DEP || echo UPPER_NO_DEP
  grep -q added /s/overlay-base/nm/marker.txt 2>/dev/null && echo BASE_DIRTY || echo BASE_CLEAN
  grep -q edited /b/src/app.js 2>/dev/null && echo BIND_HAS_SRC || echo BIND_NO_SRC
  [ -e /s/sessions/sessA/nm-upper/src ] && echo UPPER_LEAKED_SRC || echo UPPER_NO_SRC_LEAK" 2>&1)"
echo "$chk" | grep -q UPPER_HAS_DEP    && pass "dep write landed in the per-session overlay UPPER" || fail "dep write not in upper: $chk"
echo "$chk" | grep -q BASE_CLEAN       && pass "shared dep BASE stayed immutable"                  || fail "BASE mutated: $chk"
echo "$chk" | grep -q BIND_HAS_SRC     && pass "source write landed on the BIND (host checkout authoritative)" || fail "source write not on bind: $chk"
echo "$chk" | grep -q UPPER_NO_SRC_LEAK && pass "source did NOT leak into the dep overlay upper"     || fail "source leaked into dep upper: $chk"

hdr "4. Two dep dirs at distinct depths merge at once; absent leaf auto-created"
make_ovl dn-pkg-A overlay-base/pkg sessions/sessA/pkg-upper sessions/sessA/pkg-work 2>/dev/null || true
out4="$(docker run --rm \
  -v "$BIND":/workspace \
  -v dn-nm-A:/workspace/node_modules \
  -v dn-pkg-A:/workspace/packages/app/node_modules "$IMG" bash -c '
    echo "NM=$(cat /workspace/node_modules/marker.txt 2>/dev/null || echo MISSING)"
    echo "PKG=$(cat /workspace/packages/app/node_modules/marker.txt 2>/dev/null || echo MISSING)"
  ' 2>&1)"
{ echo "$out4" | grep -q "NM=$NM_LOWER" && echo "$out4" | grep -q "PKG=$PKG_LOWER"; } \
  && pass "two overlays at /node_modules and /packages/app/node_modules merge simultaneously; daemon auto-created the absent leaf" \
  || { fail "multi-depth nested mount failed:"; echo "$out4" | sed 's/^/      /'; }

make_ovl dn-ghost overlay-base/nm sessions/ghost/nm-upper sessions/ghost/nm-work 2>/dev/null || true
gout="$(docker run --rm -v "$BIND":/workspace -v dn-ghost:/workspace/ghost/deep/node_modules "$IMG" \
  bash -c 'cat /workspace/ghost/deep/node_modules/marker.txt 2>/dev/null || echo MISSING' 2>&1)"
if echo "$gout" | grep -q "$NM_LOWER"; then
  warn "DATA: daemon also mkdir -p'd an absent PARENT chain (/workspace/ghost/deep/...). Prod should still"
  warn "      resolve dep dirs against the host clone so the parent is real — note for the validator."
else
  warn "DATA: absent-parent mount did not surface the lower (got: $gout) — prod must pre-create parents."
fi

hdr "5. Two sessions, one shared dep base, concurrent nested mounts — isolation + no EBUSY"
make_ovl dn-nm-B overlay-base/nm sessions/sessB/nm-upper sessions/sessB/nm-work 2>/dev/null || true
docker run -d --name dn-c1 -v "$BIND":/workspace -v dn-nm-A:/workspace/node_modules "$IMG" sleep 120 >/dev/null 2>&1
c2_err="$(docker run -d --name dn-c2 -v "$BIND":/workspace -v dn-nm-B:/workspace/node_modules "$IMG" sleep 120 2>&1)" && c2_ok=1 || c2_ok=0
if [ "$c2_ok" = 1 ]; then
  pass "second concurrent session mounted the same dep base with its own upper (no EBUSY)"
  docker exec dn-c1 sh -c 'echo C1 > /workspace/node_modules/who.txt' 2>/dev/null
  docker exec dn-c2 sh -c 'echo C2 > /workspace/node_modules/who.txt' 2>/dev/null
  w1="$(docker exec dn-c1 sh -c 'cat /workspace/node_modules/who.txt' 2>&1)"
  w2="$(docker exec dn-c2 sh -c 'cat /workspace/node_modules/who.txt' 2>&1)"
  base_ok="$(docker exec dn-c1 sh -c 'cat /workspace/node_modules/marker.txt' 2>&1)"
  { [ "$w1" = C1 ] && [ "$w2" = C2 ] && echo "$base_ok" | grep -q "$NM_LOWER"; } \
    && pass "per-session dep writes isolated (c1=C1, c2=C2) over a shared immutable base" \
    || { fail "isolation/base check failed"; echo "      c1=$w1 c2=$w2 base=$base_ok"; }
else
  fail "second concurrent nested overlay mount failed (possible EBUSY): $c2_err"
fi
docker rm -f dn-c1 dn-c2 >/dev/null 2>&1 || true

hdr "6. One dep overlay volume shared across 2 containers under nesting (compose/preview)"
docker run -d --name dn-svc -v "$BIND":/workspace -v dn-nm-A:/workspace/node_modules "$IMG" sleep 120 >/dev/null 2>&1
agt_err="$(docker run -d --name dn-agt -v "$BIND":/workspace -v dn-nm-A:/workspace/node_modules "$IMG" sleep 120 2>&1)" && agt_ok=1 || agt_ok=0
if [ "$agt_ok" = 1 ]; then
  pass "agent + service both mounted the SAME nested dep overlay (refcount share, no EBUSY)"
  docker exec dn-agt sh -c 'echo HMR > /workspace/node_modules/shared.js' 2>/dev/null
  svc_see="$(docker exec dn-svc sh -c 'cat /workspace/node_modules/shared.js 2>/dev/null || echo MISSING' 2>&1)"
  [ "$svc_see" = HMR ] \
    && pass "service sees the agent's fresh dep write through the shared nested overlay (HMR-poll substrate)" \
    || fail "service did not see the agent's write (got: $svc_see)"
else
  fail "second container on the shared nested overlay failed: $agt_err"
fi
docker rm -f dn-svc dn-agt >/dev/null 2>&1 || true

hdr "7. Real host-bind parent (native Linux) — nested overlay under a true bind mount"
if [ "$IS_DESKTOP" = 1 ]; then
  warn "SKIPPED on Docker Desktop — the named-volume parent in rungs 2–6 already exercises the nesting"
  warn "mechanism; a host bind of the VM's volume path isn't shared into Desktop. Run this rung on the VPS."
else
  make_ovl dn-nm-BIND overlay-base/nm sessions/bindrun/nm-upper sessions/bindrun/nm-work 2>/dev/null || true
  bout="$(docker run --rm -v "$MP/clone":/workspace -v dn-nm-BIND:/workspace/node_modules "$IMG" bash -c '
    echo "NM=$(cat /workspace/node_modules/marker.txt 2>/dev/null || echo MISSING)"
    echo "SRC=$(cat /workspace/src/app.js 2>/dev/null || echo MISSING)"' 2>&1)"
  { echo "$bout" | grep -q "NM=$NM_LOWER" && echo "$bout" | grep -q "SRC=$SRC_MARK"; } \
    && pass "REAL bind parent: nested overlay merges under a host bind mount (prod VPS topology proven)" \
    || { fail "nested overlay under a real bind failed:"; echo "$bout" | sed 's/^/      /'; }
fi

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL  (host: $DOCKER_OS)"
if [ "$FAIL" -eq 0 ]; then
  ok "NESTED OVERLAY-UNDER-/workspace WORKS on this host —"
  echo "    a type=overlay volume mounts cleanly at a subpath of the workspace mount, the dep"
  echo "    merged view + copy-up isolation hold, source/.git coexist on the parent, multiple"
  echo "    depths + absent leaves work, shared bases don't EBUSY, and one dep volume refcount-"
  echo "    shares across agent + service. → This host clears the dep-dir mount-topology gate."
else
  bad "Nested overlay-under-/workspace did NOT fully work here — record which rungs failed."
  echo "    A failure here forces a dep-dir mount-topology rethink before any wiring."
fi
echo
echo "NOT covered here (validate separately): the recursive file-tree watcher descending into the"
echo "nested submount (same-namespace inotify across a mount boundary) — see host-overlay-spike.sh's"
echo "inotify rung. Run this on VPS/ext4, Docker Desktop/Mac, and Docker Desktop/Windows-WSL2; paste"
echo "each summary into ../FINDINGS.md. Green on all three is the gate to begin dep-dir mount wiring."
