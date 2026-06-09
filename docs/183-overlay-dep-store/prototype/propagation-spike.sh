#!/usr/bin/env bash
# PROTOTYPE — cross-container mount-propagation spike for docs/183.
#
# The single-namespace spikes (host-overlay-spike.sh / run-in-docker.sh) proved
# overlayfs works. They did NOT prove the thing the chosen architecture depends
# on: a *privileged sidecar* mounts an overlay inside ITS mount namespace, and a
# SEPARATE session container must see the merged result through the shared named
# volume. That requires the overlay mount to PROPAGATE to the Docker daemon's
# namespace (so the daemon replicates it into the session container's mount).
#
# This script drives everything through the `docker` CLI only (so it runs the
# same on a Linux host and on Docker Desktop / WSL2, where the daemon is in a
# VM). It runs a ladder of propagation setups and reports, per rung:
#   - VALID  : container B is looking at the SAME volume storage (sees the
#              on-disk lower file) — i.e. the rung's mount source is real here
#   - PROPAGATED : B sees the OVERLAY-merged content A mounted (the actual goal)
#
# Run on a Docker host:  bash propagation-spike.sh
#   --with-host-setup : ALSO make the daemon-host root a shared mount
#                       (mount --make-rshared / inside the host mount namespace,
#                       via a --pid=host nsenter container) and re-test the
#                       sidecar rung. This MUTATES host mount propagation — it is
#                       the standard systemd default and reversible with
#                       `mount --make-rprivate /`, but it is opt-in for that
#                       reason. Use it to confirm the fix the bare run reveals.
#
# Run it on BOTH a bare-Linux/VPS-like host AND Docker Desktop (Mac/Windows);
# the verdict can differ between them. Paste both verdicts into ../FINDINGS.md.
set -u

WITH_HOST_SETUP=0
[ "${1:-}" = "--with-host-setup" ] && WITH_HOST_SETUP=1

IMG="ubuntu:24.04"
VOL="ob-prop-vol"
LOWER_MARK="HELLO_FROM_LOWER"     # written into the overlay LOWER dir (on-disk)
A=""                              # current sidecar container name (for cleanup)

ok()   { echo -e "    \033[32m$1\033[0m"; }
bad()  { echo -e "    \033[31m$1\033[0m"; }
warn() { echo -e "    \033[33m$1\033[0m"; }
hdr()  { echo -e "\n\033[1m$1\033[0m"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }

cleanup() {
  [ -n "$A" ] && docker rm -f "$A" >/dev/null 2>&1
  docker rm -f ob-prop-A0 ob-prop-A1 ob-prop-A2 >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$VOL" >/dev/null
MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
hdr "0. Environment"
echo "    docker: $(docker version -f '{{.Server.Version}}' 2>/dev/null)  os/arch: $(docker version -f '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null)"
echo "    volume mountpoint (daemon-host path): $MP"

# Sidecar setup script: build lower/upper/work, optionally tweak propagation on
# the mount at $1 (/vol), then overlay-mount /vol/merged. Stays alive (sleep).
read -r -d '' SIDECAR_SETUP <<'EOS' || true
set -e
PROP="${PROP:-none}"
mkdir -p /vol/base /vol/up /vol/wk /vol/merged
echo "HELLO_FROM_LOWER" > /vol/base/marker.txt
case "$PROP" in
  make-rshared) mount --make-rshared /vol 2>/dev/null || echo "    (make-rshared failed)";;
esac
mount -t overlay overlay -o lowerdir=/vol/base,upperdir=/vol/up,workdir=/vol/wk /vol/merged
# Sanity inside the sidecar itself:
grep -q HELLO_FROM_LOWER /vol/merged/marker.txt && echo "SIDECAR_OVERLAY_OK" || echo "SIDECAR_OVERLAY_FAIL"
EOS

# Checker: container B reads the same volume and reports validity + propagation.
read -r -d '' CHECK <<'EOS' || true
base="$(cat /vol/base/marker.txt 2>/dev/null || echo MISSING)"
merged="$(cat /vol/merged/marker.txt 2>/dev/null || echo MISSING)"
echo "B_BASE=$base"
echo "B_MERGED=$merged"
EOS

