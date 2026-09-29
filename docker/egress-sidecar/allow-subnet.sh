#!/usr/bin/env bash
#
# Allow only the session's late-created Compose subnet in the agent netns.
#
# Inputs (env, space-separated):
#   EGRESS_ALLOW_SUBNETS  CIDRs to allow (e.g. "172.19.0.0/16")
#   EGRESS_BLOCK_ADDRS    those networks' gateways: the Docker host, always refused
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

# A gateway that cannot be refused must not get its subnet opened.
for addr in ${EGRESS_BLOCK_ADDRS:-}; do
  block_one "$addr" || exit 1
done

for cidr in ${EGRESS_ALLOW_SUBNETS:-}; do
  allow_one "$cidr"
done

log "intra-session subnet allow complete (${EGRESS_ALLOW_SUBNETS:-<none>})"
