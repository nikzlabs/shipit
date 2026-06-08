#!/bin/bash
# Optional private Tailscale access for an existing ShipIt VPS deployment.
#
# This is intentionally additive: it leaves any existing Cloudflare tunnel,
# firewall, and Docker compose bindings alone. ShipIt continues to listen on
# 127.0.0.1:4123; this script exposes that listener to the tailnet so that both
# the app AND subdomain previews work over Tailscale.
#
# Preview routing (why this is not Tailscale Serve):
#   ShipIt previews are served on subdomains — {sessionId}--{port}.<host>.
#   Tailscale Serve binds ONLY the node's own MagicDNS name and cannot carry
#   {sessionId}--{port}.shipit.tailnet.ts.net, so previews over a Serve URL are
#   structurally impossible. Instead we:
#     1. Forward the node's tailnet IP :4123 -> 127.0.0.1:4123 at the TCP level
#        (Host header preserved), so the orchestrator's subdomain proxy can route.
#     2. Rely on Tailscale's native MagicDNS wildcard resolution
#        (`dns-subdomain-resolve` node capability, GA since ~v1.96) so that
#        *.shipit.tailnet.ts.net resolves to this node. That capability is an
#        ACL grant the operator adds once — this script prints the exact block.
#   Access is HTTP over the WireGuard-encrypted tailnet (no wildcard TLS cert
#   exists for *.ts.net — tracked upstream at tailscale/tailscale#7081).
#
# Usage:
#   bash /opt/shipit/deployment/vps/tailscale.sh
#
# Optional environment:
#   SHIPIT_TAILSCALE_HOSTNAME=shipit
#   SHIPIT_TAILSCALE_AUTHKEY=tskey-auth-...
#   SHIPIT_TAILSCALE_PORT=4123        # tailnet-facing port for ShipIt
set -euo pipefail

HOSTNAME="${SHIPIT_TAILSCALE_HOSTNAME:-shipit}"
LISTEN_PORT="${SHIPIT_TAILSCALE_PORT:-4123}"
BACKEND_PORT=4123
FORWARD_WRAPPER="/usr/local/bin/shipit-tailscale-forward.sh"
FORWARD_UNIT="/etc/systemd/system/shipit-tailscale-preview.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root, e.g. sudo bash /opt/shipit/deployment/vps/tailscale.sh" >&2
  exit 1
fi

echo "==========================================="
echo "  ShipIt — Tailscale private access"
echo "==========================================="
echo ""
echo "This adds tailnet-only access (app + subdomain previews) without changing"
echo "any existing Cloudflare path. Previews use native MagicDNS wildcard"
echo "resolution; this script prints the one ACL grant you need to add."
echo ""

# --- Install Tailscale ------------------------------------------------------
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

# --- Authenticate + set hostname --------------------------------------------
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

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
TAILSCALE_FQDN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)"

if [ -z "$TS_IP" ]; then
  echo "Error: could not determine this node's Tailscale IPv4 address." >&2
  echo "       Is the node authenticated? Try 'tailscale status'." >&2
  exit 1
fi

# Drop any Tailscale Serve config from a previous version of this script. Serve
# binds only the node's own MagicDNS name and cannot carry preview subdomains,
# so an upgraded box would otherwise keep serving the app at https://<node>
# (443) with broken previews and no signal as to why. The forwarder below is
# the supported preview path; Serve is intentionally not used.
tailscale serve reset 2>/dev/null || true

# --- Install socat (TCP forwarder, Host-preserving) -------------------------
if ! command -v socat &>/dev/null; then
  echo "==> Installing socat (tailnet forwarder)..."
  apt-get update -qq
  apt-get install -y -qq socat
fi

# --- Forwarder: tailnet IP :LISTEN_PORT -> 127.0.0.1:4123 -------------------
# A wrapper re-reads the tailnet IP at start so a re-auth that changes the IP
# self-heals on the next restart. Bound to the tailnet IP specifically (NOT
# 0.0.0.0) so the listener is never exposed on a public interface.
echo "==> Installing tailnet forwarder (${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT})..."
cat > "$FORWARD_WRAPPER" <<EOF
#!/bin/bash
set -euo pipefail
# Resolve the current tailnet IPv4 at start (survives re-auth IP changes).
TS_IP="\$(tailscale ip -4 2>/dev/null | head -n1)"
if [ -z "\$TS_IP" ]; then
  echo "shipit-tailscale-forward: no tailnet IPv4 yet; retrying shortly" >&2
  exit 1
fi
exec socat TCP-LISTEN:${LISTEN_PORT},bind=\${TS_IP},fork,reuseaddr TCP:127.0.0.1:${BACKEND_PORT}
EOF
chmod +x "$FORWARD_WRAPPER"

cat > "$FORWARD_UNIT" <<EOF
[Unit]
Description=ShipIt Tailscale preview forwarder (tailnet -> orchestrator, Host preserved)
After=tailscaled.service docker.service
Wants=tailscaled.service

[Service]
ExecStart=${FORWARD_WRAPPER}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now shipit-tailscale-preview.service
systemctl restart shipit-tailscale-preview.service

# --- Output -----------------------------------------------------------------
SHIPIT_HOST="${TAILSCALE_FQDN:-$HOSTNAME}"
PORT_SUFFIX=""
if [ "$LISTEN_PORT" != "80" ]; then
  PORT_SUFFIX=":${LISTEN_PORT}"
fi

echo ""
echo "==========================================="
echo "  Tailscale access configured"
echo "==========================================="
echo ""
echo "  Open ShipIt over Tailscale at:"
echo "      http://${SHIPIT_HOST}${PORT_SUFFIX}"
echo ""
echo "  Forwarder: ${TS_IP}:${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT} (Host preserved)"
echo "  Any existing Cloudflare tunnel access is unchanged."
echo ""
echo "-------------------------------------------------------------------------"
echo "  ONE-TIME STEP — enable subdomain previews over Tailscale"
echo "-------------------------------------------------------------------------"
echo ""
echo "  Previews are served at {sessionId}--{port}.${SHIPIT_HOST}. For those"
echo "  hostnames to resolve over your tailnet, grant this node the MagicDNS"
echo "  wildcard capability by editing your tailnet policy file:"
echo ""
echo "    1. Open  https://login.tailscale.com/admin/acls"
echo "    2. Click the 'JSON editor' toggle at the top of the page."
echo "    3. Add the block below as a TOP-LEVEL key inside the policy"
echo "       object — a sibling of \"acls\"/\"groups\", not nested inside"
echo "       them. Mind JSON commas: keys are comma-separated."
echo "    4. Click Save."
echo ""
echo '      "nodeAttrs": ['
echo '        {'
echo "          \"target\": [\"${TS_IP}\"],"
echo '          "attr": ["dns-subdomain-resolve"]'
echo '        }'
echo '      ]'
echo ""
echo "  (In the Visual editor this same grant lives under Definitions ->"
echo "  Node attributes, but the JSON editor is the direct way to paste it.)"
echo ""
echo "  (Requires Tailscale v1.96+ on this node and the devices you browse from.)"
echo "  Until that grant is added, the app works but previews won't resolve."
echo ""
