#!/usr/bin/env bash
#
# Install the default-deny egress policy in the agent network namespace.
#
# Inputs (env, space-separated):
#   EGRESS_POLICY         contained (default: allowlist) or open (local block only)
#   EGRESS_ALLOWED_HOSTS  FQDNs to resolve (in the agent's own DNS view) and allow
#   EGRESS_ALLOWED_CIDRS  CIDRs / IPs to allow (e.g. GitHub `meta` ranges)
#   EGRESS_HOST_ADDRS     the Docker host's own addresses, always refused
#   EGRESS_LOCAL_TCP      address:port pairs for ShipIt itself on a network other sessions share
#   EGRESS_SSH_TARGETS    granted SSH destinations as host:port or [v6]:port
#
# Both policies refuse the host, private networks and the tailnet before any
# other rule (docs/319-api-reach-through-host). Resolve names before OUTPUT
# changes.

set -euo pipefail

SET4=shipit-egress-allow4
SET6=shipit-egress-allow6
POLICY="${EGRESS_POLICY:-contained}"

log() { echo "[egress-init] $*"; }

LOCAL_CHAIN=SHIPIT-LOCAL
SSH_CHAIN=SHIPIT-SSH
CORE_CHAIN=SHIPIT-CORE
BLOCK_CHAIN=SHIPIT-BLOCK
# The host's private addresses, private networks and the tailnet (docs/319 req 4).
BLOCK_V4="10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16"
BLOCK_V6="fc00::/7 fe80::/10"

is_v4() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$ ]]; }
is_v6() { [[ "$1" == *:* && "$1" =~ ^[0-9a-fA-F:.]+(/[0-9]+)?$ ]]; }

if [[ "$POLICY" != "contained" && "$POLICY" != "open" ]]; then
  log "unknown EGRESS_POLICY '$POLICY'"
  exit 1
fi
if [[ "$POLICY" == "open" ]]; then
  # The open policy has no allowlist, resolver or proxy.
  EGRESS_ALLOWED_HOSTS="" EGRESS_ALLOWED_CIDRS="" EGRESS_DNS_RESOLVER_UID="" EGRESS_PROXY_UID=""
fi

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

# One "address port" line per granted SSH destination; a name gives one per address.
ssh_lines=()
for target in ${EGRESS_SSH_TARGETS:-}; do
  if [[ "$target" =~ ^\[([0-9a-fA-F:.]+)\]:([0-9]+)$ || "$target" =~ ^([^:]+):([0-9]+)$ ]]; then
    ssh_host="${BASH_REMATCH[1]}" ssh_port="${BASH_REMATCH[2]}"
  else
    log "ignoring malformed SSH target '$target'"
    continue
  fi
  if is_v4 "$ssh_host" || is_v6 "$ssh_host"; then
    ssh_lines+=("$ssh_host $ssh_port")
    continue
  fi
  for record_type in A AAAA; do
    while read -r ip; do
      if is_v4 "$ip" || is_v6 "$ip"; then ssh_lines+=("$ip $ssh_port"); fi
    done < <(dig +time=1 +tries=1 +short "$record_type" "$ssh_host" 2>/dev/null || true)
  done
done

# Test seam for the bounded resolver. Production never sets this value.
[[ "${EGRESS_RESOLVE_ONLY:-0}" == "1" ]] && exit 0

# --- 2. Build the ipsets ----------------------------------------------------
# DROP while the chains are rebuilt, so a reinstall never runs without the block.
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP 2>/dev/null || true
# Remove filter references before replacing their sets.
iptables -F OUTPUT 2>/dev/null || true
ip6tables -F OUTPUT 2>/dev/null || true
if [[ "$POLICY" == "contained" ]]; then
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
fi

# --- 3. The local block -------------------------------------------------------
# SHIPIT-LOCAL drops the host and gateways first, then accepts what this
# container needs on ShipIt's networks; allow-subnet.sh inserts later drops at
# its top and appends accepts.
default_gw="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"

new_chain() { "$1" -N "$2" 2>/dev/null || "$1" -F "$2"; }

fill_ssh() {
  local tool="$1" line ip port
  for line in "${ssh_lines[@]:-}"; do
    [[ -z "$line" ]] && continue
    read -r ip port <<<"$line"
    if [[ "$tool" == "ip6tables" ]]; then is_v6 "$ip" || continue; else is_v4 "$ip" || continue; fi
    "$tool" -A "$SSH_CHAIN" -d "$ip" -p tcp --dport "$port" -j ACCEPT || return 1
  done
}

install_block_v4() {
  new_chain iptables "$SSH_CHAIN"
  new_chain iptables "$CORE_CHAIN"
  new_chain iptables "$LOCAL_CHAIN"
  new_chain iptables "$BLOCK_CHAIN"
  fill_ssh iptables
  # Its own chain, so allow-subnet.sh can replace it when ShipIt's address changes.
  local pair
  for pair in ${EGRESS_LOCAL_TCP:-}; do
    iptables -A "$CORE_CHAIN" -d "${pair%:*}" -p tcp --dport "${pair##*:}" -j ACCEPT
  done
  iptables -A "$LOCAL_CHAIN" -m addrtype --dst-type BROADCAST -j DROP
  iptables -A "$LOCAL_CHAIN" -m addrtype --dst-type MULTICAST -j DROP
  local addr
  for addr in ${EGRESS_HOST_ADDRS:-}; do
    if is_v4 "$addr"; then iptables -A "$LOCAL_CHAIN" -d "$addr" -j DROP; fi
  done
  if [[ -n "$default_gw" ]]; then iptables -A "$LOCAL_CHAIN" -d "$default_gw" -j DROP; fi
  local range
  for range in $BLOCK_V4; do iptables -A "$BLOCK_CHAIN" -d "$range" -j DROP; done
}

