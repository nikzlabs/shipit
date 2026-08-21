#!/bin/sh
#
# Image invariant checks for the egress firewall sidecar — docs/172-agent-containment
# Gap 1 (planning#92). Run by the `egress-sidecar-image` job in .github/workflows/ci.yml.
#
# Runs INSIDE a built shipit-egress-sidecar image, bind-mounted rather than COPYed
# (test code has no business in a privileged production image):
#
#   docker run --rm -v "$PWD/docker/egress-sidecar/image-checks.sh:/image-checks.sh:ro" \
#     --entrypoint sh shipit-egress-sidecar:ci /image-checks.sh <resolver-uid> <proxy-uid>
#
# The point is NOT "does the image build" — that is the loud failure, and the build
# step already covers it. It is the quiet one: an image that builds perfectly and no
# longer *contains*. A drifted uid voids the firewall's owner-match rules, and nothing
# else in CI would notice. So every check below asserts a property the orchestrator
# actually depends on at runtime.
#
# Everything here is deliberately privilege-free, so it runs on a stock GitHub runner.
# The Tier A self-test in init-firewall.sh is NOT here and must not be added: it
# installs an iptables policy, so it needs NET_ADMIN and a shared network namespace.
# That check belongs to the host-level verification in the planning#92 checklist.
#
# POSIX sh — /bin/sh in this image is busybox ash, not bash.

set -eu

RESOLVER_UID="${1:?usage: image-checks.sh <resolver-uid> <proxy-uid>}"
PROXY_UID="${2:?usage: image-checks.sh <resolver-uid> <proxy-uid>}"

fails=0
fail() {
  echo "FAIL: $*"
  fails=$((fails + 1))
}
ok() { echo "ok:   $*"; }

echo "=== base image ==="
echo "alpine $(cat /etc/alpine-release)"

# --- 1. The apk layer ------------------------------------------------------
# All seven names in the Dockerfile's `apk add` must resolve. Printing the chosen
# versions is half the value: a base-image bump is reviewed by reading this list,
# because an iptables or dnsmasq MAJOR change can break the rule syntax in
# init-firewall.sh / run-resolver.sh even when every package installs cleanly.
#
# `ip6tables` is not a package of its own — the `iptables` package provides it, so
# it resolves to the same version. That is true of the old and new bases alike;
# the check is that the name still resolves, whoever provides it.
echo
echo "=== apk packages ==="
for p in iptables ip6tables ipset bind-tools curl bash dnsmasq; do
  version="$(apk info -e -v "$p" 2>/dev/null || true)"
  if [ -n "$version" ]; then
    ok "$p -> $version"
  else
    fail "$p is not installed"
  fi
done

# A package can be installed and still not put the tool on PATH.
echo
echo "=== binaries on PATH ==="
for b in iptables ip6tables ipset dig curl bash dnsmasq; do
  path="$(command -v "$b" || true)"
  if [ -n "$path" ]; then
    ok "$b -> $path"
  else
    fail "$b is not on PATH"
  fi
done

# --- 1b. dnsmasq must have ipset support COMPILED IN -----------------------
# Tier B is resolve-and-pin: egress-dns.ts emits `ipset=/<domain>/<set4>,<set6>`
# directives so a resolved IP lands in the firewall's allow-set as it is answered.
# That is a dnsmasq COMPILE-TIME option, not a runtime flag — an Alpine rebuild
# that dropped it would still install a perfectly working dnsmasq, and Tier B
# would fail when the config loads, long after CI went green.
#
# Match the exact token, not a substring: the option list also contains
# `no-nftset`, and an absent feature is spelled `no-ipset`, so a substring test
# would give the wrong answer in both directions.
echo
echo "=== dnsmasq compile options ==="
if dnsmasq --version 2>&1 | tr ' ' '\n' | grep -qx 'ipset'; then
  ok "dnsmasq has ipset support"
else
  fail "dnsmasq was built WITHOUT ipset support — Tier B's ipset= directives will not load"
fi

