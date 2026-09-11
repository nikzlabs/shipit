#!/usr/bin/env bash
#
# Install the default-deny egress policy in the agent network namespace.
#
# Inputs (env, space-separated):
#   EGRESS_ALLOWED_HOSTS  FQDNs to resolve (in the agent's own DNS view) and allow
#   EGRESS_ALLOWED_CIDRS  CIDRs / IPs to allow (e.g. GitHub `meta` ranges)
#
# Resolve names before OUTPUT changes to DROP.

set -euo pipefail

SET4=shipit-egress-allow4
SET6=shipit-egress-allow6

log() { echo "[egress-init] $*"; }

# --- 1. Resolve allowed hostnames (before deny) ----------------------------
ips=()
resolve_dir="$(mktemp -d)"
resolve_pids=()
all_resolve_pids=()
resolve_files=()
trap 'rm -rf "$resolve_dir"' EXIT
query_index=0
for host in ${EGRESS_ALLOWED_HOSTS:-}; do
  for record_type in A AAAA; do
    result_file="$resolve_dir/$query_index"
    query_index=$((query_index + 1))
    resolve_files+=("$result_file")
    # Resolve concurrently. Each query gets one short attempt, and the group
    # below has a separate deadline in case `dig` itself becomes unresponsive.
    dig +time=1 +tries=1 +short "$record_type" "$host" >"$result_file" 2>/dev/null &
    resolve_pids+=("$!")
    all_resolve_pids+=("$!")
  done
done

resolve_deadline=$((SECONDS + ${EGRESS_DNS_DEADLINE_SECONDS:-5}))
while ((${#resolve_pids[@]} > 0)); do
  remaining=()
  for pid in "${resolve_pids[@]}"; do
    kill -0 "$pid" 2>/dev/null && remaining+=("$pid")
  done
  resolve_pids=("${remaining[@]}")
  ((${#resolve_pids[@]} == 0)) && break
  if ((SECONDS >= resolve_deadline)); then
    kill "${resolve_pids[@]}" 2>/dev/null || true
    break
  fi
  sleep 0.05
done
for pid in "${all_resolve_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
for result_file in "${resolve_files[@]}"; do
  while read -r ip; do
    if [[ "$ip" =~ ^[0-9.]+$ || "$ip" =~ ^[0-9a-fA-F:]+$ ]]; then ips+=("$ip"); fi
  done <"$result_file"
done
log "resolved ${#ips[@]} IP(s) from ${EGRESS_ALLOWED_HOSTS:-<none>}"

# Test seam for the bounded resolver. Production never sets this value.
[[ "${EGRESS_RESOLVE_ONLY:-0}" == "1" ]] && exit 0

# --- 2. Build the ipsets ----------------------------------------------------
# Remove filter references before replacing their sets.
iptables -F OUTPUT 2>/dev/null || true
ip6tables -F OUTPUT 2>/dev/null || true
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

# --- 3. Allow the control-plane bridge subnet -------------------------------
# Later Compose subnets are added by allow-subnet.sh.
default_gw="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
local_subnet=""
if [[ -n "$default_gw" ]]; then
  local_subnet="$(echo "$default_gw" | sed 's#\.[0-9]*$#.0/24#')"
  log "local bridge subnet: $local_subnet (gw $default_gw)"
fi

# --- 4. Install OUTPUT rules ------------------------------------------------
# Tier B redirects Docker DNS to the controlled in-netns resolver.
DNS_UID="${EGRESS_DNS_RESOLVER_UID:-}"
DOCKER_DNS=127.0.0.11
# Tier C excludes the proxy UID from its own HTTPS redirect.
PROXY_UID="${EGRESS_PROXY_UID:-}"
PROXY_PORT="${EGRESS_PROXY_PORT:-8443}"
install_v4() {
  iptables -F OUTPUT || true
  if [[ -n "$DNS_UID" ]]; then
    iptables -A OUTPUT -d 127.0.0.11 -m owner ! --uid-owner "$DNS_UID" -j DROP
  fi
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Redirected packets do not have loopback as their output interface yet.
  if [[ -n "$PROXY_UID" ]]; then
    iptables -A OUTPUT -p tcp -d 127.0.0.1 --dport "$PROXY_PORT" -j ACCEPT
  fi
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

# --- 4b. Force Docker DNS through the controlled resolver ------------------
# Insert before Docker's 127.0.0.11 DNAT rules and exclude the resolver UID.
install_dns_redirect() {
  while iptables -t nat -D OUTPUT -d "$DOCKER_DNS" -p udp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53 2>/dev/null; do :; done
  while iptables -t nat -D OUTPUT -d "$DOCKER_DNS" -p tcp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53 2>/dev/null; do :; done
  iptables -t nat -I OUTPUT 1 -d "$DOCKER_DNS" -p udp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53
  iptables -t nat -I OUTPUT 1 -d "$DOCKER_DNS" -p tcp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53
}
if [[ -n "$DNS_UID" ]]; then
  install_dns_redirect
  log "Tier B DNS redirect installed ($DOCKER_DNS:53 → in-netns resolver 127.0.0.1:53)"
fi

# --- 4c. Redirect HTTPS to the SNI proxy -----------------------------------
# External-to-loopback redirects require route_localnet in the agent netns.
install_sni_redirect() {
  local rl
  rl="$(cat /proc/sys/net/ipv4/conf/all/route_localnet 2>/dev/null || echo '?')"
  [[ "$rl" == "1" ]] || log "WARN: route_localnet=$rl (expected 1) — SNI redirect may not route to the proxy; ensure the agent container sets net.ipv4.conf.all.route_localnet=1"
  while iptables -t nat -D OUTPUT -p tcp --dport 443 -m owner ! --uid-owner "$PROXY_UID" -j REDIRECT --to-ports "$PROXY_PORT" 2>/dev/null; do :; done
  iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner "$PROXY_UID" -j REDIRECT --to-ports "$PROXY_PORT"
}
if [[ -n "$PROXY_UID" ]]; then
  install_sni_redirect
  log "Tier C SNI redirect installed (:443 → in-netns proxy 127.0.0.1:$PROXY_PORT)"
fi

# --- 5. Fail-closed self-test ----------------------------------------------
# TEST-NET-1 checks the deny rule without DNS.
if curl -sS --max-time 5 https://192.0.2.1/ >/dev/null 2>&1; then
  log "SELF-TEST FAILED: 192.0.2.1 reachable — egress NOT contained"
  exit 1
fi
log "SELF-TEST ok: non-allowlisted 192.0.2.1 blocked"

log "egress firewall installed successfully (DNS mode: ${DNS_UID:+locked to resolver uid $DNS_UID}${DNS_UID:-open/Tier A}${PROXY_UID:+; Tier C SNI proxy on :$PROXY_PORT})"
