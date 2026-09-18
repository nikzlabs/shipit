#!/usr/bin/env bash
#
# Run the controlled resolver in the agent network namespace.

set -euo pipefail

CONF=/etc/dnsmasq.d/egress.conf
mkdir -p /etc/dnsmasq.d

if [[ -z "${EGRESS_DNSMASQ_CONFIG_B64:-}" ]]; then
  echo "[egress-resolver] FATAL: EGRESS_DNSMASQ_CONFIG_B64 not set" >&2
  exit 1
fi
echo "$EGRESS_DNSMASQ_CONFIG_B64" | base64 -d > "$CONF"

echo "[egress-resolver] dnsmasq config:"
sed 's/^/  /' "$CONF"

exec dnsmasq --keep-in-foreground --conf-file="$CONF" --log-facility=- --log-queries
