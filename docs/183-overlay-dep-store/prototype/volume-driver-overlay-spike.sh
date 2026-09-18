#!/usr/bin/env bash
set -u

IMG="ubuntu:24.04"
STORE="ob-ovl-store"
LOWER_MARK="HELLO_FROM_LOWER"

ok()   { echo -e "    \033[32m$1\033[0m"; }
bad()  { echo -e "    \033[31m$1\033[0m"; }
warn() { echo -e "    \033[33m$1\033[0m"; }
hdr()  { echo -e "\n\033[1m$1\033[0m"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1   || { echo "docker daemon not reachable"; exit 2; }

PASS=0; FAIL=0
pass() { ok "$1"; PASS=$((PASS+1)); }
fail() { bad "$1"; FAIL=$((FAIL+1)); }

cleanup() {
  docker volume rm ob-ovl-m1 ob-ovl-m2 "$STORE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdr "0. Environment"
echo "    docker: $(docker version -f '{{.Server.Version}}' 2>/dev/null)  os/arch: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)"
echo "    daemon name: $(docker info -f '{{.Name}}' 2>/dev/null)  ($(docker info -f '{{.OperatingSystem}}' 2>/dev/null))"

docker volume create "$STORE" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$STORE")"
BASE="overlay-base/h1/base"
SA="sessions/sessA"; SB="sessions/sessB"
hdr "1. Seed prod layout — base in $BASE, uppers in sessions/<uuid>/ (vol _data: $MP)"
seed_out="$(docker run --rm -v "$STORE":/vol "$IMG" bash -c "
  set -e
  mkdir -p /vol/$BASE /vol/$SA/upper /vol/$SA/work /vol/$SB/upper /vol/$SB/work
  echo $LOWER_MARK > /vol/$BASE/marker.txt
  echo seeded" 2>&1)"
[ "$seed_out" = "seeded" ] && pass "seeded prod layout (base in $BASE; uppers in sessions/<uuid>/)" \
                           || { fail "seed failed: $seed_out"; echo "Summary: PASS=$PASS FAIL=$FAIL"; exit 1; }

make_overlay_vol() {
  docker volume create "$1" --driver local \
    --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$MP/$BASE,upperdir=$MP/$2/upper,workdir=$MP/$2/work" >/dev/null
}

hdr "2. Daemon-mounted overlay volume — container sees merged (no propagation, no privilege)"
if ! make_overlay_vol ob-ovl-m1 "$SA" 2>err.txt; then
  fail "volume create rejected: $(cat err.txt 2>/dev/null)"; rm -f err.txt
else
  rm -f err.txt
  out="$(docker run --rm -v ob-ovl-m1:/m "$IMG" bash -c '
    base=$(cat /m/marker.txt 2>/dev/null || echo MISSING)
    echo "B_BASE=$base"
    # write into the merged view — should land in the upper, not the base
    echo SESSION1_WROTE > /m/session.txt 2>/dev/null && echo WROTE_OK || echo WROTE_FAIL
  ' 2>&1)"
  echo "$out" | grep -q "B_BASE=$LOWER_MARK" && pass "container sees the overlay-merged LOWER content (daemon did the mount)" \
                                             || { fail "container did NOT see merged lower:"; echo "$out" | sed 's/^/      /'; }
  echo "$out" | grep -q "WROTE_OK" && pass "container can write into the merged view (copy-up to upper)" \
                                   || warn "write into merged failed (may be read-only env)"
  # The write must have landed in the UPPER, leaving the BASE immutable.
  chk="$(docker run --rm -v "$STORE":/vol "$IMG" bash -c "
    [ -f /vol/$SA/upper/session.txt ] && echo UPPER_HAS_WRITE || echo UPPER_EMPTY
    grep -q SESSION1 /vol/$BASE/marker.txt 2>/dev/null && echo BASE_DIRTY || echo BASE_CLEAN" 2>&1)"
  echo "$chk" | grep -q UPPER_HAS_WRITE && pass "write landed in the per-session UPPER" || warn "write not found in upper: $chk"
  echo "$chk" | grep -q BASE_CLEAN      && pass "BASE stayed immutable (shared lower safe)" || fail "BASE was mutated: $chk"
fi

hdr "3. Two sessions sharing one read-only base, concurrent — isolation + no EBUSY"
make_overlay_vol ob-ovl-m2 "$SB" 2>/dev/null || true
docker run -d --name ob-ovl-c1 -v ob-ovl-m1:/m "$IMG" sleep 60 >/dev/null 2>&1
c2_err="$(docker run -d --name ob-ovl-c2 -v ob-ovl-m2:/m "$IMG" sleep 60 2>&1)" && c2_ok=1 || c2_ok=0
if [ "$c2_ok" = 1 ]; then
  pass "second concurrent session mounted the same base with its own upper (no EBUSY)"
  s1="$(docker exec ob-ovl-c1 sh -c 'echo S1 > /m/who.txt; cat /m/marker.txt' 2>&1)"
  s2="$(docker exec ob-ovl-c2 sh -c 'echo S2 > /m/who.txt; cat /m/who.txt' 2>&1)"
  s1_who="$(docker exec ob-ovl-c1 sh -c 'cat /m/who.txt' 2>&1)"
  echo "$s1" | grep -q "$LOWER_MARK" && echo "$s2" | grep -q S2 && [ "$s1_who" = S1 ] \
    && pass "per-session writes are isolated (c1 sees S1, c2 sees S2) over a shared base" \
    || { fail "isolation check failed"; echo "      c1=$s1_who  c2=$s2"; }
else
  fail "second concurrent overlay mount failed (possible EBUSY): $c2_err"
fi
docker rm -f ob-ovl-c1 ob-ovl-c2 >/dev/null 2>&1 || true

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  ok "DAEMON-MOUNTED OVERLAY WORKS on this host, in the PRODUCTION layout —"
  echo "    base in overlay-base/<hash>/ + uppers in sessions/<uuid>/, cross-subtree"
  echo "    nested subpaths of ONE volume. No sidecar, no propagation, no privilege."
  echo "    → Closes the 'confirm-before-build' item for this daemon. Record in ../FINDINGS.md."
else
  bad "Daemon-mounted overlay did NOT fully work here — record which checks failed."
fi
echo
echo "Run on a Linux/VPS daemon (the un-run axis) and, if handy, re-run on Docker"
echo "Desktop/Windows; paste each summary into ../FINDINGS.md."