install_block_v6() {
  new_chain ip6tables "$SSH_CHAIN" || return 1
  new_chain ip6tables "$LOCAL_CHAIN" || return 1
  new_chain ip6tables "$BLOCK_CHAIN" || return 1
  fill_ssh ip6tables || return 1
  ip6tables -A "$LOCAL_CHAIN" -d ff00::/8 -j DROP || return 1
  local addr
  for addr in ${EGRESS_HOST_ADDRS:-}; do
    if is_v6 "$addr"; then ip6tables -A "$LOCAL_CHAIN" -d "$addr" -j DROP || return 1; fi
  done
  local range
  for range in $BLOCK_V6; do ip6tables -A "$BLOCK_CHAIN" -d "$range" -j DROP || return 1; done
}

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
  install_block_v4
  iptables -A OUTPUT -j "$SSH_CHAIN"
  iptables -A OUTPUT -j "$CORE_CHAIN"
  iptables -A OUTPUT -j "$LOCAL_CHAIN"
  iptables -A OUTPUT -j "$BLOCK_CHAIN"
  if [[ "$POLICY" == "open" ]]; then
    iptables -P OUTPUT ACCEPT
    return 0
  fi
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
# A kernel with IPv6 can give this namespace an IPv6 path later (a network join),
# so its rules must be in place from the start.
# EGRESS_IPV6_MARKER is a test seam; production never sets it.
has_ipv6_kernel() { [[ -e "${EGRESS_IPV6_MARKER:-/proc/net/if_inet6}" ]]; }
# Each step returns on failure: install_v6 decides whether a failure is fatal.
install_v6_rules() {
  ip6tables -F OUTPUT || return 1
  ip6tables -A OUTPUT -o lo -j ACCEPT || return 1
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
  # Neighbour discovery answers link-local addresses; without it IPv6 stops.
  local ndp
  for ndp in router-solicitation router-advertisement neighbour-solicitation neighbour-advertisement; do
    ip6tables -A OUTPUT -p ipv6-icmp --icmpv6-type "$ndp" -j ACCEPT || return 1
  done
  install_block_v6 || return 1
  ip6tables -A OUTPUT -j "$SSH_CHAIN" || return 1
  ip6tables -A OUTPUT -j "$LOCAL_CHAIN" || return 1
  ip6tables -A OUTPUT -j "$BLOCK_CHAIN" || return 1
  if [[ "$POLICY" == "open" ]]; then
    ip6tables -P OUTPUT ACCEPT || return 1
    return 0
  fi
  if [[ -n "$DNS_UID" ]]; then
    ip6tables -A OUTPUT -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT || return 1
    ip6tables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT || return 1
  else
    ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT || return 1
    ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT || return 1
  fi
  ip6tables -A OUTPUT -m set --match-set "$SET6" dst -j ACCEPT || return 1
  ip6tables -P OUTPUT DROP || return 1
}
install_v6() {
  if install_v6_rules; then return 0; fi
  if has_ipv6_kernel; then
    log "IPv6 rules failed on a kernel with IPv6 — refusing to leave IPv6 open"
    return 1
  fi
  log "IPv6 rules not installed; this kernel has no IPv6"
}
install_v4
install_v6
log "$POLICY OUTPUT policy installed (${#ssh_lines[@]} SSH destination address(es))"

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
# A dropped UDP send fails at once with EPERM (a dropped TCP connect only
# hangs), and a namespace with no route fails with ENETUNREACH; a silent send
# means the datagram left.
refused_locally() {
  local out
  out="$(timeout 3 bash -c "exec 3<>/dev/udp/$1/9 && echo probe >&3" 2>&1 || true)"
  [[ "$out" == *"not permitted"* || "$out" == *"Network is unreachable"* ]]
}
for probe in 169.254.0.1 ${default_gw:-}; do
  if ! refused_locally "$probe"; then
    log "SELF-TEST FAILED: $probe not refused — the local block is NOT in force"
    exit 1
  fi
done
log "SELF-TEST ok: the local block refuses private addresses and the gateway"
if [[ "$POLICY" == "contained" ]]; then
  # TEST-NET-1 checks the deny rule without DNS.
  if curl -sS --max-time 5 https://192.0.2.1/ >/dev/null 2>&1; then
    log "SELF-TEST FAILED: 192.0.2.1 reachable — egress NOT contained"
    exit 1
  fi
  log "SELF-TEST ok: non-allowlisted 192.0.2.1 blocked"
fi

log "egress firewall installed successfully (DNS mode: ${DNS_UID:+locked to resolver uid $DNS_UID}${DNS_UID:-open/Tier A}${PROXY_UID:+; Tier C SNI proxy on :$PROXY_PORT})"
