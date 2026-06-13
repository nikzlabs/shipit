#!/usr/bin/env bash
#
# Egress controlled-resolver — docs/172-agent-containment Gap 1 (SHI-90), Tier B.
#
# Long-lived companion to the Tier A installer. Runs dnsmasq in the AGENT's
# network namespace (sidecar started with `--network container:<agent>
# --cap-add NET_ADMIN`), listening on 127.0.0.1:53. The agent's resolv.conf is
# pointed here (Docker `--dns 127.0.0.1`). dnsmasq:
#   - forwards ONLY allowlisted domains to a real upstream (everything else is
#     refused — closing DNS-tunneling exfil), and
#   - pins the IPs it resolves for those domains into the Tier A egress ipset
#     (`ipset=` directives), so the firewall always permits exactly what was
#     just resolved (no stale-IP breakage).
#
# Config is generated orchestrator-side (egress-dns.ts, unit-tested) and passed
# base64-encoded in EGRESS_DNSMASQ_CONFIG_B64. dnsmasq starts as root (to bind
# :53 and write the ipset) then drops to the `user=` in the config — the uid the
# Tier A firewall's owner-match allows for upstream DNS.
#
# Verified on a live host (the SHI-90 Tier B checklist), not in unit tests.

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

# --keep-in-foreground so the container stays up; logs to stderr.
exec dnsmasq --keep-in-foreground --conf-file="$CONF" --log-facility=- --log-queries
