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
#     2. Resolve a wildcard host to the node. By DEFAULT this uses sslip.io, a
#        public wildcard DNS resolver: {id}--{port}.<dashed-tailnet-ip>.sslip.io
#        resolves straight back to the node's 100.x address, with NO tailnet
#        policy edit and NO owned domain — it works on any Tailscale version,
#        the moment the script finishes. The orchestrator's subdomain proxy
#        already matches {uuid}--{port}.anything, so no app changes are needed.
#   Optional upgrade to a cleaner hostname (no third-party resolver): grant the
#   node Tailscale's native MagicDNS wildcard capability (`dns-subdomain-resolve`
#   node attr, clients v1.96+) so *.<node>.tailnet.ts.net resolves to the node.
#   That is an ACL grant the operator adds once — this script prints the block —
#   but Tailscale gates it per-tailnet at the control plane, so saving it can be
#   rejected with "tailnet is not permitted to use the 'dns-subdomain-resolve'
#   node attribute"; the sslip.io default keeps working regardless.
#   Access is HTTP over the WireGuard-encrypted tailnet (no wildcard TLS cert
#   exists for *.ts.net — tracked upstream at tailscale/tailscale#7081). For real
#   HTTPS, point an owned wildcard domain at the node IP (see deployment/README.md).
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

# --- Terminal colors (only when stdout is a TTY) ----------------------------
# The one-time ACL step is easy to scroll past, so the banner and the
# paste-this block are colored to stand out from the rest of the output.
if [ -t 1 ]; then
  C_BANNER=$'\033[1;33m'   # bold yellow — the can't-miss one-time step
  C_STEP=$'\033[1;36m'     # bold cyan   — the numbered steps
  C_PASTE=$'\033[0;32m'    # green       — the literal block to paste
  C_RESET=$'\033[0m'
else
  C_BANNER='' C_STEP='' C_PASTE='' C_RESET=''
fi

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
# Default preview path: sslip.io wildcard DNS. sslip.io is a public resolver
# that maps any <dashed-ip>.sslip.io name straight back to that IP — here the
# node's tailnet 100.x address. So {id}--{port}.<dashed-ip>.sslip.io resolves
# to the node with ZERO policy edits and ZERO owned domain; the forwarder above
# delivers it to the orchestrator's subdomain proxy (the proxy's regex already
# matches {uuid}--{port}.anything, so no app changes). Dash notation also dodges
# the client's dotted-IPv4 guard, which would otherwise refuse to build a
# subdomain URL for a raw 100.x host. Traffic still rides the WireGuard-encrypted
# tailnet; HTTP only (there is no wildcard TLS cert for these names).
SSLIP_HOST="${TS_IP//./-}.sslip.io"
MAGICDNS_HOST="${TAILSCALE_FQDN:-$HOSTNAME}"
PORT_SUFFIX=""
if [ "$LISTEN_PORT" != "80" ]; then
  PORT_SUFFIX=":${LISTEN_PORT}"
fi

echo ""
echo "${C_BANNER}===========================================${C_RESET}"
echo "${C_BANNER}  Tailscale access configured${C_RESET}"
echo "${C_BANNER}===========================================${C_RESET}"
echo ""
echo "  Open ShipIt over Tailscale at:"
echo "${C_PASTE}      http://${SSLIP_HOST}${PORT_SUFFIX}${C_RESET}"
echo ""
echo "  Previews resolve automatically — no tailnet policy changes needed — at:"
echo "${C_PASTE}      {sessionId}--{port}.${SSLIP_HOST}${PORT_SUFFIX}${C_RESET}"
echo ""
echo "  How: sslip.io is a public wildcard DNS resolver that maps any"
echo "  <dashed-ip>.sslip.io name back to that IP — here this node's tailnet"
echo "  address (${TS_IP}). DNS resolution is public; the traffic itself rides"
echo "  the WireGuard-encrypted tailnet. HTTP only (no wildcard TLS for .ts.net),"
echo "  which is safe over the encrypted tailnet."
echo ""
echo "  Forwarder: ${TS_IP}:${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT} (Host preserved)"
echo "  Any existing Cloudflare tunnel access is unchanged."
echo ""
echo "  If a device's DNS refuses sslip.io (some resolvers block public names"
echo "  that point into CGNAT 100.64/10 as DNS-rebinding protection), use one of"
echo "  the two alternatives below."
echo ""
echo "${C_BANNER}-------------------------------------------------------------------------${C_RESET}"
echo "${C_BANNER}  OPTIONAL — a cleaner hostname (no third-party resolver)${C_RESET}"
echo "${C_BANNER}-------------------------------------------------------------------------${C_RESET}"
echo ""
echo "  The sslip.io URL above works today. If you'd rather use this node's"
echo "  native MagicDNS name (http://${MAGICDNS_HOST}${PORT_SUFFIX}) and have"
echo "  previews resolve at {sessionId}--{port}.${MAGICDNS_HOST}, grant this"
echo "  node the MagicDNS wildcard capability in your tailnet policy file:"
echo ""
echo "${C_STEP}    1. Open  https://login.tailscale.com/admin/acls${C_RESET}"
echo "${C_STEP}    2. Click the 'JSON editor' toggle at the top of the page.${C_RESET}"
echo "${C_STEP}    3. Add this block as a TOP-LEVEL key inside the policy object${C_RESET}"
echo "${C_STEP}       — a sibling of \"acls\"/\"groups\", not nested inside them.${C_RESET}"
echo "${C_STEP}       Mind JSON commas: keys are comma-separated.${C_RESET}"
echo ""
echo "${C_PASTE}      \"nodeAttrs\": [${C_RESET}"
echo "${C_PASTE}        {${C_RESET}"
echo "${C_PASTE}          \"target\": [\"${TS_IP}\"],${C_RESET}"
echo "${C_PASTE}          \"attr\": [\"dns-subdomain-resolve\"]${C_RESET}"
echo "${C_PASTE}        }${C_RESET}"
echo "${C_PASTE}      ]${C_RESET}"
echo ""
echo "${C_STEP}    4. Click Save.${C_RESET}"
echo ""
echo "  (In the Visual editor this same grant lives under Definitions ->"
echo "  Node attributes, but the JSON editor is the direct way to paste it.)"
echo ""
echo "  Requires Tailscale v1.96+ on this node and the devices you browse from."
echo "  Note: Tailscale gates this capability per-tailnet at the control plane"
echo "  and is still rolling it out, so Save may be rejected with \"tailnet is"
echo "  not permitted to use the 'dns-subdomain-resolve' node attribute\". If so,"
echo "  request access from Tailscale (support / feature preview) — the sslip.io"
echo "  URL above keeps working in the meantime. For real HTTPS instead of HTTP,"
echo "  point a wildcard DNS record you own (e.g. *.shipit-tail.example.com) at"
echo "  ${TS_IP} and open ShipIt through that hostname."
echo ""
