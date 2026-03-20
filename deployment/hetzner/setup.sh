#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Run as root: bash setup.sh
set -euo pipefail

REPO_URL="https://github.com/nicolasalt/shipit.git"

echo "==========================================="
echo "  ShipIt — Server Provisioning"
echo "==========================================="
echo ""
echo "Prerequisites (make sure these are done before continuing):"
echo "  1. Your domain (e.g. shipit.example.com) is on Cloudflare"
echo "  2. For preview subdomains (*.shipit.example.com), you need either:"
echo "     - A dedicated domain (e.g. shipit.dev) where free-plan wildcards work"
echo "     - OR Advanced Certificate Manager (\$10/mo) for nested wildcards"
echo ""

read -rp "Enter your domain (e.g. shipit.example.com): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "Error: domain is required" >&2
  exit 1
fi

echo ""
echo "--- Zero Trust Access Control (optional) ---"
echo ""
echo "This protects your ShipIt instance so only authorized users can access it."
echo "To set it up now, you need a Cloudflare API token:"
echo ""
echo "  1. Go to: https://dash.cloudflare.com/profile/api-tokens"
echo "  2. Click 'Create Token'"
echo "  3. Use 'Custom token' with permission: Account > Access: Apps and Policies > Edit"
echo "  4. Find your Account ID at: https://dash.cloudflare.com → pick your domain → the ID is in the right sidebar under 'API'"
echo ""
read -rp "Cloudflare API token (leave blank to skip — you can set this up later): " CF_API_TOKEN
if [ -n "$CF_API_TOKEN" ]; then
  read -rp "Cloudflare Account ID: " CF_ACCOUNT_ID
  if [ -z "$CF_ACCOUNT_ID" ]; then
    echo "Error: account ID is required when using API token" >&2
    exit 1
  fi
  echo ""
  echo "Who should have access? Enter either:"
  echo "  - An email domain (e.g. example.com) to allow anyone with that domain"
  echo "  - A specific email (e.g. you@example.com)"
  read -rp "Allowed email domain or email: " CF_ALLOWED_EMAIL
  if [ -z "$CF_ALLOWED_EMAIL" ]; then
    echo "Error: at least one email or domain is required" >&2
    exit 1
  fi
fi

echo ""
echo "==> Installing Docker..."
apt-get update
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

echo ""
echo "==> Authenticating with Cloudflare..."
echo "    A URL will appear below. Open it in your browser to authorize this server."
echo "    (On a headless server, copy-paste the URL to any browser where you're logged into Cloudflare.)"
echo ""
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

if [ -n "$CF_API_TOKEN" ]; then
  echo "==> Creating Zero Trust Access application..."
  APP_RESPONSE=$(curl -sf "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -d "{
      \"name\": \"ShipIt\",
      \"domain\": \"$DOMAIN\",
      \"type\": \"self_hosted\",
      \"session_duration\": \"24h\",
      \"app_launcher_visible\": true,
      \"self_hosted_domains\": [\"$DOMAIN\", \"*.$DOMAIN\"]
    }")

  APP_ID=$(echo "$APP_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$APP_ID" ]; then
    echo "    Warning: failed to create Access application. Response:"
    echo "    $APP_RESPONSE"
    echo "    You can configure access manually — see instructions at the end."
  else
    echo "    Created application: $APP_ID"

    # Determine if input is a domain (contains no @) or a specific email
    if echo "$CF_ALLOWED_EMAIL" | grep -q "@"; then
      INCLUDE_RULE="{\"email\": {\"email\": \"$CF_ALLOWED_EMAIL\"}}"
    else
      INCLUDE_RULE="{\"email_domain\": {\"domain\": \"$CF_ALLOWED_EMAIL\"}}"
    fi

    echo "==> Creating Access policy..."
    POLICY_RESPONSE=$(curl -sf "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$APP_ID/policies" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -d "{
        \"name\": \"Allow team\",
        \"decision\": \"allow\",
        \"include\": [$INCLUDE_RULE]
      }")

    POLICY_ID=$(echo "$POLICY_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -z "$POLICY_ID" ]; then
      echo "    Warning: failed to create Access policy. Response:"
      echo "    $POLICY_RESPONSE"
      echo "    You can add policies manually — see instructions at the end."
    else
      echo "    Created policy: $POLICY_ID"
    fi
  fi
fi

echo "==> Building and starting ShipIt..."
cd /opt/shipit
docker compose -f deployment/hetzner/docker-compose.yml build
docker compose -f deployment/hetzner/docker-compose.yml up -d

echo ""
echo "==========================================="
echo "  Setup complete!"
echo "==========================================="
echo ""
echo "  ShipIt is running at: https://$DOMAIN"
echo ""

if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${APP_ID:-}" ] && [ -n "${POLICY_ID:-}" ]; then
  echo "  Zero Trust access control is configured."
  echo "  To manage policies later: https://one.dash.cloudflare.com → Access → Applications"
elif [ -n "${CF_API_TOKEN:-}" ]; then
  echo "  ⚠ Zero Trust setup had issues — configure manually:"
  echo "    1. Go to: https://one.dash.cloudflare.com"
  echo "    2. Navigate to: Access → Applications → Add an application"
  echo "    3. Choose 'Self-hosted', set domain to: $DOMAIN"
  echo "    4. Add a second domain: *.$DOMAIN"
  echo "    5. Create an Allow policy for your team's emails"
else
  echo "  ⚠ No access control configured — your instance is publicly accessible!"
  echo "  Set up Zero Trust access control:"
  echo "    1. Go to: https://one.dash.cloudflare.com"
  echo "    2. Navigate to: Access → Applications → Add an application"
  echo "    3. Choose 'Self-hosted', set domain to: $DOMAIN"
  echo "    4. Add a second domain: *.$DOMAIN (for preview subdomains)"
  echo "    5. Create an Allow policy for your team's emails"
  echo "    6. Save — users will authenticate through Cloudflare before reaching ShipIt"
fi

echo ""
echo "  Next steps:"
echo "    1. Open https://$DOMAIN in your browser"
if [ -z "${CF_API_TOKEN:-}" ] || [ -z "${APP_ID:-}" ]; then
  echo "    2. If you set up Zero Trust, you'll authenticate through Cloudflare first"
else
  echo "    2. Authenticate through Cloudflare Zero Trust"
fi
echo "    3. ShipIt will prompt you to sign in with your Claude account (OAuth)"
echo "    4. Start coding!"
echo ""
echo "  Useful commands:"
echo "    View logs:      docker compose -f /opt/shipit/deployment/hetzner/docker-compose.yml logs -f shipit"
echo "    Tunnel logs:    journalctl -u cloudflared -f"
echo "    Restart:        docker compose -f /opt/shipit/deployment/hetzner/docker-compose.yml restart"
echo ""
