#!/usr/bin/env bash
# PROTOTYPE — ONE `type=overlay` volume shared across MANY containers (docs/183, Open Q #4).
#
# WHY THIS EXISTS — the gap volume-driver-overlay-spike.sh does NOT cover.
# That spike's concurrency test uses TWO DIFFERENT overlay volumes that share one
# read-only lowerdir (each its own upper). The compose/preview solution needs the
# OPPOSITE: ONE per-session overlay volume mounted into N containers (the agent
# container + every compose dev-server service). Compose services mount the
# workspace as a Subpath of one `external` named volume today (compose-generator.ts:
# 651-655) — for an overlay session that volume becomes `type=overlay`, shared.
#
# The unproven question this answers:
#   When N containers reference ONE `local` `type=overlay` volume and their FIRST
#   use races, does Docker perform `mount -t overlay` exactly ONCE (then bind-mount
#   the volume's _data into the rest), with NO EBUSY / "upperdir is in-use"?
#   Docker's per-volume store lock SHOULD serialize this (it does for every local
#   volume), but `type=overlay` under concurrent first-use must be shown empirically
#   on every target, since EBUSY is kernel/storage-driver-dependent.
#
# GREEN = exactly ONE overlay superblock for the upper while N containers attach
#         + ZERO errors across COLD_TRIALS cold-race iterations
#         + cross-container write coherence + inotify in a NON-triggering container
#         + teardown<->startup overlap leaves the merged view intact.
# Record the per-host summary in ../FINDINGS.md next to the other verdicts.
#
# Run on a Docker host:  bash shared-volume-spike.sh
#   Same script on Linux/VPS, Docker Desktop/Mac, Docker Desktop/Windows-WSL2.
#   Tunable:  COLD_TRIALS=50 bash shared-volume-spike.sh   (default 25)
#
# The consumer containers are UNPRIVILEGED (the daemon does the mount), matching
# ShipIt's orchestrator model. The only privileged container is the mount-table
# probe (`--pid=host` to read the daemon namespace's /proc/1/mountinfo) — a
# diagnostic, not part of the production path.
set -u

IMG="ubuntu:24.04"
ALPINE="alpine:3.20"          # busybox inotifyd, dependency-free
STORE="ob-shared-store"       # scratch named volume holding base/upper/work
OVL="ob-shared-ovl"           # the ONE shared type=overlay volume under test
LOWER_MARK="HELLO_FROM_LOWER"
COLD_TRIALS="${COLD_TRIALS:-25}"

