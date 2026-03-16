#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Run as root: bash setup.sh
set -euo pipefail

echo "==> Installing Docker..."
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "==> Installing Caddy with Cloudflare DNS plugin..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/caddyserver/debian/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
# Install xcaddy to build Caddy with plugins
apt-get install -y golang-go
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
~/go/bin/xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

echo "==> Configuring firewall..."
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Creating app directory..."
mkdir -p /opt/shipit
cd /opt/shipit

echo "==> Done! Next steps:"
echo "  1. Clone repo:        git clone <your-repo-url> /opt/shipit"
echo "  2. Copy Caddyfile:    cp deployment/hetzner/Caddyfile /etc/caddy/Caddyfile"
echo "  3. Set env vars:      See deployment/README.md Step 4 (CF token, auth user/hash)"
echo "  4. Start Caddy:       systemctl enable --now caddy"
echo "  5. Build & start:     cd /opt/shipit && docker compose -f deployment/hetzner/docker-compose.yml build && docker compose -f deployment/hetzner/docker-compose.yml up -d"
echo "  6. Authenticate:      Visit https://shipit.example.com and complete Claude CLI OAuth"
