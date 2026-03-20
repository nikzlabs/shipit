#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Safe to re-run — skips steps that are already done.
# Run as root: bash setup.sh
set -euo pipefail

CONFIG_FILE="/etc/shipit/setup.conf"

# --- Load saved config from previous run, if any ---
DOMAIN=""
REPO_URL=""
ZERO_TRUST_DONE=""
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

# --- Detect repo URL from existing clone, or ask ---
if [ -z "$REPO_URL" ] && [ -d /opt/shipit/.git ]; then
  REPO_URL=$(git -C /opt/shipit remote get-url origin 2>/dev/null || true)
fi
if [ -z "$REPO_URL" ]; then
  read -rp "GitHub repo URL (e.g. https://github.com/you/shipit.git): " REPO_URL
  if [ -z "$REPO_URL" ]; then
    echo "Error: repo URL is required" >&2
    exit 1
  fi
fi

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

if [ -n "$DOMAIN" ]; then
  echo "  Using saved domain: $DOMAIN"
  read -rp "  Press Enter to keep, or type a new domain: " NEW_DOMAIN
  if [ -n "$NEW_DOMAIN" ]; then
    DOMAIN="$NEW_DOMAIN"
  fi
else
  read -rp "Enter your domain (e.g. shipit.example.com): " DOMAIN
  if [ -z "$DOMAIN" ]; then
    echo "Error: domain is required" >&2
    exit 1
  fi
fi

CF_API_TOKEN=""
CF_ACCOUNT_ID=""
CF_ALLOWED_EMAIL=""
if [ "$ZERO_TRUST_DONE" = "true" ]; then
  echo ""
  echo "  Zero Trust access control already configured, skipping."
else
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
fi

# --- Save config for future re-runs (no secrets stored) ---
mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOC
DOMAIN="$DOMAIN"
REPO_URL="$REPO_URL"
ZERO_TRUST_DONE="${ZERO_TRUST_DONE:-}"
EOC
chmod 600 "$CONFIG_FILE"

# --- Clone or update repo ---
if [ -d /opt/shipit/.git ]; then
  echo "==> Repo already cloned, pulling latest..."
  git -C /opt/shipit pull
else
  echo "==> Cloning repo..."
  apt-get update -qq
  apt-get install -y -qq git
  git clone "$REPO_URL" /opt/shipit
fi

# --- Install Docker ---
if command -v docker &>/dev/null; then
  echo "==> Docker already installed, skipping."
else
  echo "==> Installing Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

# --- Install cloudflared ---
if command -v cloudflared &>/dev/null; then
  echo "==> cloudflared already installed, skipping."
else
  echo "==> Installing cloudflared..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi

# --- Authenticate with Cloudflare ---
if [ -f /root/.cloudflared/cert.pem ]; then
  echo "==> Already authenticated with Cloudflare, skipping."
else
  echo ""
  echo "==> Authenticating with Cloudflare..."
  echo "    A URL will appear below. Open it in your browser to authorize this server."
  echo "    (On a headless server, copy-paste the URL to any browser where you're logged into Cloudflare.)"
  echo ""
  cloudflared tunnel login
fi

# --- Create tunnel ---
TUNNEL_NAME="shipit"
if cloudflared tunnel info "$TUNNEL_NAME" &>/dev/null; then
  echo "==> Tunnel '$TUNNEL_NAME' already exists, skipping creation."
else
  echo "==> Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID=$(cloudflared tunnel info "$TUNNEL_NAME" 2>&1 | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
if [ -z "$TUNNEL_ID" ]; then
  echo "Error: could not determine tunnel ID for '$TUNNEL_NAME'" >&2
  echo "Try: cloudflared tunnel list" >&2
  exit 1
fi

# --- Configure tunnel (always overwrite to pick up domain changes) ---
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

# --- DNS routes (idempotent — Cloudflare ignores duplicates) ---
echo "==> Setting up DNS routes..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" || true
cloudflared tunnel route dns "$TUNNEL_NAME" "*.$DOMAIN" || true

# --- Firewall ---
if ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> Firewall already configured, skipping."
else
  echo "==> Configuring firewall (SSH only — all HTTP traffic goes through the tunnel)..."
  apt-get install -y -qq ufw
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw --force enable
fi

# --- cloudflared system service ---
if systemctl is-enabled cloudflared &>/dev/null; then
  echo "==> cloudflared service already installed, restarting to pick up config changes..."
  systemctl restart cloudflared
else
  echo "==> Installing cloudflared as a system service..."
  cloudflared service install
  systemctl enable --now cloudflared
fi

# --- Install jq (needed for Cloudflare API responses) ---
if ! command -v jq &>/dev/null; then
  apt-get install -y -qq jq
fi