ok()   { echo -e "    \033[32m$1\033[0m"; }
bad()  { echo -e "    \033[31m$1\033[0m"; }
warn() { echo -e "    \033[33m$1\033[0m"; }
hdr()  { echo -e "\n\033[1m$1\033[0m"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1   || { echo "docker daemon not reachable"; exit 2; }

PASS=0; FAIL=0
pass() { ok "$1"; PASS=$((PASS+1)); }
fail() { bad "$1"; FAIL=$((FAIL+1)); }

CONTAINERS="ob-shared-agent ob-shared-svc1 ob-shared-svc2 ob-shared-new"
cleanup() {
  docker rm -f $CONTAINERS >/dev/null 2>&1 || true
  docker volume rm "$OVL" "$STORE" >/dev/null 2>&1 || true
  rm -f err.txt
}
trap cleanup EXIT

hdr "0. Environment"
echo "    docker: $(docker version -f '{{.Server.Version}}' 2>/dev/null)  os/arch: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)"
echo "    daemon: $(docker info -f '{{.Name}}' 2>/dev/null)  ($(docker info -f '{{.OperatingSystem}}' 2>/dev/null))  cold-trials=$COLD_TRIALS"

# --- Seed the production layout in one workspace-like volume -----------------
docker volume create "$STORE" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$STORE")"
BASE="overlay-base/h1/base"          # lowerdir subtree (never mounted into a session)
SESS="sessions/sessA"                # ONE session's upper/work — shared by all consumers
UPPER="$MP/$SESS/upper"
hdr "1. Seed prod layout — base in $BASE, one upper in $SESS (vol _data: $MP)"
seed_out="$(docker run --rm -v "$STORE":/vol "$IMG" bash -c "
  set -e
  mkdir -p /vol/$BASE /vol/$SESS/upper /vol/$SESS/work
  echo $LOWER_MARK > /vol/$BASE/marker.txt
  echo seeded" 2>&1)"
[ "$seed_out" = "seeded" ] && pass "seeded prod layout (base + one session upper)" \
                           || { fail "seed failed: $seed_out"; echo "Summary: PASS=$PASS FAIL=$FAIL"; exit 1; }

# Create the ONE shared overlay volume (absolute daemon-host paths, like prod).
make_shared_overlay() {
  docker volume create "$OVL" --driver local \
    --opt type=overlay --opt device=overlay \
    --opt "o=lowerdir=$MP/$BASE,upperdir=$UPPER,workdir=$MP/$SESS/work" >/dev/null
}

# Probe the DAEMON namespace's mount table and count DISTINCT overlay superblocks
# (mountinfo field 3 = major:minor) that use our upperdir. Bind-mounts of an
# already-overlay-mounted _data SHARE the superblock (count stays 1); a second
# independent `mount -t overlay` over the same upper would be a NEW superblock
# (count >= 2) — which is exactly the failure mode. `--pid=host` reads PID 1's
# mountinfo: the real host on Linux, the daemon VM on Docker Desktop.
count_overlay_superblocks() {
  docker run --rm --privileged --pid=host "$ALPINE" sh -c \
    "grep -F 'upperdir=$UPPER' /proc/1/mountinfo 2>/dev/null | awk '{print \$3}' | sort -u | wc -l" \
    2>/dev/null | tr -d '[:space:]'
}

# === A. ONE volume, THREE concurrent containers (agent + 2 services) =========
hdr "A. One shared overlay volume mounted into 3 concurrent containers"
if ! make_shared_overlay 2>err.txt; then
  fail "shared overlay volume create rejected: $(cat err.txt 2>/dev/null)"
else
  # Launch all three as simultaneously as possible (background, no inter-start delay).
  a_err=""; s1_err=""; s2_err=""
  docker run -d --name ob-shared-agent -v "$OVL":/workspace "$IMG" sleep 120 >/dev/null 2>a_err.txt &
  docker run -d --name ob-shared-svc1  -v "$OVL":/workspace "$IMG" sleep 120 >/dev/null 2>s1_err.txt &
  docker run -d --name ob-shared-svc2  -v "$OVL":/workspace "$IMG" sleep 120 >/dev/null 2>s2_err.txt &
  wait
  starts_ok=1
  for f in a_err s1_err s2_err; do
    if [ -s "$f.txt" ]; then starts_ok=0; warn "  $f: $(cat "$f.txt")"; fi
  done
  rm -f a_err.txt s1_err.txt s2_err.txt
  up="$(docker ps --filter 'name=ob-shared-' --format '{{.Names}}' | sort | tr '\n' ' ')"
  if [ "$starts_ok" = 1 ] && echo "$up" | grep -q "ob-shared-agent" \
     && echo "$up" | grep -q "ob-shared-svc1" && echo "$up" | grep -q "ob-shared-svc2"; then
    pass "all 3 containers mounted the SAME overlay volume concurrently (no EBUSY/upperdir-in-use)"
  else
    fail "concurrent start failed — up=[$up]"
  fi

  # The decisive check: exactly ONE overlay superblock for the upper.
  sb="$(count_overlay_superblocks)"
  if [ "$sb" = "1" ]; then
    pass "exactly ONE overlay mount (superblock) backs all 3 containers — daemon mounted once + bind-shared"
  else
    fail "expected 1 overlay superblock for the upper, found '$sb' (>=2 => independent overlay mounts — the failure mode)"
  fi

  # Cross-container write coherence: agent writes -> services see it; service writes -> agent sees it.
  docker exec ob-shared-agent sh -c 'echo FROM_AGENT > /workspace/agent.txt' >/dev/null 2>&1
  seen_s1="$(docker exec ob-shared-svc1 sh -c 'cat /workspace/agent.txt 2>/dev/null' 2>&1)"
  docker exec ob-shared-svc2 sh -c 'echo FROM_SVC2 > /workspace/svc2.txt' >/dev/null 2>&1
  seen_ag="$(docker exec ob-shared-agent sh -c 'cat /workspace/svc2.txt 2>/dev/null' 2>&1)"
  base_in_svc="$(docker exec ob-shared-svc1 sh -c 'cat /workspace/marker.txt 2>/dev/null' 2>&1)"
  [ "$seen_s1" = "FROM_AGENT" ] && [ "$seen_ag" = "FROM_SVC2" ] \
    && pass "writes are coherent across containers (agent<->service see each other's files)" \
    || { fail "write coherence failed"; echo "      svc1 saw='$seen_s1'  agent saw='$seen_ag'"; }
  echo "$base_in_svc" | grep -q "$LOWER_MARK" \
    && pass "service container reads lowerdir content through the shared merged view" \
    || fail "service did not see lowerdir base content: '$base_in_svc'"

  # HMR substrate = POLLING, not inotify. Dev servers run in a SEPARATE container,
  # and inotify does NOT cross the mount-namespace boundary between containers
  # (shipit-docs/compose.md) — so today AND under overlay, HMR uses polling
  # (usePolling / WATCHPACK_POLLING in the templates). What polling needs is that a
  # file the agent creates/modifies becomes visible — fresh content + an updated
  # mtime — to the service container's repeated stat()/read(). THAT is the gate.
  docker exec ob-shared-agent sh -c 'echo poll1 > /workspace/pollprobe.txt' >/dev/null 2>&1
  m1="$(docker exec ob-shared-svc1 sh -c 'stat -c %Y /workspace/pollprobe.txt 2>/dev/null' 2>&1)"
  docker exec ob-shared-agent sh -c 'sleep 1; echo poll2 >> /workspace/pollprobe.txt' >/dev/null 2>&1
  c2="$(docker exec ob-shared-svc1 sh -c 'cat /workspace/pollprobe.txt 2>/dev/null' 2>&1)"
  m2="$(docker exec ob-shared-svc1 sh -c 'stat -c %Y /workspace/pollprobe.txt 2>/dev/null' 2>&1)"
  echo "$c2" | grep -q poll2 && [ -n "$m1" ] && [ -n "$m2" ] && [ "$m2" -ge "$m1" ] \
    && pass "service sees fresh writes + updated mtime through the shared mount (the HMR POLLING substrate)" \
    || { fail "polling substrate failed — svc content='$c2' mtimes='$m1'->'$m2'"; }

  # BONUS, NEVER gating: native cross-container inotify. HMR does NOT rely on this
  # (it polls), and the namespace boundary is unchanged from today — so a MISS here
  # is EXPECTED and not a failure. Recorded only as a data point.
  docker exec -d ob-shared-svc1 sh -c 'timeout 6 inotifyd - /workspace 2>/dev/null > /tmp/ev.log' 2>/dev/null
  sleep 1
  docker exec ob-shared-agent sh -c 'echo hmr > /workspace/hmrprobe.txt' >/dev/null 2>&1
  sleep 2
  ev="$(docker exec ob-shared-svc1 sh -c 'cat /tmp/ev.log 2>/dev/null' 2>&1)"
  echo "$ev" | grep -q "hmrprobe.txt" \
    && warn "(info) cross-container inotify DID fire here — bonus, not required (HMR polls)" \
    || warn "(info) cross-container inotify did NOT fire — EXPECTED; HMR uses polling, so NOT a blocker"
  docker rm -f ob-shared-agent ob-shared-svc1 ob-shared-svc2 >/dev/null 2>&1 || true
fi

# === B. Cold-race stress: COLD_TRIALS iterations from a fresh volume each time =
hdr "B. Cold-race stress — $COLD_TRIALS trials, fresh volume each, racing first-use"
race_fail=0
for i in $(seq 1 "$COLD_TRIALS"); do
  docker volume rm "$OVL" >/dev/null 2>&1 || true
  make_shared_overlay 2>/dev/null || { race_fail=$((race_fail+1)); continue; }
  e1=""; e2=""; e3=""
  docker run -d --rm --name ob-shared-agent -v "$OVL":/workspace "$IMG" sleep 5 >/dev/null 2>e1.txt &
  docker run -d --rm --name ob-shared-svc1  -v "$OVL":/workspace "$IMG" sleep 5 >/dev/null 2>e2.txt &
  docker run -d --rm --name ob-shared-svc2  -v "$OVL":/workspace "$IMG" sleep 5 >/dev/null 2>e3.txt &
  wait
  for f in e1 e2 e3; do
    if [ -s "$f.txt" ]; then
      race_fail=$((race_fail+1))
      warn "  trial $i $f: $(cat "$f.txt" | tr '\n' ' ')"
    fi
  done
  rm -f e1.txt e2.txt e3.txt
  docker rm -f ob-shared-agent ob-shared-svc1 ob-shared-svc2 >/dev/null 2>&1 || true
done
[ "$race_fail" -eq 0 ] \
  && pass "$COLD_TRIALS cold-race trials, 0 EBUSY/upperdir-in-use across all concurrent first-mounts" \
  || fail "$race_fail/$COLD_TRIALS cold-race trials hit a mount error (see warnings above)"

# === C. Teardown <-> startup overlap =========================================
hdr "C. Teardown<->startup overlap — drop one consumer while adding another"
docker volume rm "$OVL" >/dev/null 2>&1 || true
make_shared_overlay 2>/dev/null
docker run -d --name ob-shared-agent -v "$OVL":/workspace "$IMG" sleep 60 >/dev/null 2>&1
docker run -d --name ob-shared-svc1  -v "$OVL":/workspace "$IMG" sleep 60 >/dev/null 2>&1
# Stop one consumer and start a new one in the same instant.
docker stop -t 0 ob-shared-svc1 >/dev/null 2>&1 &
new_err="$(docker run -d --name ob-shared-new -v "$OVL":/workspace "$IMG" sleep 60 2>&1)" && new_ok=1 || new_ok=0
wait
if [ "$new_ok" = 1 ]; then
  merged="$(docker exec ob-shared-new sh -c 'cat /workspace/marker.txt 2>/dev/null' 2>&1)"
  sb="$(count_overlay_superblocks)"
  echo "$merged" | grep -q "$LOWER_MARK" && [ "$sb" = "1" ] \
    && pass "new consumer mounted cleanly during teardown; merged view intact; still 1 superblock" \
    || { fail "overlap left a bad state — merged='$merged' superblocks='$sb'"; }
else
  fail "starting a consumer during teardown failed: $new_err"
fi
docker rm -f ob-shared-agent ob-shared-svc1 ob-shared-new >/dev/null 2>&1 || true

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL  (host: $(docker info -f '{{.OperatingSystem}}' 2>/dev/null), cold-trials=$COLD_TRIALS)"
if [ "$FAIL" -eq 0 ]; then
  ok "SHARED type=overlay VOLUME ACROSS N CONTAINERS WORKS on this host —"
  echo "    one daemon overlay mount, bind-shared into every consumer, no EBUSY."
  echo "    => Retires Open Q #4 for this target. Record in ../FINDINGS.md; run on the"
  echo "       other two targets (VPS/ext4, Docker Desktop/Mac, Docker Desktop/Windows)."
else
  bad "Shared-volume overlay did NOT fully work here — record which checks failed in ../FINDINGS.md."
  echo "    If superblock count >= 2 or cold-race hit EBUSY, the shared-volume solution"
  echo "    needs rework before compose/preview support can ship for overlay sessions."
fi
echo
