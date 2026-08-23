#!/bin/bash
# Optional private Tailscale access for an existing ShipIt VPS deployment.
#
# This is intentionally additive: it leaves any existing Cloudflare tunnel,
# firewall, and Docker compose bindings alone. ShipIt continues to listen on
# 127.0.0.1:4123; this script exposes that listener to the tailnet so that both
# the app AND subdomain previews work over Tailscale.
#
# Preview routing (why this is not Tailscale Serve):
#   ShipIt previews are served on subdomains — {sessionId}--{port}.<host>.
#   Tailscale Serve binds ONLY the node's own MagicDNS name and cannot carry
#   {sessionId}--{port}.shipit.tailnet.ts.net, so previews over a Serve URL are
#   structurally impossible. Instead we:
#     1. Forward the node's tailnet IP :4123 -> 127.0.0.1:4123 at the TCP level
#        (Host header preserved), so the orchestrator's subdomain proxy can route.
#     2. Resolve a wildcard host to the node. By DEFAULT this uses sslip.io, a
#        public wildcard DNS resolver: {id}--{port}.<dashed-tailnet-ip>.sslip.io
#        resolves straight back to the node's 100.x address, with NO tailnet
#        policy edit and NO owned domain — it works on any Tailscale version,
#        the moment the script finishes. The orchestrator's subdomain proxy
#        already matches {uuid}--{port}.anything, so no app changes are needed.
#   Optional upgrade to a cleaner hostname (no third-party resolver): grant the
#   node Tailscale's native MagicDNS wildcard capability (`dns-subdomain-resolve`
#   node attr, clients v1.96+) so *.<node>.tailnet.ts.net resolves to the node.
#   That is an ACL grant the operator adds once — this script prints the block —
#   but Tailscale gates it per-tailnet at the control plane, so saving it can be
#   rejected with "tailnet is not permitted to use the 'dns-subdomain-resolve'
#   node attribute"; the sslip.io default keeps working regardless.
#   Access is HTTP over the WireGuard-encrypted tailnet (no wildcard TLS cert
#   exists for *.ts.net — tracked upstream at tailscale/tailscale#7081). For real
#   HTTPS, point an owned wildcard domain at the node IP (see deployment/README.md)
#   — and declare it in SHIPIT_ALLOWED_ORIGINS, since planning#378's hostname check
#   cannot prove a registrable name is ours. The .ts.net and sslip.io names below
#   prove themselves and need nothing.
#
# Usage:
#   bash /opt/shipit/deployment/vps/tailscale.sh
#
# The node's Tailscale hostname is intentionally left to Tailscale: a fresh node
# gets Tailscale's own default (derived from the system hostname) and a rerun
# never renames it. This script never passes `--hostname`.
#
# Optional environment:
#   SHIPIT_TAILSCALE_AUTHKEY=tskey-auth-...
#   SHIPIT_TAILSCALE_PORT=80          # tailnet-facing port for ShipIt (default 80;
#                                     # set e.g. 4123 to avoid the privileged port).
#                                     # When it is NOT set and port 80 is already
#                                     # taken on the tailnet IP, this script falls
#                                     # back to 4123 and says so. When it IS set,
#                                     # a taken port is an error, not a fallback —
#                                     # the operator picked that port on purpose.
set -euo pipefail

# Was the port chosen by the operator, or is it our default? Read BEFORE the
# default is applied: it decides whether a taken port falls back or fails.
PORT_EXPLICIT=0
[ -n "${SHIPIT_TAILSCALE_PORT:-}" ] && PORT_EXPLICIT=1

LISTEN_PORT="${SHIPIT_TAILSCALE_PORT:-80}"
BACKEND_PORT=4123
# Where the default port falls back to when port 80 is already taken. 4123 is the
# orchestrator's own port number, and on a VPS it is published on 127.0.0.1 only
# (deployment/vps/docker-compose.yml), so the tailnet IP side of it is free.
FALLBACK_PORT=4123
FORWARD_WRAPPER="/usr/local/bin/shipit-tailscale-forward.sh"
FORWARD_UNIT="/etc/systemd/system/shipit-tailscale-preview.service"
# docs/216 — the forwarder advertises the sslip preview host here; the
# orchestrator reads it per /api/bootstrap (via its /opt/shipit mount) so the
# client can route preview iframes through sslip.io while the app/WS stay on the
# native MagicDNS host. Under /opt/shipit so it survives UI "Update Now", like
# .release-channel.
PREVIEW_HOST_FILE="/opt/shipit/.tailnet-preview-host"

