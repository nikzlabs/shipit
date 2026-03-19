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
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
# Install xcaddy to build Caddy with plugins
apt-get install -y golang-go
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
~/go/bin/xcaddy build --with github.com/caddy-dns/cloudflare --output /usr/bin/caddy

echo "==> Setting up Caddy directories, config, and systemd service..."
mkdir -p /etc/caddy
mkdir -p /var/lib/caddy/.local/share/caddy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/Caddyfile" ]; then
  cp "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile
  echo "    Copied Caddyfile to /etc/caddy/Caddyfile"
else
  echo "    WARNING: Caddyfile not found next to setup.sh — copy it manually later"
fi
useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy web server
After=network.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

echo "==> Configuring firewall..."
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Done! Next steps:"
echo "  1. Edit /etc/caddy/Caddyfile — replace shipit.example.com with your domain"
echo "  2. Set env vars:      See deployment/README.md Step 4 (CF token, auth user/hash)"
echo "  3. Start Caddy:       systemctl enable --now caddy"
echo "  4. Build & start:     docker compose -f deployment/hetzner/docker-compose.yml build && docker compose -f deployment/hetzner/docker-compose.yml up -d"
echo "  5. Authenticate:      Visit https://your-domain and complete Claude CLI OAuth"
