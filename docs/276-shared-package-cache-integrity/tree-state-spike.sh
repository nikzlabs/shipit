#!/usr/bin/env bash
#
# tree-state-spike.sh — three facts the tree verify-and-admit lifecycle
#   (plan.md section 5) depends on, about what pnpm does with a base it did
#   not build itself:
#
#   A. .bin shims: over a base that OMITS every .bin directory, does a genuine
#      no-op `pnpm install --offline --frozen-lockfile` (rc=0, "resolution
#      step is skipped") regenerate them? Uses a CLEAN base: a package with an
#      ignored install script makes pnpm relink and regenerate shims as a side
#      effect, which is a confound, not the answer.
#   B. carried .pnpm/lock.yaml: over a base whose lock.yaml lists a package
#      whose directory is ABSENT (an inconsistent carried state file), does
#      the session's install reinstall it (a base miss) or skip it (trust)?
#   C. carried approvals: over a base whose .modules.yaml carries
#      pendingBuilds + allowBuilds for a package, does the next session's
#      install RUN that package's script WITHOUT the session approving it?
#      pnpm 12 takes approvals from pnpm-workspace.yaml `allowBuilds`, keyed
#      by the package id (for a file: dep, "pwn@file:pwn"); the positive
#      control asserts that path works, so a negative here is real.
#
# Run on a Docker host (the "services" host). Reuses the pnpm-spike:local
# image and the make_ovl / mp() pattern of tree-overlay-spike.sh. Cells A and
# B report their fact either way (hard-asserting only that they ran); cell C
# hard-asserts the security property: a carried approval must NOT run a script.
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
ok(){ echo -e "    \033[32m$1\033[0m"; }; bad(){ echo -e "    \033[31m$1\033[0m"; }
warn(){ echo -e "    \033[33m$1\033[0m"; }; hdr(){ echo -e "\n\033[1m$1\033[0m"; }
PASS=0; FAIL=0; pass(){ ok "$1"; PASS=$((PASS+1)); }; fail(){ bad "FAIL: $1"; FAIL=$((FAIL+1)); }
finding(){ echo -e "    \033[36mFINDING: $1\033[0m"; }