run_rung() { # name  "docker-run-args-for-A"  "docker-run-args-for-B"  PROP
  local name="$1" a_args="$2" b_args="$3" prop="$4"
  hdr "Rung: $name"
  A="ob-prop-$name"
  docker rm -f "$A" >/dev/null 2>&1 || true
  local run_out
  # shellcheck disable=SC2086
  if ! run_out="$(docker run -d --privileged --name "$A" $a_args "$IMG" sleep 600 2>&1)"; then
    bad "sidecar container could not start:"; echo "$run_out" | sed 's/^/      /'
    echo "$run_out" | grep -q "not a shared mount" && warn "→ daemon-host root is not a shared mount; re-run with --with-host-setup"
    LAST_RESULT="invalid"; A=""; return
  fi
  local setup_out
  setup_out="$(docker exec -e PROP="$prop" "$A" bash -c "$SIDECAR_SETUP" 2>&1)"
  echo "$setup_out" | grep -q SIDECAR_OVERLAY_OK && ok "sidecar mounted overlay (sees lower)" || { bad "sidecar overlay setup failed:"; echo "$setup_out" | sed 's/^/      /'; A=""; docker rm -f "ob-prop-$name" >/dev/null 2>&1; return; }
  # Container B — a SEPARATE container, started AFTER A's mount exists.
  local out base merged
  # shellcheck disable=SC2086
  out="$(docker run --rm $b_args "$IMG" bash -c "$CHECK" 2>&1)"
  base="$(echo "$out" | sed -n 's/^B_BASE=//p')"
  merged="$(echo "$out" | sed -n 's/^B_MERGED=//p')"
  if [ "$base" = "$LOWER_MARK" ]; then ok "VALID  — B sees the same volume storage (lower file present)"
  else warn "INVALID — B is NOT looking at the same storage (lower file '$base'); rung N/A on this host"; fi
  if [ "$merged" = "$LOWER_MARK" ]; then ok "PROPAGATED ✓ — B sees the overlay-merged content (GOAL MET)"; LAST_RESULT="PROPAGATED"
  elif [ "$base" = "$LOWER_MARK" ]; then bad "NOT propagated — B sees empty /vol/merged (overlay stayed in A's namespace)"; LAST_RESULT="not-propagated"
  else LAST_RESULT="invalid"; fi
  docker rm -f "$A" >/dev/null 2>&1; A=""
}

VERDICT="none"
note() { [ "$LAST_RESULT" = "PROPAGATED" ] && VERDICT="$1"; }

