#!/bin/bash
# Optional private Tailscale access for an existing ShipIt VPS deployment.
#
# This is intentionally additive: it leaves the Cloudflare tunnel, firewall,
# and Docker compose bindings alone. ShipIt continues to listen on localhost;
# Tailscale Serve proxies tailnet-only HTTPS traffic to that local listener.
#
# Usage:
#   bash /opt/shipit/deployment/vps/tailscale.sh
#
# Optional environment:
#   SHIPIT_TAILSCALE_HOSTNAME=shipit
#   SHIPIT_TAILSCALE_AUTHKEY=tskey-auth-...
set -euo pipefail

HOSTNAME="${SHIPIT_TAILSCALE_HOSTNAME:-shipit}"
SHIPIT_URL="http://127.0.0.1:4123"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root, e.g. sudo bash /opt/shipit/deployment/vps/tailscale.sh" >&2
  exit 1
fi

echo "==========================================="
echo "  ShipIt — Tailscale private access"
echo "==========================================="
echo ""
echo "This keeps the existing Cloudflare path working and adds tailnet-only access."
echo "For subdomain previews, configure wildcard DNS for the hostname you use over Tailscale."
echo ""

if command -v tailscale &>/dev/null; then
  echo "==> Tailscale already installed, skipping install."
else
  echo "==> Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

if ! systemctl is-enabled tailscaled &>/dev/null; then
  echo "==> Enabling tailscaled..."
  systemctl enable --now tailscaled
else
  systemctl start tailscaled
fi

if tailscale ip -4 &>/dev/null; then
  echo "==> Tailscale is already authenticated."
  if tailscale set --hostname="$HOSTNAME" &>/dev/null; then
    echo "==> Hostname set to '$HOSTNAME'."
  else
    echo "==> Could not update hostname with 'tailscale set'; keeping existing Tailscale hostname."
  fi
else
  echo "==> Authenticating this server with Tailscale..."
  if [ -n "${SHIPIT_TAILSCALE_AUTHKEY:-}" ]; then
    tailscale up --hostname="$HOSTNAME" --authkey="$SHIPIT_TAILSCALE_AUTHKEY"
  else
    echo "    A login URL will appear below. Open it in a browser where you are logged into Tailscale."
    tailscale up --hostname="$HOSTNAME"
  fi
fi

echo "==> Exposing ShipIt privately with Tailscale Serve..."
tailscale serve --bg "$SHIPIT_URL"

TAILSCALE_FQDN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)"

echo ""
echo "==========================================="
echo "  Tailscale access configured"
echo "==========================================="
echo ""
if [ -n "$TAILSCALE_FQDN" ]; then
  echo "  Tailnet HTTPS: https://$TAILSCALE_FQDN"
fi
echo ""
echo "  Serve status:"
tailscale serve status || true
echo ""
echo "Cloudflare tunnel access is unchanged."
echo "For Tailscale subdomain previews, ensure wildcard DNS resolves"
echo "{sessionId}--{port}.<your-tailscale-shipit-host> to this machine."
echo ""
