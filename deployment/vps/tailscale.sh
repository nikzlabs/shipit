#!/bin/bash
# Add private Tailscale access without changing other access paths.
# TCP forwarding preserves preview subdomains, which Tailscale Serve cannot do.
#
# Optional environment:
#   SHIPIT_TAILSCALE_AUTHKEY=tskey-auth-...
#   SHIPIT_TAILSCALE_PORT=80          # Explicit ports do not use the fallback.
set -euo pipefail

# Capture this before applying the default; explicit ports must fail if occupied.
PORT_EXPLICIT=0
[ -n "${SHIPIT_TAILSCALE_PORT:-}" ] && PORT_EXPLICIT=1

LISTEN_PORT="${SHIPIT_TAILSCALE_PORT:-80}"
BACKEND_PORT=4123
FALLBACK_PORT=4123
FORWARD_WRAPPER="/usr/local/bin/shipit-tailscale-forward.sh"
FORWARD_UNIT="/etc/systemd/system/shipit-tailscale-preview.service"
# Persist the advertised preview host across updates.
PREVIEW_HOST_FILE="/opt/shipit/.tailnet-preview-host"

ACCESS_URL_FILE="${SHIPIT_ACCESS_URL_FILE:-}"

# --- Terminal colors (only when stdout is a TTY) ----------------------------
if [ -t 1 ]; then
  C_BANNER=$'\033[1;33m'   # bold yellow — the closing banner
  C_PASTE=$'\033[0;32m'    # green       — the URL itself
  C_RESET=$'\033[0m'
else
  C_BANNER='' C_PASTE='' C_RESET=''
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: run as root, e.g. sudo bash /opt/shipit/deployment/vps/tailscale.sh" >&2
  exit 1
fi

echo "==> ShipIt — Tailscale access (app + previews; any Cloudflare path is unchanged)"

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

# --- Authenticate -----------------------------------------------------------
# Do not let MagicDNS replace public DNS inside Docker containers.
if tailscale ip -4 &>/dev/null; then
  echo "==> Tailscale is already authenticated; keeping its existing hostname."
  # A manual `tailscale up` can restore MagicDNS.
  tailscale set --accept-dns=false 2>/dev/null || true
else
  echo "==> Authenticating this server with Tailscale..."
  if [ -n "${SHIPIT_TAILSCALE_AUTHKEY:-}" ]; then
    tailscale up --accept-dns=false --authkey="$SHIPIT_TAILSCALE_AUTHKEY"
  else
    echo "    A login URL will appear below. Open it in a browser where you are logged into Tailscale."
    tailscale up --accept-dns=false
  fi
fi

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
TAILSCALE_FQDN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)"

if [ -z "$TS_IP" ]; then
  echo "Error: could not determine this node's Tailscale IPv4 address." >&2
  echo "       Is the node authenticated? Try 'tailscale status'." >&2
  exit 1
fi

# Tailscale Serve cannot carry preview subdomains.
tailscale serve reset 2>/dev/null || true

# --- Install socat (TCP forwarder, Host-preserving) -------------------------
if ! command -v socat &>/dev/null; then
  echo "==> Installing socat (tailnet forwarder)..."
  apt-get update -qq
  apt-get install -y -qq socat
fi

# --- Port preflight ----------------------------------------------------------
# Test the bind itself because wildcard listeners are not clear from `ss` output.
port_is_free() {
  local ip="$1" port="$2" rc=0
  # `fork` prevents a probe connection from ending socat normally.
  timeout 1 socat "TCP-LISTEN:${port},bind=${ip},fork,reuseaddr" /dev/null >/dev/null 2>&1 || rc=$?
  # 124 means the bind succeeded and timed out while accepting.
  [ "$rc" -eq 124 ]
}

# The holder name is optional diagnostic data.
describe_port_holder() {
  local port="$1" names=""
  command -v ss &>/dev/null || return 0
  names="$(ss -ltnpH "sport = :${port}" 2>/dev/null \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u | paste -sd, - || true)"
  [ -n "$names" ] && printf ' (%s)' "$names"
  return 0
}

