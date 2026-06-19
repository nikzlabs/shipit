#!/usr/bin/env bash
#
# Intra-session subnet allow — docs/172-agent-containment Gap 1 (SHI-90).
#
# Companion to init-firewall.sh. Runs in a SHORT-LIVED PRIVILEGED SIDECAR that
# shares the agent container's network namespace:
#
#   docker run --network container:<agentId> --cap-add NET_ADMIN egress-sidecar \
#     /usr/local/bin/allow-subnet.sh
#
# It appends `iptables OUTPUT ... ACCEPT` rules for one or more CIDRs INTO THE
# AGENT'S NETNS, so the (multi-homed) agent — and its in-netns Playwright browser
# — can reach the session's OWN preview / compose service containers by IP.
#
# Why this is needed: init-firewall.sh runs at agent-container CREATION and only
# allows the agent's *default-gateway* bridge subnet (the orchestrator net). A
# session's compose/preview network is created LATER (`docker compose up`) and the
# agent is attached to it after the fact, so its subnet is not in the allow-set and
# the default-deny OUTPUT policy drops traffic to the dev server. This re-opens it
# for that ONE session subnet — the agent gains no route to any OTHER network, so
# this does not widen cross-session reach (cross-session isolation is unchanged).
# We deliberately allow only the specific session subnet, never broad RFC1918 (a
# broad allow would let the host forward the agent's packets into its own VPC/LAN).
#
# Inputs (env, space-separated):
#   EGRESS_ALLOW_SUBNETS  CIDRs to allow (e.g. "172.19.0.0/16")
#
# Idempotent: re-run on every network (re)join (reconnect after a container
# recreate re-attaches the agent), so each rule is added only if not already
# present (`-C` check before `-A`). Best-effort by design — the orchestrator does
# NOT fail-close on a non-zero exit here: failing to open the preview subnet only
# degrades the agent's own browser reachability, it never weakens containment.
#
# Verified on a live Docker host (the SHI-90 checklist), not in unit tests — the
# orchestrator-side wiring that feeds it is unit-tested in egress-firewall-install.test.ts.

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
