#!/usr/bin/env bash
#
# Whether this host can install the local block (docs/319 req 6). Run with
# --network none and NET_ADMIN, so the rules land in a namespace of its own.

set -euo pipefail

iptables -N SHIPIT-PROBE
iptables -A SHIPIT-PROBE -m addrtype --dst-type BROADCAST -j DROP
iptables -A SHIPIT-PROBE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A SHIPIT-PROBE -d 169.254.0.0/16 -j DROP
iptables -A OUTPUT -j SHIPIT-PROBE
echo "local block supported"