port_taken_advice() {
  echo "       ShipIt itself is unaffected on 127.0.0.1:${BACKEND_PORT}; only tailnet access failed." >&2
  echo "       Re-run with a free port (it just becomes part of the URL):" >&2
  echo "           SHIPIT_TAILSCALE_PORT=8080 bash /opt/shipit/deployment/vps/tailscale.sh" >&2
  restore_forwarder
  exit 1
}

port_taken_error() {
  local port="$1" holder="$2"
  echo "" >&2
  echo "Error: ${TS_IP}:${port} is already in use${holder}." >&2
  port_taken_advice
}

both_ports_taken_error() {
  local port="$1" holder="$2" fallback="$3" fallback_holder="$4"
  echo "" >&2
  echo "Error: on ${TS_IP}, port ${port}${holder} and the fallback port ${fallback}${fallback_holder} are both in use." >&2
  port_taken_advice
}

# Stop our forwarder so a rerun does not detect its own listener.
FORWARDER_WAS_ACTIVE=0
if systemctl is-active --quiet shipit-tailscale-preview.service 2>/dev/null; then
  FORWARDER_WAS_ACTIVE=1
  echo "==> Stopping the existing forwarder while the port is checked..."
  systemctl stop shipit-tailscale-preview.service 2>/dev/null || true
fi

restore_forwarder() {
  [ "${FORWARDER_WAS_ACTIVE:-0}" = "1" ] || return 0
  echo "       (the forwarder that was already running has been started again)" >&2
  systemctl start shipit-tailscale-preview.service 2>/dev/null || true
}

echo "==> Checking that ${TS_IP}:${LISTEN_PORT} is free..."
if ! port_is_free "$TS_IP" "$LISTEN_PORT"; then
  HOLDER="$(describe_port_holder "$LISTEN_PORT")"
  # Only the default port can fall back.
  if [ "$PORT_EXPLICIT" = "1" ]; then
    port_taken_error "$LISTEN_PORT" "$HOLDER"
  fi
  if ! port_is_free "$TS_IP" "$FALLBACK_PORT"; then
    both_ports_taken_error "$LISTEN_PORT" "$HOLDER" \
      "$FALLBACK_PORT" "$(describe_port_holder "$FALLBACK_PORT")"
  fi
  TAKEN_PORT="$LISTEN_PORT"
  LISTEN_PORT="$FALLBACK_PORT"
  echo "    Port ${TAKEN_PORT}${HOLDER} is taken — using port ${FALLBACK_PORT} instead."
  echo "    That service is untouched; the URL below carries the port."
  echo "    To pick the port yourself: SHIPIT_TAILSCALE_PORT=<port> (re-run this script)"
fi

# --- Forwarder: supervisor loop, tailnet IP :LISTEN_PORT -> 127.0.0.1:4123 ---
# Poll the live tailnet IP and bind only to it.
echo "==> Installing tailnet forwarder supervisor (${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT})..."
cat > "$FORWARD_WRAPPER" <<EOF
#!/bin/bash
# Transient Tailscale errors must not stop the retry loop.
set -uo pipefail
PREVIEW_HOST_FILE="${PREVIEW_HOST_FILE}"
LISTEN_PORT="${LISTEN_PORT}"
BACKEND_PORT="${BACKEND_PORT}"

mkdir -p "\$(dirname "\$PREVIEW_HOST_FILE")"

socat_pid=""
# Stop forked connection handlers before the listener.
kill_socat() {
  [ -n "\$socat_pid" ] || return 0
  pkill -TERM -P "\$socat_pid" 2>/dev/null || true
  kill "\$socat_pid" 2>/dev/null || true
  wait "\$socat_pid" 2>/dev/null || true
  socat_pid=""
}
# Exit after signal cleanup instead of returning to the loop.
trap 'kill_socat; exit 0' INT TERM
trap kill_socat EXIT

