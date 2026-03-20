#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Run as root: bash setup.sh
set -euo pipefail

REPO_URL="https://github.com/nicolasalt/shipit.git"

echo "==> Cloning repo..."
apt-get update
apt-get install -y git
git clone "$REPO_URL" /opt/shipit

read -rp "Enter your domain (e.g. shipit.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "Error: domain is required" >&2
  exit 1
fi

echo "==> Installing Docker..."
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "==> Installing cloudflared..."
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb
rm /tmp/cloudflared.deb

echo "==> Authenticating with Cloudflare..."
echo "    A URL will appear below — open it in your browser to authorize cloudflared."
cloudflared tunnel login

TUNNEL_NAME="shipit"
echo "==> Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME"
TUNNEL_ID=$(cloudflared tunnel info "$TUNNEL_NAME" --output json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "==> Configuring tunnel..."
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOL
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: "$DOMAIN"
    service: http://localhost:4123
  - hostname: "*.$DOMAIN"
    service: http://localhost:4123
  - service: http_status:404
EOL

echo "==> Setting up DNS routes..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"
cloudflared tunnel route dns "$TUNNEL_NAME" "*.$DOMAIN"

echo "==> Configuring firewall (SSH only — all HTTP traffic goes through the tunnel)..."
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "==> Installing cloudflared as a system service..."
cloudflared service install
systemctl enable --now cloudflared

echo "==> Building and starting ShipIt..."
cd /opt/shipit
docker compose -f deployment/hetzner/docker-compose.yml build
docker compose -f deployment/hetzner/docker-compose.yml up -d

echo ""
echo "==> Done! ShipIt is running at https://$DOMAIN"
echo "    Configure access policies in Cloudflare Zero Trust dashboard:"
echo "    https://one.dash.cloudflare.com → Access → Applications"
echo "    Then visit https://$DOMAIN and complete Claude CLI OAuth."