command -v docker >/dev/null || { echo "docker CLI not found"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; exit 2; }
VOL="ts-store"; ALL_OVL="ts-a ts-b ts-c1 ts-c2 ts-c3"
cleanup(){ docker volume rm $ALL_OVL >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker volume create "$VOL" >/dev/null; MP="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
mp(){ docker run --rm -v "$MP":/mp "$IMG" bash -c "$1"; }
make_ovl(){ docker volume rm "$1" >/dev/null 2>&1 || true; docker volume create "$1" --driver local --opt type=overlay --opt device=overlay --opt "o=lowerdir=$2,upperdir=$3,workdir=$4" >/dev/null; }
field(){ echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }

hdr "0. Environment"; build_img
echo "    docker $(docker version -f '{{.Server.Version}}')  pnpm $(docker run --rm $IMG pnpm --version)"

# Two bases. "clean": typescript (bins tsc/tsserver) + is-odd, no install
# scripts, so a no-op install is a real no-op (rc=0). "pwn": the same plus a
# local package whose postinstall writes $MARK — an observable script.
hdr "1. Build the bases"
docker run --rm $CE -e XDG_CACHE_HOME=/mp/cache -v "$MP":/mp "$IMG" bash -c '
  for b in clean pwn; do
    mkdir -p /mp/$b/proj/pwn && cd /mp/$b/proj
    python3 - "$b" <<PY
import json,sys
b=sys.argv[1]
json.dump({"name":"pwn","version":"1.0.0","scripts":{"postinstall":"node -e \"require(\x27fs\x27).writeFileSync(process.env.MARK,\x27ran\x27)\""}},open("pwn/package.json","w"))
deps={"typescript":"5.6.3","is-odd":"3.0.1"}
if b=="pwn": deps["pwn"]="file:pwn"
json.dump({"name":"b","version":"1.0.0","dependencies":deps},open("package.json","w"))
PY
    MARK=/mp/$b/proj/PWNED pnpm --store-dir /store --config.package-import-method=copy install >/mp/$b.warm.log 2>&1; echo "$b: rc=$? bins=$(find node_modules -type d -name .bin | wc -l) ran=$([ -e /mp/$b/proj/PWNED ] && echo 1 || echo 0)"
  done'
mp 'test -d /mp/clean/proj/node_modules/.pnpm && test -d /mp/pwn/proj/node_modules/.pnpm' && pass "both bases built" || { fail "base build failed"; exit 1; }
mp 'test -e /mp/clean/proj/node_modules/.bin/tsc' && pass "clean base has node_modules/.bin/tsc" || fail "no tsc shim in the clean base"
mp 'test ! -e /mp/pwn/proj/PWNED' && pass "pwn's postinstall did NOT run at base build (pnpm 12 ignores unapproved builds)" || fail "pwn's postinstall ran unapproved at base build"

new_session(){ # $1 name  $2 base variant (clean|pwn)  $3 lowerdir host path
  mp "mkdir -p /mp/$1-up /mp/$1-wk /mp/$1-proj && cp -r /mp/$2/proj/package.json /mp/$2/proj/pnpm-lock.yaml /mp/$2/proj/pwn /mp/$1-proj/"
  make_ovl "ts-$1" "$3" "$MP/$1-up" "$MP/$1-wk"; }
in_session(){ docker run --rm $CE -e XDG_CACHE_HOME=/mp/cache -e MARK=/proj/PWNED -v "$MP/cache":/mp/cache -v "$MP/$1-proj":/proj -v "ts-$1":/proj/node_modules "$IMG" bash -c "cd /proj; $2" 2>&1; }
NOOP='pnpm --store-dir /store --config.package-import-method=copy --offline --frozen-lockfile install'

hdr "A. .bin shims — CLEAN base with every .bin directory removed, genuine no-op install"
mp 'rm -rf /mp/nobin && cp -a /mp/clean/proj/node_modules /mp/nobin && find /mp/nobin -type d -name .bin -prune -exec rm -rf {} + ; find /mp/nobin -type d -name .bin | wc -l' | tail -1 | grep -q '^0$' \
  && pass "stripped base has 0 .bin dirs" || fail "could not strip .bin dirs"
new_session a clean "$MP/nobin"
r=$(in_session a "$NOOP >/tmp/i.log 2>&1; rc=\$?; [ \$rc = 0 ] || tail -3 /tmp/i.log
  echo RC=\$rc SHIM=\$([ -e node_modules/.bin/tsc ] && echo 1 || echo 0) NOOP=\$(grep -c 'resolution step is skipped' /tmp/i.log)" | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && [ "$(field "$r" NOOP)" -ge 1 ] && pass "cell A ran as a genuine no-op (rc=0, resolution skipped)" || fail "cell A was not a clean no-op: $r"
if [ "$(field "$r" SHIM)" = 1 ]; then finding "A: pnpm regenerated node_modules/.bin/tsc on a genuine no-op — the base could omit shims."
else finding "A: pnpm did NOT regenerate .bin shims on a genuine no-op install — shims are part of the base and the verifier must check them (pnpm's shim template, pointing at an admitted package's declared bin)."; fi
echo "    upper after: $(mp 'du -sB1 /mp/a-up | cut -f1') B"

hdr "B. carried .pnpm/lock.yaml — clean base lists is-odd, but its directory is absent"
mp 'rm -rf /mp/inc && cp -a /mp/clean/proj/node_modules /mp/inc && rm -rf /mp/inc/.pnpm/is-odd@3.0.1 /mp/inc/is-odd && grep -c "is-odd" /mp/inc/.pnpm/lock.yaml' | tail -1 | grep -q '[1-9]' \
  && pass "inconsistent base: is-odd dir removed, .pnpm/lock.yaml still lists it" || fail "could not build the inconsistent base"
new_session b clean "$MP/inc"
# ONLINE (no --offline): the question is whether pnpm DECIDES to reinstall, not whether it can fetch.
r=$(in_session b 'pnpm --store-dir /store --config.package-import-method=copy --frozen-lockfile install >/tmp/i.log 2>&1; rc=$?; [ $rc = 0 ] || tail -3 /tmp/i.log
  echo RC=$rc HAVE=$([ -f node_modules/is-odd/index.js ] && echo 1 || echo 0) STORE=$(find /store -type f 2>/dev/null | wc -l)' | tail -1)
echo "    $r"
[ "$(field "$r" RC)" = 0 ] && pass "cell B ran (rc=0)" || fail "cell B install failed: $r"
if [ "$(field "$r" HAVE)" = 1 ]; then finding "B: pnpm REINSTALLED the missing package into the upper (store files=$(field "$r" STORE)) — an inconsistent carried lock.yaml self-heals as a base miss; it is not a trust problem."
else finding "B: pnpm did NOT reinstall the missing package — it trusts the carried lock.yaml; the base's lock.yaml must be consistent with its tree."; fi

hdr "C. carried approvals — pwn base with pendingBuilds + allowBuilds in .modules.yaml"
mp 'rm -rf /mp/pend && cp -a /mp/pwn/proj/node_modules /mp/pend && python3 - <<PY
import json
p="/mp/pend/.modules.yaml"; d=json.load(open(p))
d["allowBuilds"]={"pwn@file:pwn":True}; d["pendingBuilds"]=["pwn@file:pwn"]; d["ignoredBuilds"]=[]
json.dump(d,open(p,"w"),indent=2); print("carried: allowBuilds",d["allowBuilds"],"pendingBuilds",d["pendingBuilds"])
PY' | tail -1
APPROVE='printf "allowBuilds:\n  \"pwn@file:pwn\": true\n" > pnpm-workspace.yaml'
# C1 — the property: carried approvals, session does NOT approve → must not run
new_session c1 pwn "$MP/pend"
r=$(in_session c1 "rm -f /proj/PWNED; $NOOP >/tmp/i.log 2>&1; rc=\$?
  echo RC=\$rc RAN=\$([ -e /proj/PWNED ] && echo 1 || echo 0) ERR=\$(grep -o 'ERR_PNPM_[A-Z_]*' /tmp/i.log | head -1)" | tail -1)
echo "    C1 carried, no session approval: $r"
[ "$(field "$r" RAN)" = 0 ] && pass "C1: a carried allowBuilds/pendingBuilds did NOT run the script without the session's approval" || fail "C1: the carried approval RAN a script in the next session — the lifecycle's allowBuilds/pendingBuilds reset is not enough"
# C2 — positive control: session approves (pnpm 12 form), same carried base → must run, else C1 is meaningless
new_session c2 pwn "$MP/pend"
r=$(in_session c2 "rm -f /proj/PWNED; $APPROVE; $NOOP >/tmp/i.log 2>&1; rc=\$?
  echo RC=\$rc RAN=\$([ -e /proj/PWNED ] && echo 1 || echo 0) MSG=\$(grep -o 'postinstall: Done' /tmp/i.log | head -1 | tr ' ' _)" | tail -1)
echo "    C2 carried + session approval:  $r"
[ "$(field "$r" RAN)" = 1 ] && pass "C2 control: the session's own approval DOES run the script over the same base — the approval path works, so C1 is a real negative" || fail "C2 control failed to run the script — C1 is inconclusive"
# C3 — already-linked package (plain pwn base, nothing pending), session approves: does a later approval run it?
new_session c3 pwn "$MP/pwn/proj/node_modules"
r=$(in_session c3 "rm -f /proj/PWNED; $APPROVE; $NOOP >/tmp/i.log 2>&1; rc=\$?; RAN1=\$([ -e /proj/PWNED ] && echo 1 || echo 0)
  rm -f /proj/PWNED; pnpm --store-dir /store rebuild >/tmp/r.log 2>&1; rc2=\$?
  echo RC=\$rc RAN_INSTALL=\$RAN1 RC_REBUILD=\$rc2 RAN_REBUILD=\$([ -e /proj/PWNED ] && echo 1 || echo 0)" | tail -1)
echo "    C3 already-linked, session approves: $r"
finding "C3: over a base with the package already linked and nothing pending, a session's approval runs the script on install=$(field "$r" RAN_INSTALL), on pnpm rebuild=$(field "$r" RAN_REBUILD) (rc $(field "$r" RC)/$(field "$r" RC_REBUILD))."

hdr "Summary"
echo "    PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { ok "Facts recorded; the carried-approval property holds."; exit 0; } || { bad "$FAIL cell(s) failed"; exit 1; }