# Where the finished access URL is written when the caller asks for it, so
# setup.sh can end ITS summary with the same URL instead of telling the reader to
# scroll back up for one. Empty unless the caller sets it; never a fixed path,
# because a file left in /opt/shipit would go stale the next time the tailnet IP
# or the port changes.
ACCESS_URL_FILE="${SHIPIT_ACCESS_URL_FILE:-}"

# --- Terminal colors (only when stdout is a TTY) ----------------------------
# One rule: the access URL is what the reader came for, so the closing banner and
# the URL inside it are the only coloured things here.
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
# The hostname is left entirely to Tailscale (Tailscale's own default on a fresh
# node; unchanged on a rerun), so this script never renames the node.
#
# --accept-dns=false is load-bearing: this node SERVES the tailnet, it never
# needs to resolve tailnet names itself. If we accept Tailscale DNS, tailscaled
# rewrites /etc/resolv.conf to MagicDNS (100.100.100.100); Docker propagates that
# to every container, and — unless the tailnet has a global nameserver configured
# (it does not by default) — MagicDNS returns empty for public names. The
# orchestrator and session containers then cannot resolve github.com, package
# registries, etc., so GitHub connect and agent network calls fail. Previews
# resolve via sslip.io (public DNS) on the CLIENT devices, so MagicDNS on this
# node buys nothing. See docs/175-preview-subdomain-only.
if tailscale ip -4 &>/dev/null; then
  echo "==> Tailscale is already authenticated; keeping its existing hostname."
  # Re-assert on an already-authenticated node: an earlier run (or a manual
  # `tailscale up`) may have left MagicDNS owning /etc/resolv.conf.
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

# Drop any Tailscale Serve config from a previous version of this script. Serve
# binds only the node's own MagicDNS name and cannot carry preview subdomains,
# so an upgraded box would otherwise keep serving the app at https://<node>
# (443) with broken previews and no signal as to why. The forwarder below is
# the supported preview path; Serve is intentionally not used.
tailscale serve reset 2>/dev/null || true

# --- Install socat (TCP forwarder, Host-preserving) -------------------------
if ! command -v socat &>/dev/null; then
  echo "==> Installing socat (tailnet forwarder)..."
  apt-get update -qq
  apt-get install -y -qq socat
fi

# --- Port preflight: a taken port must never become a silent half-install -----
# The forwarder binds TS_IP:LISTEN_PORT. When something else already holds that
# address — most often a web server on 0.0.0.0:80 — socat exits immediately and
# the supervisor loop below just retries every 10s, forever. Nothing about that
# looks broken from outside: the systemd unit stays "active" (the loop is what
# systemd supervises, and it never exits), so without this check the script would
# print a success banner and an access URL that either refuses the connection or
# lands on the OTHER service. That is the failure this preflight exists to stop.
#
# Test by ATTEMPTING the bind rather than reading `ss` output, because only a bind
# answers the question that matters: a listener on some other specific IP:80 does
# not conflict with TS_IP:80, while one on 0.0.0.0:80 does.
port_is_free() {
  local ip="$1" port="$2" rc=0
  # `fork` keeps the probe listening after an accepted connection. Without it a
  # client that connects during the one-second window ends socat normally, and a
  # port that is in fact free would be read as taken.
  timeout 1 socat "TCP-LISTEN:${port},bind=${ip},fork,reuseaddr" /dev/null >/dev/null 2>&1 || rc=$?
  # 124 = `timeout` killed a socat that was sitting in accept(), i.e. the bind
  # succeeded and the address is ours to take. Any other code is a failed bind.
  [ "$rc" -eq 124 ]
}

# Best-effort "who holds it", as a bare program name or two — the point is to let
# the reader recognise the service, not to reproduce an `ss` table. Never fatal:
# ss may be absent, and the diagnosis is still correct without a name.
describe_port_holder() {
  local port="$1" names=""
  command -v ss &>/dev/null || return 0
  names="$(ss -ltnpH "sport = :${port}" 2>/dev/null \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u | paste -sd, - || true)"
  [ -n "$names" ] && printf ' (%s)' "$names"
  return 0
}

# Shared tail of every "the port is taken" error: what still works, and the one
# command that fixes it.
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

# Both ports taken: name BOTH, or the message blames port 80 for a fallback that
# failed on a different port the operator was never told about.
both_ports_taken_error() {
  local port="$1" holder="$2" fallback="$3" fallback_holder="$4"
  echo "" >&2
  echo "Error: on ${TS_IP}, port ${port}${holder} and the fallback port ${fallback}${fallback_holder} are both in use." >&2
  port_taken_advice
}