prev_ip=""
while true; do
  ts_ip="\$(tailscale ip -4 2>/dev/null | head -n1)"

  if [ -n "\$socat_pid" ] && ! kill -0 "\$socat_pid" 2>/dev/null; then
    socat_pid=""
    prev_ip=""
  fi

  if [ -n "\$ts_ip" ] && { [ "\$ts_ip" != "\$prev_ip" ] || [ -z "\$socat_pid" ]; }; then
    # Write atomically for concurrent bootstrap reads.
    host="\${ts_ip//./-}.sslip.io"
    [ "\$LISTEN_PORT" != "80" ] && host="\${host}:\${LISTEN_PORT}"
    tmp="\$(mktemp "\${PREVIEW_HOST_FILE}.XXXXXX")"
    printf '%s\n' "\$host" > "\$tmp"
    mv -f "\$tmp" "\$PREVIEW_HOST_FILE"

    kill_socat
    socat TCP-LISTEN:\${LISTEN_PORT},bind=\${ts_ip},fork,reuseaddr TCP:127.0.0.1:\${BACKEND_PORT} &
    socat_pid="\$!"
    prev_ip="\$ts_ip"
  fi

  sleep 10
done
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

# --- Verify the forwarder really bound --------------------------------------
# The supervisor can remain active while socat fails, so find our exact process.
forwarder_is_listening() {
  pgrep -f "TCP-LISTEN:${LISTEN_PORT},bind=${TS_IP}," >/dev/null 2>&1
}

echo "==> Verifying the forwarder is listening on ${TS_IP}:${LISTEN_PORT}..."
FORWARDER_UP=0
for _ in $(seq 1 15); do
  if forwarder_is_listening; then
    FORWARDER_UP=1
    break
  fi
  sleep 1
done

if [ "$FORWARDER_UP" != "1" ]; then
  echo "" >&2
  echo "Error: the forwarder did not start listening on ${TS_IP}:${LISTEN_PORT}." >&2
  echo "       (systemctl says 'active' either way — it supervises a retry loop.)" >&2
  echo "       ShipIt itself is unaffected on 127.0.0.1:${BACKEND_PORT}; only tailnet access failed." >&2
  echo "       Usually the port is taken. Re-run with a free one:" >&2
  echo "           SHIPIT_TAILSCALE_PORT=8080 bash /opt/shipit/deployment/vps/tailscale.sh" >&2
  echo "" >&2
  echo "       Last lines from the forwarder:" >&2
  journalctl -u shipit-tailscale-preview -n 5 --no-pager 2>/dev/null | sed 's/^/           /' >&2 || true
  exit 1
fi

# --- Output -----------------------------------------------------------------
# Prefer MagicDNS for the app; sslip.io supplies wildcard preview DNS.
SSLIP_HOST="${TS_IP//./-}.sslip.io"
PORT_SUFFIX=""
if [ "$LISTEN_PORT" != "80" ]; then
  PORT_SUFFIX=":${LISTEN_PORT}"
fi
SSLIP_URL="http://${SSLIP_HOST}${PORT_SUFFIX}"
if [ -n "$TAILSCALE_FQDN" ]; then
  ACCESS_URL="http://${TAILSCALE_FQDN}${PORT_SUFFIX}"
else
  ACCESS_URL="$SSLIP_URL"
fi

if [ -n "$ACCESS_URL_FILE" ]; then
  printf '%s\n' "$ACCESS_URL" > "$ACCESS_URL_FILE" 2>/dev/null || true
fi

echo ""
echo "  Tailnet access is ready. Worth knowing:"
echo "    - HTTP only — these names have no TLS certificate, so the clipboard"
echo "      and PWA install stay unavailable."
echo "    - Preview subdomains resolve through sslip.io, a public DNS resolver."
echo "      Traffic still rides the encrypted tailnet."
if [ "$ACCESS_URL" != "$SSLIP_URL" ]; then
  echo "    - If that name does not resolve on a device, use ${SSLIP_URL}"
fi
echo "    - Owned domains, HTTPS, and dropping sslip.io: deployment/README.md"
echo ""
echo "${C_BANNER}=======================================================================${C_RESET}"
echo "${C_BANNER}  Open ShipIt at   ${C_PASTE}${ACCESS_URL}${C_RESET}"
echo "${C_BANNER}=======================================================================${C_RESET}"
echo ""