# --- Zero Trust Access (optional) ---
if [ -n "${CF_API_TOKEN:-}" ]; then
  CF_API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps"
  CF_AUTH=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")

  echo "==> Creating Zero Trust Access application..."
  APP_RESPONSE=$(curl -s --max-time 30 "$CF_API" "${CF_AUTH[@]}" \
    -d "{
      \"name\": \"ShipIt\",
      \"domain\": \"$DOMAIN\",
      \"type\": \"self_hosted\",
      \"session_duration\": \"24h\",
      \"app_launcher_visible\": true,
      \"self_hosted_domains\": [\"$DOMAIN\", \"*.$DOMAIN\"]
    }" || echo "{}")

  APP_ID=$(echo "$APP_RESPONSE" | jq -r '.result.id // empty' || true)

  # If app already exists, look up its ID so we can still create the policy
  if [ -z "$APP_ID" ]; then
    ERROR_CODE=$(echo "$APP_RESPONSE" | jq -r '.errors[0].code // empty' || true)
    if [ "$ERROR_CODE" = "11010" ]; then
      echo "    Access application already exists, looking up its ID..."
      APPS_LIST=$(curl -s --max-time 30 "$CF_API" "${CF_AUTH[@]}" || echo "{}")
      APP_ID=$(echo "$APPS_LIST" | jq -r '.result[] | select(.domain == "'"$DOMAIN"'") | .id' || true)
      if [ -n "$APP_ID" ]; then
        echo "    Found existing application: $APP_ID"
      else
        echo "    Error: could not find existing app for $DOMAIN"
        echo "    API response: $(echo "$APPS_LIST" | jq -c '.result[]? | {id, name, domain}' || echo "$APPS_LIST")"
      fi
    else
      echo "    Error creating Access application:"
      echo "    $(echo "$APP_RESPONSE" | jq -r '.errors[0].message // "unknown error"' || echo "$APP_RESPONSE")"
    fi
  else
    echo "    Created application: $APP_ID"
  fi

  if [ -z "$APP_ID" ]; then
    echo "    Set up Zero Trust manually at: https://one.dash.cloudflare.com → Access → Applications"
  else
    # Determine if input is a domain (contains no @) or a specific email
    if echo "$CF_ALLOWED_EMAIL" | grep -q "@"; then
      INCLUDE_RULE="{\"email\": {\"email\": \"$CF_ALLOWED_EMAIL\"}}"
    else
      INCLUDE_RULE="{\"email_domain\": {\"domain\": \"$CF_ALLOWED_EMAIL\"}}"
    fi

    echo "==> Creating Access policy..."
    POLICY_RESPONSE=$(curl -s --max-time 30 "$CF_API/$APP_ID/policies" "${CF_AUTH[@]}" \
      -d "{
        \"name\": \"Allow team\",
        \"decision\": \"allow\",
        \"include\": [$INCLUDE_RULE]
      }" || echo "{}")

    POLICY_ID=$(echo "$POLICY_RESPONSE" | jq -r '.result.id // empty' || true)
    if [ -z "$POLICY_ID" ]; then
      echo "    Error creating Access policy:"
      echo "    $(echo "$POLICY_RESPONSE" | jq -r '.errors[0].message // "unknown error"' || echo "$POLICY_RESPONSE")"
      echo "    Manage policies at: https://one.dash.cloudflare.com → Access → Applications"
    else
      echo "    Created policy: $POLICY_ID"
      ZERO_TRUST_DONE="true"
      # Update config so we skip Zero Trust prompts on re-run
      cat > "$CONFIG_FILE" <<EOC
DOMAIN="$DOMAIN"
REPO_URL="$REPO_URL"
ZERO_TRUST_DONE="true"
EOC
      chmod 600 "$CONFIG_FILE"
    fi
  fi
fi

# --- Build and start ShipIt (always run — this is the deploy step) ---
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

if [ "$ZERO_TRUST_DONE" = "true" ]; then
  echo "  Zero Trust access control is configured."
  echo "  To manage policies later: https://one.dash.cloudflare.com → Access → Applications"
else
  echo "  No access control configured — your instance is publicly accessible!"
  echo "  Set up Zero Trust access control:"
  echo "    1. Go to: https://one.dash.cloudflare.com"
  echo "    2. Navigate to: Access → Applications → Add an application"
  echo "    3. Choose 'Self-hosted', set domain to: $DOMAIN"
  echo "    4. Add a second domain: *.$DOMAIN (for preview subdomains)"
  echo "    5. Create an Allow policy for your team's emails"
  echo "    6. Save — users will authenticate through Cloudflare before reaching ShipIt"
  echo "  Or re-run this script and provide a Cloudflare API token when prompted."
fi

echo ""
echo "  Next steps:"
echo "    1. Open https://$DOMAIN in your browser"
if [ "$ZERO_TRUST_DONE" = "true" ]; then
  echo "    2. Authenticate through Cloudflare Zero Trust"
else
  echo "    2. If you set up Zero Trust, you'll authenticate through Cloudflare first"
fi
echo "    3. ShipIt will prompt you to sign in with your Claude account (OAuth)"
echo "    4. Start coding!"
echo ""
echo "  Useful commands:"
echo "    View logs:      docker compose -f /opt/shipit/deployment/hetzner/docker-compose.yml logs -f shipit"
echo "    Tunnel logs:    journalctl -u cloudflared -f"
echo "    Restart:        docker compose -f /opt/shipit/deployment/hetzner/docker-compose.yml restart"
echo ""
echo "==========================================="
echo "  Auto-deploy setup (optional)"
echo "==========================================="
echo ""
# Extract GitHub path (e.g. "you/shipit") from repo URL for display
GITHUB_PATH=$(echo "$REPO_URL" | sed 's|.*github\.com[:/]\(.*\)\.git$|\1|; s|.*github\.com[:/]\(.*\)$|\1|')
echo "  Push to main → auto-deploys to this server via GitHub Actions."
echo "  Add these secrets to your GitHub repo:"
echo "    Go to: github.com/$GITHUB_PATH/settings/secrets/actions"
echo ""
echo "    DEPLOY_HOST     = $DOMAIN"
echo "    DEPLOY_SSH_KEY  = contents of ~/.ssh/shipit-deploy (the private key)"
echo "    DEPLOY_USER     = root"
echo ""
echo "  The workflow is already at .github/workflows/deploy.yml."
echo "  Every push to main will SSH in, rebuild, and restart automatically."
echo ""
echo "  To deploy manually instead:"
echo "     ssh root@$DOMAIN"
echo "     cd /opt/shipit && git pull"
echo "     docker compose -f deployment/hetzner/docker-compose.yml build session-worker shipit"
echo "     docker compose -f deployment/hetzner/docker-compose.yml up -d --no-build shipit"
echo ""
