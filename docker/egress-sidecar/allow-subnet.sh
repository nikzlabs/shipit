#!/usr/bin/env bash
#
# Allow only the session's late-created Compose subnet in the agent netns.
#
# Inputs (env, space-separated):
#   EGRESS_ALLOW_SUBNETS  CIDRs to allow (e.g. "172.19.0.0/16")
#   EGRESS_BLOCK_ADDRS    those networks' gateways: the Docker host, always refused
#   EGRESS_HOST_ADDRS     when set, the host's addresses NOW: a drop inside an
#                         allowed subnet for any other address is removed
#   EGRESS_LOCAL_TCP      when set, replaces SHIPIT-CORE: ShipIt's own address:port pairs
#
# Idempotent and best effort: failure affects preview access, not containment.
# A namespace installed before docs/319 has no SHIPIT-LOCAL chain; its rules
# go into OUTPUT as they did then.

set -euo pipefail

log() { echo "[egress-allow-subnet] $*"; }

chain_for() {
  if "$1" -n -L SHIPIT-LOCAL >/dev/null 2>&1; then echo SHIPIT-LOCAL; else echo OUTPUT; fi
}

block_one() {
  local addr="$1" tool=iptables chain
  [[ -z "$addr" ]] && return 0
  [[ "$addr" == *:* ]] && tool=ip6tables
  chain="$(chain_for "$tool")"
  [[ "$chain" == "SHIPIT-LOCAL" ]] || return 0
  # At the top, so an accept appended for its subnet can never come first.
  "$tool" -C "$chain" -d "$addr" -j DROP 2>/dev/null \
    || "$tool" -I "$chain" 1 -d "$addr" -j DROP \
    || { log "WARN: could not refuse $addr"; return 1; }
  log "refused $addr"
}

ip4_int() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  echo $(((a << 24) | (b << 16) | (c << 8) | d))
}

in_subnet4() {
  local bits="${2#*/}" addr net mask
  addr="$(ip4_int "$1")" net="$(ip4_int "${2%/*}")"
  mask=$((bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF))
  (((addr & mask) == (net & mask)))
}

# The host drops are a snapshot from install time. Docker reuses a removed
# network's range, and a network with no host address gives its first address
# to a container, so a snapshot drop can hide one of this session's services.
# IPv4 only: a network with no host address has IPv6 off.
prune_stale_drops() {
  [[ -n "${EGRESS_HOST_ADDRS+set}" ]] || return 0
  [[ "$(chain_for iptables)" == "SHIPIT-LOCAL" ]] || return 0
  local keep=" ${EGRESS_HOST_ADDRS} ${EGRESS_BLOCK_ADDRS:-} " rule addr cidr
  while read -r rule; do
    [[ "$rule" =~ ^-A\ SHIPIT-LOCAL\ -d\ ([0-9.]+)/32\ -j\ DROP$ ]] || continue
    addr="${BASH_REMATCH[1]}"
    [[ "$keep" == *" $addr "* ]] && continue
    for cidr in ${EGRESS_ALLOW_SUBNETS:-}; do
      [[ "$cidr" == */* && "$cidr" != *:* ]] || continue
      if in_subnet4 "$addr" "$cidr"; then
        if iptables -D SHIPIT-LOCAL -d "$addr/32" -j DROP; then
          log "no longer refused $addr: the host no longer holds it"
        else
          log "WARN: could not remove the stale drop for $addr"
        fi
        break
      fi
    done
  done < <(iptables -S SHIPIT-LOCAL)
}

allow_one() {
  local cidr="$1" chain
  [[ -z "$cidr" ]] && return 0
  if [[ "$cidr" == *:* ]]; then
    chain="$(chain_for ip6tables)"
    ip6tables -C "$chain" -d "$cidr" -j ACCEPT 2>/dev/null \
      || ip6tables -A "$chain" -d "$cidr" -j ACCEPT 2>/dev/null \
      || { log "WARN: could not add ip6 rule for $cidr"; return 0; }
  else
    chain="$(chain_for iptables)"
    # Exempt session HTTPS before the Tier C redirect.
    iptables -t nat -C OUTPUT -d "$cidr" -p tcp --dport 443 -j RETURN 2>/dev/null \
      || iptables -t nat -I OUTPUT 1 -d "$cidr" -p tcp --dport 443 -j RETURN \
      || { log "WARN: could not exempt HTTPS for $cidr"; return 0; }
    iptables -C "$chain" -d "$cidr" -j ACCEPT 2>/dev/null \
      || iptables -A "$chain" -d "$cidr" -j ACCEPT \
      || { log "WARN: could not add rule for $cidr"; return 0; }
  fi
  log "allowed egress to $cidr"
}

if [[ -n "${EGRESS_LOCAL_TCP:-}" ]]; then
  if ! iptables -n -L SHIPIT-CORE >/dev/null 2>&1; then
    # Exit 3: installed before docs/319; the caller reinstalls the whole firewall.
    log "no SHIPIT-CORE chain in this namespace"
    exit 3
  fi
  iptables -F SHIPIT-CORE
  for pair in $EGRESS_LOCAL_TCP; do
    iptables -A SHIPIT-CORE -d "${pair%:*}" -p tcp --dport "${pair##*:}" -j ACCEPT
  done
  log "ShipIt's own address set to $EGRESS_LOCAL_TCP"
fi

# A gateway that cannot be refused must not get its subnet opened.
for addr in ${EGRESS_BLOCK_ADDRS:-}; do
  block_one "$addr" || exit 1
done

prune_stale_drops

for cidr in ${EGRESS_ALLOW_SUBNETS:-}; do
  allow_one "$cidr"
done

log "intra-session subnet allow complete (${EGRESS_ALLOW_SUBNETS:-<none>})"
