#!/bin/bash
# Cloudflare Tunnel access for an existing ShipIt VPS deployment.
#
# Usage:
#   bash /opt/shipit/deployment/vps/cloudflare.sh
#
# Cloudflare Zero Trust is required by default because the tunnel publishes
# ShipIt on $DOMAIN and *.$DOMAIN. For deliberate testing or when another
# access layer is already in front of the hostname, opt out explicitly:
#
#   SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1 bash /opt/shipit/deployment/vps/cloudflare.sh
#
# Every question here can be answered in advance, so that an agent can collect
# the answers from the person and run this without a stop (docs/276):
#
#   SHIPIT_CF_DOMAIN=shipit.example.com
#   SHIPIT_CF_API_TOKEN=...            # secret: never logged, never stored
#   SHIPIT_CF_ACCOUNT_ID=...
#   SHIPIT_CF_ALLOWED_EMAIL=you@example.com
set -euo pipefail

CONFIG_FILE="/etc/shipit/setup.conf"

DOMAIN=""
REPO_URL=""
ZERO_TRUST_DONE=""
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

ALLOW_PUBLIC_UNAUTHENTICATED="${SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED:-}"
ZERO_TRUST_REQUIRED=false

stop_public_tunnel_after_failed_zero_trust() {
  if [ "$ZERO_TRUST_REQUIRED" != "true" ] || [ "$ZERO_TRUST_DONE" = "true" ]; then
    return
  fi

  echo "Zero Trust setup did not complete; stopping cloudflared so ShipIt is not left publicly routed." >&2
  if command -v systemctl &>/dev/null && systemctl is-active cloudflared &>/dev/null; then
    systemctl stop cloudflared || true
  fi
}

trap stop_public_tunnel_after_failed_zero_trust EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root, e.g. sudo bash /opt/shipit/deployment/vps/cloudflare.sh" >&2
  exit 1
fi

echo "==========================================="
echo "  ShipIt - Cloudflare Tunnel access"
echo "==========================================="
echo ""
echo "Prerequisites (make sure these are done before continuing):"
echo "  1. Your domain (e.g. shipit.example.com) is on Cloudflare"
echo "  2. For preview subdomains (*.shipit.example.com), you need either:"
echo "     - A dedicated domain (e.g. ship-it.ai) where free-plan wildcards work"
echo "     - OR Advanced Certificate Manager (\$10/mo) for nested wildcards"
echo ""

# Every question below takes an answer from the environment (docs/276 req 10).
# Without that, an agent-run install could set up everything EXCEPT the path that
# produces a public HTTPS URL, and would stop here with no way to continue.
#
# ask_or_env <variable-name> <prompt> [--secret]
# -> ANSWER holds the value. A missing answer with no terminal names the variable
#    that would have supplied it, instead of `read` dying under `set -e`.
ANSWER=""
ask_or_env() {
  local var="$1" prompt="$2" secret="${3:-}"
  ANSWER="${!var:-}"
  if [ -n "$ANSWER" ]; then
    if [ "$secret" = "--secret" ]; then
      echo "  $var: taken from the environment."
    else
      echo "  $var: $ANSWER (from the environment)"
    fi
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "Error: no terminal to ask on. Set $var before the command to answer this." >&2
    exit 1
  fi
  if [ "$secret" = "--secret" ]; then
    read -rsp "$prompt" ANSWER
    echo ""
  else
    read -rp "$prompt" ANSWER
  fi
}

if [ -n "${SHIPIT_CF_DOMAIN:-}" ]; then
  DOMAIN="$SHIPIT_CF_DOMAIN"
  echo "  Domain: $DOMAIN (from the environment)"
elif [ -n "$DOMAIN" ]; then
  echo "  Using saved domain: $DOMAIN"
  # Only offered when someone is there to answer; with no terminal the saved
  # domain stands, rather than `read` failing the script at EOF.
  if [ -t 0 ]; then
    read -rp "  Press Enter to keep, or type a new domain: " NEW_DOMAIN
    if [ -n "$NEW_DOMAIN" ]; then
      DOMAIN="$NEW_DOMAIN"
    fi
  fi