# A rerun is normal — setup.sh runs this script, and re-running it is how the
# port or the tailnet IP gets changed — and on a rerun OUR OWN forwarder already
# holds the port. Stop it first, so the preflight measures the machine WITHOUT
# ShipIt in it; otherwise a healthy rerun reads its own listener as the conflict
# and moves a working install onto another port. It is started again below, and
# every error path puts it back exactly as it was found.
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
  # An explicitly chosen port is the operator's decision — report it, never
  # silently move it. Only our own default 80 falls back.
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
# docs/216 — a supervisor loop, not a one-shot `exec socat`. It polls the live
# tailnet IPv4 and, when it changes (or the socat child dies), (1) rewrites the
# advertised sslip preview host file and (2) rebinds socat to the new IP. This
# keeps the advertised host in lockstep with the live bind and bounds staleness
# to one poll interval — a one-shot write + `Restart=always` would NOT refresh on
# a live IP change because a bound socat needn't exit. Bound to the tailnet IP
# specifically (NOT 0.0.0.0) so the listener is never exposed publicly.
echo "==> Installing tailnet forwarder supervisor (${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT})..."
cat > "$FORWARD_WRAPPER" <<EOF
#!/bin/bash
# No -e: transient errors (e.g. tailscale not ready yet) must not kill the
# supervisor; the loop retries. -u/pipefail still catch real bugs.
set -uo pipefail
PREVIEW_HOST_FILE="${PREVIEW_HOST_FILE}"
LISTEN_PORT="${LISTEN_PORT}"
BACKEND_PORT="${BACKEND_PORT}"

mkdir -p "\$(dirname "\$PREVIEW_HOST_FILE")"

socat_pid=""
# Kill the whole socat process tree: its forked per-connection children first
# (they survive killing only the listener), then the listener, then reap it.
kill_socat() {
  [ -n "\$socat_pid" ] || return 0
  pkill -TERM -P "\$socat_pid" 2>/dev/null || true
  kill "\$socat_pid" 2>/dev/null || true
  wait "\$socat_pid" 2>/dev/null || true
  socat_pid=""
}
# On a stop/restart signal, tear down socat and EXIT promptly — without the
# explicit exit the trap returns into the loop and systemd waits out
# TimeoutStopSec before SIGKILL. EXIT runs kill_socat for any other exit path.
trap 'kill_socat; exit 0' INT TERM
trap kill_socat EXIT

prev_ip=""
while true; do
  ts_ip="\$(tailscale ip -4 2>/dev/null | head -n1)"

  # Force a rebind if the bind IP changed OR the socat child has died.
  if [ -n "\$socat_pid" ] && ! kill -0 "\$socat_pid" 2>/dev/null; then
    socat_pid=""
    prev_ip=""
  fi

  if [ -n "\$ts_ip" ] && { [ "\$ts_ip" != "\$prev_ip" ] || [ -z "\$socat_pid" ]; }; then
    # Advertised preview host: dashed tailnet IP under sslip.io, ShipIt port
    # appended only when it isn't 80. Write atomically so a concurrent bootstrap
    # read never sees a half-written line.
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
# The preflight above tests the port a moment BEFORE the forwarder starts, so it
# cannot see a conflict that appears in between (a service starting at the same
# time, a socat that fails for some other reason). And `systemctl is-active` can
# never answer this: systemd supervises the supervisor loop, which stays alive
# while every bind attempt inside it fails.
#
# Look for OUR socat, holding exactly this address, rather than for "a listener
# on the port": a listener alone proves nothing about who owns it, so a process
# that won the race would be reported as success. socat exits on a failed bind,
# so a live socat with this bind in its argv is itself the proof that the bind
# succeeded.
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
# Kept deliberately short: the reader came for one URL, and everything that used
# to sit between them and it (the preview-subdomain pattern, the forwarder line,
# the sslip explainer, the full MagicDNS ACL paste block) is either an internal
# detail they never type by hand or reference material that belongs in
# deployment/README.md. The last thing printed is the URL, on its own.
#
# Which URL is last: the node's native MagicDNS name when Tailscale reports one —
# the app and its live connection then ride the pure tailnet, and ShipIt routes
# only preview iframes through sslip.io (docs/216). With no MagicDNS name to read
# there is nothing to recommend, so the sslip URL takes its place rather than a
# placeholder nobody can open. sslip.io maps any <dashed-ip>.sslip.io name back
# to that IP, which is what gives previews a wildcard host with no owned domain;
# the dash notation also dodges the client's raw-IPv4 guard.
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

# Hand the URL to the caller (setup.sh) so its own summary can end with it too.
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
