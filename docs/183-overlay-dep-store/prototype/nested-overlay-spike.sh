#!/usr/bin/env bash
# PROTOTYPE — nested overlay volume under the /workspace bind (docs/183, dep-dir design).
#
# WHY THIS EXISTS. The earlier spikes (volume-driver-overlay-spike.sh,
# shared-volume-spike.sh) proved the daemon-performed `type=overlay` volume at
# the /workspace **root** — the whole-workspace design. The design then pivoted to
# the DEPENDENCY-DIRECTORY model: /workspace stays a normal bind mount (the host
# clone — source + .git, authoritative), and EACH declared dep dir is a SEPARATE
# `type=overlay` volume mounted at a NESTED subpath:
#
#     /workspace                         <- bind (host clone: source + .git)
#     /workspace/node_modules            <- overlay volume  (base + per-session upper)
#     /workspace/packages/app/node_modules <- another overlay volume
#
# Nothing in the prior runs exercised an overlay volume mounted onto a SUBDIRECTORY
# of an already-mounted parent. That is the one unproven topology gating the dep-dir
# mount wiring. This spike answers, per host:
#
#   1. Does the daemon mount a `type=overlay` volume cleanly at a path nested under
#      another mount, and does the merged (lower+upper) view appear there?
#   2. Do source + .git on the parent bind COEXIST with the nested overlay?
#   3. Copy-up isolation: writes under the dep dir land in the per-session UPPER
#      (base immutable); writes to source land on the BIND, never in the dep upper.
#   4. Multiple dep dirs at DIFFERENT nesting depths merge simultaneously, and the
#      daemon auto-creates an absent leaf mountpoint (e.g. packages/app/node_modules).
#   5. Two sessions share one read-only base via nested overlays — no EBUSY.
#   6. ONE per-session overlay volume refcount-shares across agent + service
#      containers WHILE nested (the compose/preview pattern, under nesting).
#   7. (native Linux only) the same, with a REAL host bind as the parent — the exact
#      prod VPS topology.
#
# Run on a Docker host:  bash nested-overlay-spike.sh
#   Runs the SAME on Linux/VPS, Docker Desktop/Mac, Docker Desktop/Windows-WSL2.
#   Rungs 2–6 use named volumes for the parent (portable everywhere) — the nesting
#   mechanism is identical whether the parent is a bind or a volume (the daemon
#   orders mounts by destination depth and mounts parent-then-child regardless).
#   Rung 7 adds the real-bind parent on native Linux to nail the literal VPS case.
#
# No --privileged anywhere: the daemon performs every overlay mount; our containers
# stay unprivileged (matches ShipIt's orchestrator model). Paste each host's summary
# into ../FINDINGS.md next to the other overlay verdicts.
set -u

IMG="ubuntu:24.04"
BIND="dn-bind"                 # named volume standing in for the host clone (-> /workspace)
STORE="dn-store"               # named volume holding overlay base/upper/work subtrees (opts only)
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
cleanup  # clear any leftovers from a prior aborted run

hdr "0. Environment"
DOCKER_OS="$(docker info -f '{{.OperatingSystem}}' 2>/dev/null)"
echo "    docker: $(docker version -f '{{.Server.Version}}' 2>/dev/null)  os/arch: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)"
echo "    daemon name: $(docker info -f '{{.Name}}' 2>/dev/null)  ($DOCKER_OS)"
IS_DESKTOP=0
case "$DOCKER_OS" in *"Docker Desktop"*) IS_DESKTOP=1 ;; esac

# 1. Seed. BIND = the clone stand-in (source + .git + an empty node_modules leaf +
#    a packages/app dir WITHOUT a node_modules leaf, to test leaf auto-creation).
#    STORE = the overlay subtrees (bases + per-session uppers/works) referenced by
#    the overlay `o=` opts via STORE's daemon-host mountpoint; plus a `clone/` copy
#    for the native-Linux real-bind rung.
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

# Helper: create a local-driver overlay volume from STORE-relative subpaths.
make_ovl() { # name  lowerSub  upperSub  workSub
  docker volume create "$1" --driver local \
    --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$MP/$2,upperdir=$MP/$3,workdir=$MP/$4" >/dev/null
}

# 2. Single nested overlay at /workspace/node_modules, parent = BIND volume.
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

# 3. Copy-up isolation — dep write -> overlay upper (base clean); source write -> bind.
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

# 4. Multiple dep dirs at different depths + absent-leaf auto-create.
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

# Data point (non-gating): does the daemon also auto-create an absent PARENT chain?
make_ovl dn-ghost overlay-base/nm sessions/ghost/nm-upper sessions/ghost/nm-work 2>/dev/null || true
gout="$(docker run --rm -v "$BIND":/workspace -v dn-ghost:/workspace/ghost/deep/node_modules "$IMG" \
  bash -c 'cat /workspace/ghost/deep/node_modules/marker.txt 2>/dev/null || echo MISSING' 2>&1)"
if echo "$gout" | grep -q "$NM_LOWER"; then
  warn "DATA: daemon also mkdir -p'd an absent PARENT chain (/workspace/ghost/deep/...). Prod should still"
  warn "      resolve dep dirs against the host clone so the parent is real — note for the validator."
else
  warn "DATA: absent-parent mount did not surface the lower (got: $gout) — prod must pre-create parents."
fi

# 5. Two sessions share one read-only base via nested overlays — no EBUSY.
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

# 6. One overlay volume refcount-shared across agent + service, WHILE nested.
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

# 7. Native-Linux only: REAL host bind as the parent (the literal prod VPS topology).
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