else
  ask_or_env SHIPIT_CF_DOMAIN "Enter your domain (e.g. shipit.example.com): "
  DOMAIN="$ANSWER"
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
elif [ "$ALLOW_PUBLIC_UNAUTHENTICATED" = "1" ]; then
  echo ""
  echo "WARNING: Cloudflare Zero Trust is disabled by explicit override."
  echo "Anyone who can reach https://$DOMAIN or https://*.$DOMAIN can reach ShipIt."
  echo "Only use this for deliberate testing or when another access layer protects the hostname."
else
  ZERO_TRUST_REQUIRED=true
  echo ""
  echo "--- Zero Trust Access Control (required) ---"
  echo ""
  echo "ShipIt exposes repository access, terminal access, secrets, agent execution,"
  echo "and GitHub operations. Cloudflare Tunnel would publish it at:"
  echo "  https://$DOMAIN"
  echo "  https://*.$DOMAIN"
  echo ""
  echo "Zero Trust is required before the tunnel is routed. To configure it now,"
  echo "provide a Cloudflare API token:"
  echo ""
  echo "  1. Go to: https://dash.cloudflare.com/profile/api-tokens"
  echo "  2. Click 'Create Token'"
  echo "  3. Use 'Custom token' with permission: Account > Access: Apps and Policies > Edit"
  echo "  4. Find your Account ID at: https://dash.cloudflare.com -> pick your domain -> the ID is in the right sidebar under 'API'"
  echo "  5. To deliberately publish without Zero Trust, rerun with:"
  echo "     SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1 bash /opt/shipit/deployment/vps/cloudflare.sh"
  echo ""
  # The token is a secret: it is never echoed, never written to $CONFIG_FILE, and
  # never passed as an argument the process table would show (docs/276 req 11).
  ask_or_env SHIPIT_CF_API_TOKEN "Cloudflare API token: " --secret
  CF_API_TOKEN="$ANSWER"
  if [ -z "$CF_API_TOKEN" ]; then
    echo "Error: Cloudflare Zero Trust is required for Cloudflare Tunnel setup." >&2
    echo "Provide an API token, or rerun with SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1 to explicitly allow public unauthenticated access." >&2
    exit 1
  fi
  ask_or_env SHIPIT_CF_ACCOUNT_ID "Cloudflare Account ID: "
  CF_ACCOUNT_ID="$ANSWER"
  if [ -z "$CF_ACCOUNT_ID" ]; then
    echo "Error: account ID is required when using API token" >&2
    exit 1
  fi
  echo ""
  echo "Who should have access? Enter either:"
  echo "  - An email domain (e.g. example.com) to allow anyone with that domain"
  echo "  - A specific email (e.g. you@example.com)"
  ask_or_env SHIPIT_CF_ALLOWED_EMAIL "Allowed email domain or email: "
  CF_ALLOWED_EMAIL="$ANSWER"
  if [ -z "$CF_ALLOWED_EMAIL" ]; then
    echo "Error: at least one email or domain is required" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOC
DOMAIN="$DOMAIN"
REPO_URL="$REPO_URL"
ZERO_TRUST_DONE="${ZERO_TRUST_DONE:-}"
EOC
chmod 600 "$CONFIG_FILE"

if command -v cloudflared &>/dev/null; then
  echo "==> cloudflared already installed, skipping."
else
  echo "==> Installing cloudflared..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm /tmp/cloudflared.deb
fi

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

