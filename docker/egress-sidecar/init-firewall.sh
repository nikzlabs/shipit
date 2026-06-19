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
#
# NOTE: this allows ONLY the agent's *default-gateway* subnet. A session's
# compose/preview network is attached to the agent LATER (after `docker compose
# up`), so its subnet is opened separately, at join time, by the companion
# allow-subnet.sh sidecar (SHI-90, GH #1495) — that's how the agent's browser
# reaches the live preview.
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
# NOTE(Tier B / Bug-1 fix): on a user-defined Docker network the agent's
# /etc/resolv.conf is `nameserver 127.0.0.11` (Docker's embedded resolver)
# REGARDLESS of the container `--dns` setting — Docker demotes `--dns` to a mere
# *upstream* of 127.0.0.11, it does not replace the nameserver. Since the filter
# rule below drops the agent → 127.0.0.11, the agent would have NO working
# resolver. So we transparently REDIRECT the agent's DNS to the in-netns dnsmasq
# (see install_dns_redirect). We still keep matching 127.0.0.11 by destination IP
# (no --dport) in the filter table as a backstop for non-DNS traffic.
DNS_UID="${EGRESS_DNS_RESOLVER_UID:-}"
DOCKER_DNS=127.0.0.11
# Tier C: when set, the agent's outbound :443 is REDIRECTed to the in-netns SNI
# proxy listening on 127.0.0.1:$PROXY_PORT, owned by $PROXY_UID (excluded so the
# proxy's own upstream dials aren't re-redirected).
PROXY_UID="${EGRESS_PROXY_UID:-}"
PROXY_PORT="${EGRESS_PROXY_PORT:-8443}"
install_v4() {
  iptables -F OUTPUT || true
  if [[ -n "$DNS_UID" ]]; then
    iptables -A OUTPUT -d 127.0.0.11 -m owner ! --uid-owner "$DNS_UID" -j DROP
  fi
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Tier C: the nat/OUTPUT REDIRECT rewrites the agent's :443 dst to
  # 127.0.0.1:$PROXY_PORT, but the packet's oif is NOT `lo` at filter/OUTPUT time,
  # so the `-o lo` ACCEPT above misses it and it would hit the DROP policy. Accept
  # the redirected-to-proxy destination explicitly (host-verified: without this the
  # redirected :443 times out under `-P OUTPUT DROP`).
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

# --- 4b. Tier B: force agent DNS through the in-netns controlled resolver ----
# Bug-1 fix (see the NOTE above): the agent always sends DNS to Docker's embedded
# resolver at $DOCKER_DNS, which the filter table drops. Rather than fight
# resolv.conf, intercept those packets in nat/OUTPUT and REDIRECT them to the
# local dnsmasq on 127.0.0.1:53 (REDIRECT in OUTPUT maps the destination to
# localhost). This is robust to whatever resolv.conf says, and conntrack un-NATs
# the reply so the agent sees an answer from 127.0.0.11 as usual.
#
# Scoped to $DOCKER_DNS (the only DNS dest the agent actually uses): any other DNS
# destination is already dropped by the filter OUTPUT policy, so there's nothing
# to redirect. The resolver's OWN upstream queries run as uid $DNS_UID and are
# excluded here (they egress via the uid-:53 filter allow). Inserted at the TOP of
# nat/OUTPUT so it precedes Docker's own 127.0.0.11 DNAT rules.
install_dns_redirect() {
  iptables -t nat -I OUTPUT 1 -d "$DOCKER_DNS" -p udp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53
  iptables -t nat -I OUTPUT 1 -d "$DOCKER_DNS" -p tcp --dport 53 -m owner ! --uid-owner "$DNS_UID" -j REDIRECT --to-ports 53
}
if [[ -n "$DNS_UID" ]]; then
  install_dns_redirect
  log "Tier B DNS redirect installed ($DOCKER_DNS:53 → in-netns resolver 127.0.0.1:53)"
fi

# --- 4c. Tier C: REDIRECT agent HTTPS to the in-netns SNI proxy --------------
# Hostname-level HTTPS policy: send the agent's outbound :443 to the SNI proxy on
# loopback, which peeks the ClientHello SNI and splices-or-rejects (closing the
# CDN co-tenancy gap that an IP-only ipset can't). The proxy's OWN upstream dials
# (uid $PROXY_UID) are excluded so we don't loop. Unlike the DNS redirect (which
# targets the already-loopback 127.0.0.11), the original :443 destination is
# EXTERNAL, so redirecting it to a loopback listener requires route_localnet —
# otherwise the kernel drops the rewritten packet (non-loopback source → 127/8) as
# a martian. route_localnet is network-namespaced, so this only affects the agent.
# route_localnet is enabled on the AGENT CONTAINER at creation (HostConfig.Sysctls,
# gated on Tier C) — this NET_ADMIN-only installer can't write the read-only
# /proc/sys here (EROFS). We only verify it's on and warn (non-fatal) if not, so a
# misconfig is visible in the installer logs rather than silently mis-routing.
install_sni_redirect() {
  local rl
  rl="$(cat /proc/sys/net/ipv4/conf/all/route_localnet 2>/dev/null || echo '?')"
  [[ "$rl" == "1" ]] || log "WARN: route_localnet=$rl (expected 1) — SNI redirect may not route to the proxy; ensure the agent container sets net.ipv4.conf.all.route_localnet=1"
  iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner ! --uid-owner "$PROXY_UID" -j REDIRECT --to-ports "$PROXY_PORT"
}
if [[ -n "$PROXY_UID" ]]; then
  install_sni_redirect
  log "Tier C SNI redirect installed (:443 → in-netns proxy 127.0.0.1:$PROXY_PORT)"
fi

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

log "egress firewall installed successfully (DNS mode: ${DNS_UID:+locked to resolver uid $DNS_UID}${DNS_UID:-open/Tier A}${PROXY_UID:+; Tier C SNI proxy on :$PROXY_PORT})"