# --- 2. The dedicated uids -------------------------------------------------
# The whole containment story rests on these two numbers matching the orchestrator.
# The firewall allows port-53 egress ONLY for the resolver uid, and excludes the
# proxy uid from the :443 REDIRECT. If `adduser` ever picks a different number, the
# owner-match rules stop matching the process they were written for and the sidecar
# fails open — silently, with a green build.
#
# Checked in BOTH directions on purpose. Name -> uid alone would pass if some other
# account had taken the number; uid -> name catches that.
echo
echo "=== dedicated uids ==="
check_uid() {
  name="$1"
  want="$2"
  got="$(id -u "$name" 2>/dev/null || true)"
  if [ "$got" = "$want" ]; then
    ok "user $name has uid $want"
  else
    fail "user $name has uid '${got:-<no such user>}', expected $want"
  fi
  # busybox `id -nu <uid>` does not do reverse lookup, so read /etc/passwd directly.
  owner="$(awk -F: -v u="$want" '$3 == u { print $1 }' /etc/passwd)"
  if [ "$owner" = "$name" ]; then
    ok "uid $want belongs to $name"
  else
    fail "uid $want belongs to '${owner:-<nobody>}', expected $name"
  fi
}
check_uid egressdns "$RESOLVER_UID"
check_uid egressproxy "$PROXY_UID"

# --- 3. The Tier C proxy binary --------------------------------------------
# sni-proxy parses NO command-line flags: it is configured entirely from the
# environment, then listens and blocks on Accept(). So there is no --help or
# --version to probe -- passing one does not print usage, it just starts the
# proxy and hangs.
#
# Run it as the uid production runs it as: egress-proxy-install.ts sets
# `User: EGRESS_PROXY_UID` on the container. Binding :8443 needs no privilege, so
# starting it as root here would be a weaker test than the thing we actually ship.
#
# This doubles as the CGO/musl check. The Dockerfile builds with CGO_ENABLED=0 for
# a static binary; if that regressed, the dynamic loader would fail here before any
# output appeared. `ldd` is printed for diagnosis but not asserted on — its exact
# wording for a static binary is a musl implementation detail, whereas "the binary
# runs" is the property that matters.
echo
echo "=== sni-proxy (as uid $PROXY_UID) ==="
echo "linkage: $(ldd /usr/local/bin/sni-proxy 2>&1 | head -1)"
proxy_log=/tmp/sni-proxy.log
: >"$proxy_log"
su egressproxy -s /bin/sh -c '/usr/local/bin/sni-proxy' >"$proxy_log" 2>&1 &
# Poll for the listen line instead of sleeping a fixed interval, so a slow runner
# does not produce a flaky failure and a fast one does not pay for the wait.
i=0
while [ "$i" -lt 50 ]; do
  if grep -q 'listening on' "$proxy_log"; then break; fi
  sleep 0.1
  i=$((i + 1))
done
if grep -q 'listening on' "$proxy_log"; then
  ok "sni-proxy started: $(head -1 "$proxy_log")"
  # The log line on its own is not proof of a working proxy: a binary that printed
  # it and then died immediately would still leave it in the file. Requiring the
  # socket to still be held turns this into a liveness check.
  if netstat -lnt 2>/dev/null | grep -q '127\.0\.0\.1:8443'; then
    ok "sni-proxy still holds 127.0.0.1:8443"
  else
    fail "sni-proxy logged its listen line but no longer holds 127.0.0.1:8443"
  fi
else
  fail "sni-proxy never reached its listen line; output: $(head -5 "$proxy_log")"
fi
killall sni-proxy 2>/dev/null || true

# --- 4. The shell scripts --------------------------------------------------
# A base-image bump moves bash too (5.2 -> 5.3 in the alpine 3.20 -> 3.24 bump).
# These scripts use arrays, `set -u` with `${arr[@]:-}`, and process management, so
# parse them under the bash that is actually in the image. This is a syntax check,
# not a behaviour test — the behaviour needs NET_ADMIN.
echo
echo "=== script syntax ($(bash --version | head -1)) ==="
for s in init-firewall.sh run-resolver.sh allow-subnet.sh; do
  script="/usr/local/bin/$s"
  if [ ! -x "$script" ]; then
    fail "$s is missing or not executable"
    continue
  fi
  if bash -n "$script" 2>/dev/null; then
    ok "$s parses"
  else
    fail "$s does not parse:"
    bash -n "$script" || true
  fi
done

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) FAILED — the image does not meet its contract with the orchestrator."
  exit 1
fi
echo "all checks passed"