if ! command -v jq &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq jq
fi

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

  if [ -z "$APP_ID" ]; then
    ERROR_CODE=$(echo "$APP_RESPONSE" | jq -r '.errors[0].code // empty' || true)
    if [ "$ERROR_CODE" = "11010" ]; then
      echo "    Access application already exists, looking up its ID..."
      APPS_LIST=$(curl -s --max-time 30 "$CF_API" "${CF_AUTH[@]}" || echo "{}")
      APP_ID=$(echo "$APPS_LIST" | jq -r '.result[] | select(.domain == "'"$DOMAIN"'") | .id' || true)
      if [ -n "$APP_ID" ]; then
        echo "    Found existing application: $APP_ID"
      else
        echo "Error: could not find existing Access application for $DOMAIN" >&2
        echo "API response: $(echo "$APPS_LIST" | jq -c '.result[]? | {id, name, domain}' || echo "$APPS_LIST")" >&2
        exit 1
      fi
    else
      echo "Error creating Access application:" >&2
      echo "$(echo "$APP_RESPONSE" | jq -r '.errors[0].message // "unknown error"' || echo "$APP_RESPONSE")" >&2
      exit 1
    fi
  else
    echo "    Created application: $APP_ID"
  fi

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
    echo "Error creating Access policy:" >&2
    echo "$(echo "$POLICY_RESPONSE" | jq -r '.errors[0].message // "unknown error"' || echo "$POLICY_RESPONSE")" >&2
    echo "Cloudflare Tunnel routing was not configured. Fix Zero Trust setup and rerun this script." >&2
    exit 1
  fi

  echo "    Created policy: $POLICY_ID"
  ZERO_TRUST_DONE="true"
  cat > "$CONFIG_FILE" <<EOC
DOMAIN="$DOMAIN"
REPO_URL="$REPO_URL"
ZERO_TRUST_DONE="true"
EOC
  chmod 600 "$CONFIG_FILE"
fi

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
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" || true
cloudflared tunnel route dns "$TUNNEL_NAME" "*.$DOMAIN" || true

if ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> Firewall already configured, skipping."
else
  echo "==> Configuring firewall (SSH only - all HTTP traffic goes through the tunnel)..."
  apt-get update -qq
  apt-get install -y -qq ufw
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow OpenSSH
  ufw --force enable
fi

if systemctl is-enabled cloudflared &>/dev/null; then
  echo "==> cloudflared service already installed, restarting to pick up config changes..."
  systemctl restart cloudflared
else
  echo "==> Installing cloudflared as a system service..."
  cloudflared service install
  systemctl enable --now cloudflared
fi

# planning#378 — the orchestrator must answer to $DOMAIN.
#
# The origin guard proves a request's `Host` is ShipIt's own from the name's own
# shape, which needs no configuration for every loopback / tailnet / MagicDNS /
# sslip.io name (docs/254). A public domain is the one shape it cannot prove:
# nothing about "$DOMAIN" distinguishes it from a name a DNS-rebinding attacker
# owns, and cloudflared passes the browser's `Host` straight through. deploy.sh
# and restart.sh derive SHIPIT_ALLOWED_ORIGINS from the DOMAIN in setup.conf,
# which was just written above — but that only reaches the orchestrator when its
# container is recreated, and setup.sh runs deploy.sh BEFORE this script. So on
# a fresh install the stack is already up with the variable unset, and the
# domain would be refused until something else happened to restart it.
# restart.sh re-sources the env, re-derives, and recreates only the
# orchestrator, with no rebuild.
if docker compose -f /opt/shipit/deployment/vps/docker-compose.yml ps -q shipit 2>/dev/null | grep -q .; then
  echo "==> Restarting ShipIt so it answers to $DOMAIN..."
  bash /opt/shipit/deployment/vps/restart.sh
fi

echo ""
echo "==========================================="
echo "  Cloudflare access configured"
echo "==========================================="
echo ""
echo "  ShipIt is available at: https://$DOMAIN"
if [ "$ZERO_TRUST_DONE" = "true" ]; then
  echo "  Zero Trust access control is configured."
  echo "  Manage policies at: https://one.dash.cloudflare.com -> Access -> Applications"
else
  echo "  WARNING: Zero Trust access control is disabled by explicit override."
  echo "  Your Cloudflare URL is publicly accessible unless another access layer protects it."
fi
echo ""
