#!/usr/bin/env bash
#
# Allow only the session's late-created Compose subnet in the agent netns.
#
# Inputs (env, space-separated):
#   EGRESS_ALLOW_SUBNETS  CIDRs to allow (e.g. "172.19.0.0/16")
#
# Idempotent and best effort: failure affects preview access, not containment.

set -euo pipefail

log() { echo "[egress-allow-subnet] $*"; }

allow_one() {
  local cidr="$1"
  [[ -z "$cidr" ]] && return 0
  if [[ "$cidr" == *:* ]]; then
    ip6tables -C OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null \
      || ip6tables -A OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null \
      || { log "WARN: could not add ip6 rule for $cidr"; return 0; }
  else
    # Exempt session HTTPS before the Tier C redirect.
    iptables -t nat -C OUTPUT -d "$cidr" -p tcp --dport 443 -j RETURN 2>/dev/null \
      || iptables -t nat -I OUTPUT 1 -d "$cidr" -p tcp --dport 443 -j RETURN \
      || { log "WARN: could not exempt HTTPS for $cidr"; return 0; }
    iptables -C OUTPUT -d "$cidr" -j ACCEPT 2>/dev/null \
      || iptables -A OUTPUT -d "$cidr" -j ACCEPT \
      || { log "WARN: could not add rule for $cidr"; return 0; }
  fi
  log "allowed egress to $cidr"
}

for cidr in ${EGRESS_ALLOW_SUBNETS:-}; do
  allow_one "$cidr"
done

log "intra-session subnet allow complete (${EGRESS_ALLOW_SUBNETS:-<none>})"
