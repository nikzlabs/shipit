#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Safe to re-run - skips steps that are already done.
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
echo "  ShipIt - Server Provisioning"
echo "==========================================="
echo ""
echo "Access setup:"
echo "  1. Cloudflare Tunnel"
echo "  2. Tailscale"
echo "  3. Both"
echo "  4. None"
echo ""
read -rp "Choose what to install [1]: " ACCESS_CHOICE
ACCESS_CHOICE="${ACCESS_CHOICE:-1}"

INSTALL_CLOUDFLARE=false
INSTALL_TAILSCALE=false
case "$ACCESS_CHOICE" in
  1|cloudflare|Cloudflare)
    INSTALL_CLOUDFLARE=true
    ;;
  2|tailscale|Tailscale)
    INSTALL_TAILSCALE=true
    ;;
  3|both|Both)
    INSTALL_CLOUDFLARE=true
    INSTALL_TAILSCALE=true
    ;;
  4|none|None)
    ;;
  *)
    echo "Error: choose 1, 2, 3, or 4" >&2
    exit 1
    ;;
esac

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

if ! command -v jq &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq jq
fi

# --- Configure Docker network address pools ---
# ShipIt creates one Docker network per session. The default pool (~30 /16 subnets)
# is easily exhausted, causing "all predefined address pools have been fully subnetted".
# Expand to use the full 172.16.0.0/12 range with /24 subnets (~4000 networks).
DAEMON_JSON="/etc/docker/daemon.json"
DESIRED_POOL='172.16.0.0/12'
if [ -f "$DAEMON_JSON" ] && grep -q "$DESIRED_POOL" "$DAEMON_JSON" 2>/dev/null; then
  echo "==> Docker address pools already configured, skipping."
else
  echo "==> Expanding Docker network address pools..."
  if [ -f "$DAEMON_JSON" ]; then
    # Merge into existing config
    jq '. + {"default-address-pools": [{"base": "172.16.0.0/12", "size": 24}]}' "$DAEMON_JSON" > "${DAEMON_JSON}.tmp"
    mv "${DAEMON_JSON}.tmp" "$DAEMON_JSON"
  else
    cat > "$DAEMON_JSON" <<'EODJ'
{
  "default-address-pools": [
    { "base": "172.16.0.0/12", "size": 24 }
  ]
}
EODJ
  fi
  systemctl restart docker
fi

# --- Raise inotify watcher limits ---
# inotify limits are enforced per host UID across the whole kernel, NOT
# per container. Every session container (file-watcher) and every preview
# dev server (e.g. Vite/chokidar) registers watches against the same host
# UID 0 pool. The Ubuntu defaults (~65k watches / 128 instances) fall over
# fast with multiple active sessions - Node's `fs.watch({ recursive: true })`
# on Linux registers one inotify watch per subdirectory, and node_modules
# trees can be tens of thousands of dirs each. Bump generously.
INOTIFY_CONF="/etc/sysctl.d/99-shipit-inotify.conf"
if [ -f "$INOTIFY_CONF" ]; then
  echo "==> inotify limits already configured, skipping."
else
  echo "==> Raising inotify watcher limits..."
  cat > "$INOTIFY_CONF" <<'EOI'
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=512
EOI
  sysctl --system >/dev/null
fi

# --- Self-updater + restarter systemd units ---
# Both are installed together: the updater handles "Update Now" (git pull +
# rebuild) and the restarter handles "Just Restart" (force-recreate the
# orchestrator container without rebuilding). Each is a path unit that
# watches for a trigger file written by the orchestrator from inside its
# container.
echo "==> Installing self-updater and restarter services..."
cp /opt/shipit/deployment/vps/shipit-updater.service /etc/systemd/system/
cp /opt/shipit/deployment/vps/shipit-updater.path /etc/systemd/system/
cp /opt/shipit/deployment/vps/shipit-restarter.service /etc/systemd/system/
cp /opt/shipit/deployment/vps/shipit-restarter.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shipit-updater.path
systemctl enable --now shipit-restarter.path

# --- Build and start ShipIt (always run - this is the deploy step) ---
echo "==> Building and starting ShipIt..."
bash /opt/shipit/deployment/vps/deploy.sh

if [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  bash /opt/shipit/deployment/vps/cloudflare.sh
fi

if [ "$INSTALL_TAILSCALE" = "true" ]; then
  bash /opt/shipit/deployment/vps/tailscale.sh
fi

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

echo ""
echo "==========================================="
echo "  Setup complete!"
echo "==========================================="
echo ""
if [ -n "${DOMAIN:-}" ] && [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "  Cloudflare URL: https://$DOMAIN"
fi
if [ "$INSTALL_TAILSCALE" = "true" ]; then
  echo "  Tailscale access is configured."
fi
if [ "$INSTALL_CLOUDFLARE" != "true" ] && [ "$INSTALL_TAILSCALE" != "true" ]; then
  echo "  ShipIt is running on localhost inside the VPS: http://127.0.0.1:4123"
  echo "  Configure Cloudflare or Tailscale later to access it remotely."
fi
echo ""

if [ "${ZERO_TRUST_DONE:-}" = "true" ]; then
  echo "  Zero Trust access control is configured."
  echo "  To manage policies later: https://one.dash.cloudflare.com -> Access -> Applications"
elif [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "  No access control configured - your instance is publicly accessible!"
  echo "  Set up Zero Trust access control:"
  echo "    1. Go to: https://one.dash.cloudflare.com"
  echo "    2. Navigate to: Access -> Applications -> Add an application"
  echo "    3. Choose 'Self-hosted', set domain to: $DOMAIN"
  echo "    4. Add a second domain: *.$DOMAIN (for preview subdomains)"
  echo "    5. Create an Allow policy for your team's emails"
  echo "    6. Save - users will authenticate through Cloudflare before reaching ShipIt"
  echo "  Or run cloudflare.sh again and provide a Cloudflare API token when prompted."
fi

echo ""
echo "  Next steps:"
if [ -n "${DOMAIN:-}" ] && [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "    1. Open https://$DOMAIN in your browser"
elif [ "$INSTALL_TAILSCALE" = "true" ]; then
  echo "    1. Open your Tailscale Serve URL in your browser"
else
  echo "    1. Run cloudflare.sh or tailscale.sh when you're ready to expose ShipIt"
fi
if [ "${ZERO_TRUST_DONE:-}" = "true" ]; then
  echo "    2. Authenticate through Cloudflare Zero Trust"
elif [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "    2. If you set up Zero Trust, you'll authenticate through Cloudflare first"
else
  echo "    2. Complete the access setup you chose"
fi
echo "    3. ShipIt will prompt you to sign in with your Claude account (OAuth)"
echo "    4. Start coding!"
echo ""
echo "  Useful commands:"
echo "    View logs:      docker compose -f /opt/shipit/deployment/vps/docker-compose.yml logs -f shipit"
if [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "    Tunnel logs:    journalctl -u cloudflared -f"
fi
echo "    Updater logs:   journalctl -u shipit-updater -f"
echo "    Restart:        docker compose -f /opt/shipit/deployment/vps/docker-compose.yml restart"
echo ""
echo "  Updates: Settings -> Advanced -> Software Updates (in the ShipIt UI)"
echo ""
