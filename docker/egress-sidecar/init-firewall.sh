#!/usr/bin/env bash
#
# Egress firewall installer — docs/172-agent-containment Gap 1 (SHI-90), Tier A.
#
# Runs in a SHORT-LIVED PRIVILEGED SIDECAR that shares the agent container's
# network namespace:
#
#   docker run --network container:<agentId> --cap-add NET_ADMIN egress-sidecar
#
# It installs a default-deny `iptables OUTPUT` policy plus an `ipset` allow-set
# INTO THE AGENT'S NETNS, then exits. The rules persist for the life of the
# netns (i.e. the agent container); the agent itself has CapDrop:ALL / no
# NET_ADMIN and runs non-root (SHI-31), so it cannot flush or alter them.
#
# Inputs (env, space-separated):
#   EGRESS_ALLOWED_HOSTS  FQDNs to resolve (in the agent's own DNS view) and allow
#   EGRESS_ALLOWED_CIDRS  CIDRs / IPs to allow (e.g. GitHub `meta` ranges)
#
# Ordering matters: we resolve names + add members BEFORE switching OUTPUT to
# DROP (once default-deny is up we could no longer resolve anything).
#
# This script is verified on a live Docker host (the SHI-90 checklist), not in
# unit tests — the orchestrator-side logic that feeds it is unit-tested in
# egress-firewall.test.ts / egress-firewall-install.test.ts.

set -euo pipefail

SET4=shipit-egress-allow4
SET6=shipit-egress-allow6

log() { echo "[egress-init] $*"; }

# --- 1. Resolve allowed hostnames (before deny) ----------------------------
ips=()
for host in ${EGRESS_ALLOWED_HOSTS:-}; do
  # A and AAAA; `dig +short` may emit CNAME target lines, so keep only literals.
  while read -r ip; do
    [[ -n "$ip" ]] && ips+=("$ip")
  done < <(dig +short A "$host" 2>/dev/null | grep -E '^[0-9.]+$' || true)
  while read -r ip; do
    [[ -n "$ip" ]] && ips+=("$ip")
  done < <(dig +short AAAA "$host" 2>/dev/null | grep -E '^[0-9a-fA-F:]+$' || true)
done
log "resolved ${#ips[@]} IP(s) from ${EGRESS_ALLOWED_HOSTS:-<none>}"

# --- 2. Build the ipsets (hash:net holds bare IPs and CIDRs) ----------------
ipset destroy "$SET4" 2>/dev/null || true
ipset destroy "$SET6" 2>/dev/null || true
ipset create "$SET4" hash:net family inet
ipset create "$SET6" hash:net family inet6

add_member() {
  local m="$1"
  [[ -z "$m" ]] && return 0
  if [[ "$m" == *:* ]]; then ipset add -exist "$SET6" "$m" 2>/dev/null || true
  else ipset add -exist "$SET4" "$m" 2>/dev/null || true; fi
}
for ip in "${ips[@]:-}"; do add_member "$ip"; done
for cidr in ${EGRESS_ALLOWED_CIDRS:-}; do add_member "$cidr"; done

# --- 3. Allow the local bridge subnet (orchestrator API, docker proxy) ------
# The agent reaches the orchestrator (SHIPIT_HOST) and, for docker sessions, the
# docker proxy by their bridge IPs. Blocking the local subnet would sever the
# session's own control channel, so allow it explicitly (mirrors Anthropic's
# init-firewall.sh HOST_NETWORK rule). Cross-session isolation is handled
# separately (per-session networks / source-IP id with NET_RAW dropped).
default_gw="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
local_subnet=""
if [[ -n "$default_gw" ]]; then
  local_subnet="$(echo "$default_gw" | sed 's#\.[0-9]*$#.0/24#')"
  log "local bridge subnet: $local_subnet (gw $default_gw)"
fi

# --- 4. Install OUTPUT rules (INPUT is left untouched — egress is the threat) -
install_v4() {
  iptables -F OUTPUT || true
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  [[ -n "$local_subnet" ]] && iptables -A OUTPUT -d "$local_subnet" -j ACCEPT
  # DNS: Tier A allows resolution broadly; Tier B will pin it to the gateway
  # resolver to close DNS tunneling.
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  iptables -A OUTPUT -m set --match-set "$SET4" dst -j ACCEPT
  iptables -P OUTPUT DROP
}
install_v6() {
  ip6tables -F OUTPUT 2>/dev/null || return 0
  ip6tables -A OUTPUT -o lo -j ACCEPT || true
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
  ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT || true
  ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT || true
  ip6tables -A OUTPUT -m set --match-set "$SET6" dst -j ACCEPT || true
  ip6tables -P OUTPUT DROP || true
}
install_v4
install_v6
log "default-deny OUTPUT policy installed"

# --- 5. Self-test (fail-closed) --------------------------------------------
# A non-allowlisted host MUST be blocked. If example.com is reachable the
# enforcement isn't working — exit non-zero so the orchestrator tears the agent
# container down rather than run it with open egress.
if curl -sS --max-time 5 https://example.com >/dev/null 2>&1; then
  log "SELF-TEST FAILED: example.com is reachable — egress NOT contained"
  exit 1
fi
log "SELF-TEST ok: example.com blocked"

# GitHub should be reachable (availability check). Warn but do NOT fail closed:
# a transient resolve/meta hiccup shouldn't block the whole session.
if ! curl -sS --max-time 8 https://api.github.com/zen >/dev/null 2>&1; then
  log "SELF-TEST warning: api.github.com unreachable (check allow-set / DNS)"
else
  log "SELF-TEST ok: api.github.com reachable"
fi

log "egress firewall installed successfully"
