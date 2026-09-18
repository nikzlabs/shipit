#!/bin/sh
#
# Check runtime invariants inside the built egress sidecar image.
# Keep this POSIX-compatible for BusyBox ash and free of NET_ADMIN requirements.

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

# --- Packages --------------------------------------------------------------
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

# Match the exact compile option; `no-ipset` must not pass.
echo
echo "=== dnsmasq compile options ==="
if dnsmasq --version 2>&1 | tr ' ' '\n' | grep -qx 'ipset'; then
  ok "dnsmasq has ipset support"
else
  fail "dnsmasq was built WITHOUT ipset support — Tier B's ipset= directives will not load"
fi

# --- Dedicated UIDs --------------------------------------------------------
# Firewall owner matches require both name-to-UID and UID-to-name checks.
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
  # BusyBox `id -nu <uid>` cannot do reverse lookup.
  owner="$(awk -F: -v u="$want" '$3 == u { print $1 }' /etc/passwd)"
  if [ "$owner" = "$name" ]; then
    ok "uid $want belongs to $name"
  else
    fail "uid $want belongs to '${owner:-<nobody>}', expected $name"
  fi
}
check_uid egressdns "$RESOLVER_UID"
check_uid egressproxy "$PROXY_UID"

# --- Tier C proxy binary ---------------------------------------------------
# Run as the production UID; startup also checks static binary compatibility.
echo
echo "=== sni-proxy (as uid $PROXY_UID) ==="
echo "linkage: $(ldd /usr/local/bin/sni-proxy 2>&1 | head -1)"
proxy_log=/tmp/sni-proxy.log
: >"$proxy_log"
su egressproxy -s /bin/sh -c '/usr/local/bin/sni-proxy' >"$proxy_log" 2>&1 &
# Poll to avoid a fixed-delay race.
i=0
while [ "$i" -lt 50 ]; do
  if grep -q 'listening on' "$proxy_log"; then break; fi
  sleep 0.1
  i=$((i + 1))
done
if grep -q 'listening on' "$proxy_log"; then
  ok "sni-proxy started: $(head -1 "$proxy_log")"
  # Require the socket as proof that the process remains live.
  if netstat -lnt 2>/dev/null | grep -q '127\.0\.0\.1:8443'; then
    ok "sni-proxy still holds 127.0.0.1:8443"
  else
    fail "sni-proxy logged its listen line but no longer holds 127.0.0.1:8443"
  fi
else
  fail "sni-proxy never reached its listen line; output: $(head -5 "$proxy_log")"
fi
killall sni-proxy 2>/dev/null || true

# --- Shell syntax ----------------------------------------------------------
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
