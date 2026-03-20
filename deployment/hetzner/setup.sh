#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Run as root: bash setup.sh
set -euo pipefail

REPO_URL="https://github.com/nicolasalt/shipit.git"

echo "==> Cloning repo..."
apt-get update
apt-get install -y git
git clone "$REPO_URL" /opt/shipit
DEPLOY_DIR=/opt/shipit/deployment/hetzner

read -rp "Enter your domain (e.g. shipit.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "Error: domain is required" >&2
  exit 1
fi

read -rp "Enter a username for the web UI (e.g. admin): " AUTH_USER
if [ -z "$AUTH_USER" ]; then
  echo "Error: username is required" >&2
  exit 1
fi

read -rsp "Enter a password for the web UI: " AUTH_PASS
echo
if [ -z "$AUTH_PASS" ]; then
  echo "Error: password is required" >&2
  exit 1
fi

echo "==> Installing Docker..."
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "==> Installing Caddy..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "==> Setting up Caddy directories, config, and systemd service..."
mkdir -p /etc/caddy
mkdir -p /var/lib/caddy/.local/share/caddy

cp "$DEPLOY_DIR/Caddyfile" /etc/caddy/Caddyfile
sed -i "s/shipit\.example\.com/$DOMAIN/g" /etc/caddy/Caddyfile
echo "    Installed Caddyfile for $DOMAIN"
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

echo "==> Configuring basic auth..."
AUTH_HASH=$(caddy hash-password --plaintext "$AUTH_PASS")
cat > /etc/caddy/environment <<EOL
SHIPIT_AUTH_USER=$AUTH_USER
SHIPIT_AUTH_HASH=$AUTH_HASH
EOL

echo "==> Starting Caddy..."
systemctl enable --now caddy

echo "==> Building and starting ShipIt..."
cd /opt/shipit
docker compose -f deployment/hetzner/docker-compose.yml build
docker compose -f deployment/hetzner/docker-compose.yml up -d

echo ""
echo "==> Done! ShipIt is running at https://$DOMAIN"
echo "    Log in with username '$AUTH_USER' and your chosen password, then complete Claude CLI OAuth."
