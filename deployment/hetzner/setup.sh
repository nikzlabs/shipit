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

echo ""
echo "    To set up Zero Trust access control, you need a Cloudflare API token."
echo "    Create one at: https://dash.cloudflare.com/profile/api-tokens"
echo "    Required permissions: Account > Access: Apps and Policies > Edit"
echo ""
read -rp "Cloudflare API token (leave blank to skip — you can configure access later in the dashboard): " CF_API_TOKEN
if [ -n "$CF_API_TOKEN" ]; then
  read -rp "Cloudflare Account ID (found on the dashboard overview page): " CF_ACCOUNT_ID
  if [ -z "$CF_ACCOUNT_ID" ]; then
    echo "Error: account ID is required when using API token" >&2
    exit 1
  fi
  read -rp "Allowed email domain (e.g. example.com) or specific email: " CF_ALLOWED_EMAIL
  if [ -z "$CF_ALLOWED_EMAIL" ]; then
    echo "Error: at least one email or domain is required" >&2
    exit 1
  fi
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
    echo "    You can configure access manually in the Zero Trust dashboard."
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
      echo "    You can add policies manually in the Zero Trust dashboard."
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
echo "==> Done! ShipIt is running at https://$DOMAIN"
if [ -n "$CF_API_TOKEN" ] && [ -n "$APP_ID" ]; then
  echo "    Zero Trust access control is configured."
  echo "    Manage policies at: https://one.dash.cloudflare.com → Access → Applications"
else
  echo "    Configure access policies in Cloudflare Zero Trust dashboard:"
  echo "    https://one.dash.cloudflare.com → Access → Applications"
fi
echo "    Then visit https://$DOMAIN and complete Claude CLI OAuth."