# Diagnose WHY propagation isn't reaching the daemon. The usual culprit: dockerd
# runs in a DIFFERENT mount namespace than PID 1, so `make-rshared /` in PID 1
# never reaches the daemon's view. Pure /proc parsing — no extra packages.
diagnose_host() {
  hdr "Diagnostics — is the daemon even in PID 1's mount namespace?"
  docker run --rm --privileged --pid=host "$IMG" sh -c '
    p1=$(readlink /proc/1/ns/mnt); echo "    PID1     mnt ns: $p1"
    for c in dockerd containerd; do
      for d in /proc/[0-9]*; do
        [ -r "$d/comm" ] || continue
        if [ "$(cat "$d/comm" 2>/dev/null)" = "$c" ]; then
          pid=${d#/proc/}; ns=$(readlink /proc/$pid/ns/mnt)
          [ "$ns" = "$p1" ] && tag="SAME as PID1" || tag="DIFFERENT from PID1  <-- propagation gap"
          echo "    $c (pid $pid) mnt ns: $ns  [$tag]"
          break
        fi
      done
    done
    echo "    --- PID1 propagation flags (mountinfo) ---"
    awk '\''$5=="/" || $5 ~ /\/var\/lib\/docker/ {print "      "$5"  "($0 ~ /shared:/ ? "shared" : "private")}'\'' /proc/1/mountinfo | sort -u
  ' 2>&1 | sed 's/^/  /'
}

# Rung 0 — baseline: plain named-volume bind in both. Expected NOT propagated
# (Docker mounts volumes rprivate), establishing that the naive approach fails.
run_rung "A0" "-v $VOL:/vol"            "-v $VOL:/vol"            "none";          note "baseline-volume(rprivate)"

# Rung 1 — sidecar makes its own /vol rshared before mounting overlay, both use
# the named volume. Tests whether make-rshared inside the privileged container
# is enough on this host's default dockerd propagation.
run_rung "A1" "-v $VOL:/vol"            "-v $VOL:/vol"            "make-rshared";  note "named-volume + make-rshared"

# Rung 2 — the realistic sidecar path: bind the volume's daemon-host mountpoint
# with :rshared so A's overlay propagates to the host/daemon namespace; B binds
# the same host path. Requires the host subtree to be a shared mount (systemd
# hosts usually mount / rshared at boot; Docker Desktop's VM may differ).
run_rung "A2" "-v $MP:/vol:rshared"     "-v $MP:/vol:rslave"     "none";          note "host-mountpoint :rshared (sidecar pattern)"

# Rung 3 — opt-in: perform the standard host-side fix (make the daemon-host root
# a shared mount) and re-test the sidecar rung. This is what a VPS provisioner
# would do once at setup; here we apply it via a --pid=host nsenter container.
if [ "$WITH_HOST_SETUP" -eq 1 ]; then
  hdr "Host setup: mount --make-rshared / (in the daemon-host mount namespace)"
  if setup_out="$(docker run --rm --privileged --pid=host "$IMG" \
        nsenter -t 1 -m -- sh -c 'mount --make-rshared / && echo HOST_RSHARED_OK' 2>&1)"; then
    echo "$setup_out" | grep -q HOST_RSHARED_OK && ok "host root is now a shared mount" || { warn "host setup output:"; echo "$setup_out" | sed 's/^/      /'; }
  else
    warn "could not apply host setup (no --pid=host / nsenter on this daemon?):"; echo "$setup_out" | sed 's/^/      /'
  fi
  run_rung "A2" "-v $MP:/vol:rshared"   "-v $MP:/vol:rslave"     "none";          note "host-mountpoint :rshared AFTER make-rshared /"
  [ "$VERDICT" = "none" ] && diagnose_host

  # Rung 3 — the production-realistic pattern: a DEDICATED directory that is its
  # OWN self-bind mount, marked shared. The source is then a real shared
  # mountpoint (not just a dir on /), which is what dockerd's :rshared check
  # actually wants. This is also how ShipIt would lay out overlay state without
  # depending on /'s propagation or the docker data-root dir.
  hdr "Host setup: dedicated self-bind shared mount /var/obshared (provisioner-style)"
  setup_out="$(docker run --rm --privileged --pid=host "$IMG" nsenter -t 1 -m -- sh -c '
    mkdir -p /var/obshared
    mount --bind /var/obshared /var/obshared 2>/dev/null || true
    mount --make-rshared /var/obshared && echo OBSHARED_OK' 2>&1)"
  echo "$setup_out" | grep -q OBSHARED_OK && ok "/var/obshared is a shared mountpoint" || { warn "setup output:"; echo "$setup_out" | sed 's/^/      /'; }
  run_rung "A3" "-v /var/obshared:/vol:rshared" "-v /var/obshared:/vol:rslave" "none"; note "dedicated self-bind shared host dir"
  docker run --rm --privileged --pid=host "$IMG" nsenter -t 1 -m -- sh -c 'umount -R /var/obshared 2>/dev/null; rmdir /var/obshared 2>/dev/null' >/dev/null 2>&1 || true
else
  echo
  warn "Tip: if rung A2 failed with 'not a shared mount', re-run with --with-host-setup"
  warn "to apply 'mount --make-rshared /' on the daemon host and confirm the fix."
fi

hdr "Verdict"
if [ "$VERDICT" != "none" ]; then
  ok "Cross-container propagation ACHIEVED via: $VERDICT"
  echo "    → the long-lived-sidecar design is feasible on this host using that setup."
else
  bad "Cross-container propagation NOT achieved by any rung on this host."
  echo "    → needs host-side shared-mount setup (e.g. 'mount --make-rshared /' on the"
  echo "      daemon host / VM), or a different mechanism. Record this per platform."
fi
echo
echo "Run this on BOTH a bare-Linux/VPS host and Docker Desktop (Mac/Win); paste"
echo "each verdict into ../FINDINGS.md — they may differ."
