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
#
# DNS handling depends on the tier:
#   Tier A (EGRESS_DNS_RESOLVER_UID unset): port 53 open broadly (resolution
#     works; DNS-tunneling exfil is still possible — closed by Tier B).
#   Tier B (EGRESS_DNS_RESOLVER_UID set): DNS is locked to the in-netns resolver.
#     The agent reaches it at 127.0.0.1:53 (via the `lo` ACCEPT); only the
#     resolver's uid may send DNS UPSTREAM; the agent is blocked from Docker's
#     embedded DNS (127.0.0.11) directly (else it could resolve arbitrary names).
#
# NOTE(host-verify): Docker DNATs the embedded resolver (127.0.0.11) in nat/OUTPUT
# before filter/OUTPUT runs. We match it by destination IP only (no --dport) to
# stay robust to the port rewrite, but this rule is the #1 thing to confirm on a
# real host when verifying Tier B.
DNS_UID="${EGRESS_DNS_RESOLVER_UID:-}"
install_v4() {
  iptables -F OUTPUT || true
  if [[ -n "$DNS_UID" ]]; then
    iptables -A OUTPUT -d 127.0.0.11 -m owner ! --uid-owner "$DNS_UID" -j DROP
  fi
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  [[ -n "$local_subnet" ]] && iptables -A OUTPUT -d "$local_subnet" -j ACCEPT
  if [[ -n "$DNS_UID" ]]; then
    iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
  else
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  fi
  iptables -A OUTPUT -m set --match-set "$SET4" dst -j ACCEPT
  iptables -P OUTPUT DROP
}
install_v6() {
  ip6tables -F OUTPUT 2>/dev/null || return 0
  ip6tables -A OUTPUT -o lo -j ACCEPT || true
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
  if [[ -n "$DNS_UID" ]]; then
    ip6tables -A OUTPUT -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT || true
    ip6tables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT || true
  else
    ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT || true
    ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT || true
  fi
  ip6tables -A OUTPUT -m set --match-set "$SET6" dst -j ACCEPT || true
  ip6tables -P OUTPUT DROP || true
}
install_v4
install_v6
log "default-deny OUTPUT policy installed"

# --- 5. Self-test (fail-closed, DNS-independent) ---------------------------
# A non-allowlisted destination MUST be blocked. We hit a literal TEST-NET-1 IP
# (RFC 5737, 192.0.2.0/24 — guaranteed non-routable and never allowlisted) so
# the check needs NO DNS — it works identically in Tier A and Tier B (where the
# resolver may not be up yet). If it's reachable, the OUTPUT policy isn't taking
# effect: exit non-zero so the orchestrator tears the container down rather than
# run it with open egress. (Positive/allowed-host + DNS checks live in the
# post-create SHI-90 verification, once the resolver is running.)
if curl -sS --max-time 5 https://192.0.2.1/ >/dev/null 2>&1; then
  log "SELF-TEST FAILED: 192.0.2.1 reachable — egress NOT contained"
  exit 1
fi
log "SELF-TEST ok: non-allowlisted 192.0.2.1 blocked"

log "egress firewall installed successfully (DNS mode: ${DNS_UID:+locked to resolver uid $DNS_UID}${DNS_UID:-open/Tier A})"
