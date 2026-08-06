#!/usr/bin/env bash
# Optional Tailscale access for a LOCAL ShipIt install (docs/254).
#
# This is the laptop counterpart to deployment/vps/tailscale.sh, and it is much
# smaller, because the local install publishes its own port. There is no socat
# forwarder, no systemd unit, and nothing privileged: this script only records
# the opt-in and restarts ShipIt, after which deployment/local/lib.sh re-derives
# the tailnet binding on every start.
#
# What it changes:
#   1. Writes SHIPIT_TAILNET_BIND=1 to $SHIPIT_HOME/.shipit.env.
#   2. Restarts ShipIt, which adds a <tailnet-ip>:4123 binding ALONGSIDE the
#      existing 127.0.0.1:4123 one. Loopback is never removed, so localhost keeps
#      working even when Tailscale is down — and ShipIt still starts in that case.
#
# Previews (why the URL below is an sslip.io name and not the raw tailnet IP):
#   ShipIt previews are served on subdomains — {sessionId}--{port}.<host> — so
#   they need a host that can carry a wildcard subdomain. The client refuses to
#   build a preview URL at all for a raw IPv4 literal, so browsing at
#   http://100.x.y.z:4123 gives a working app and NO previews. sslip.io is a
#   public wildcard resolver that maps any <dashed-ip>.sslip.io name back to that
#   IP, so browsing at http://100-x-y-z.sslip.io:4123 makes previews resolve with
#   no owned domain, no tailnet policy edit, and no app configuration — the
#   orchestrator's subdomain proxy already matches {uuid}--{port}.anything.
#
#   Traffic still rides the WireGuard-encrypted tailnet. It is HTTP, though: there
#   is no wildcard TLS certificate for these names. That means preview pages are
#   not a secure context, so clipboard access and PWA install are unavailable. For
#   real HTTPS, point a wildcard DNS record you own (*.shipit.example.com) at the
#   tailnet IP and browse through that instead.
#
# Usage:
#   bash ~/.shipit/deployment/local/tailscale.sh
#
# To opt back out: remove SHIPIT_TAILNET_BIND from ~/.shipit/.shipit.env and
# re-run deployment/local/update.sh (or stop.sh + setup.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deployment/local/lib.sh
. "$SCRIPT_DIR/lib.sh"

if [ -t 1 ]; then
  C_BANNER=$'\033[1;33m'
  C_PASTE=$'\033[0;32m'
  C_RESET=$'\033[0m'
else
  C_BANNER='' C_PASTE='' C_RESET=''
fi

echo "==========================================="
echo "  ShipIt — Tailscale access (local install)"
echo "==========================================="
echo ""

# --- Preflight: check and instruct, never auto-install ----------------------
# Mirrors deployment/local/setup.sh's posture: a local machine is the user's own,
# so we do not install system packages onto it behind their back.
# Resolved via shipit_tailscale_bin, NOT `command -v`: the standalone macOS app
# keeps its CLI inside the bundle and never puts `tailscale` on PATH, so a bare
# `command -v` told fully-configured Macs they had no Tailscale — while pointing
# them at the very download page that installs it that way.
TS_BIN="$(shipit_tailscale_bin || true)"
if [ -z "$TS_BIN" ]; then
  echo "Error: could not find the Tailscale CLI." >&2
  echo "" >&2
  case "$(uname -s)" in
    Darwin)
      echo "  Install it from https://tailscale.com/download/mac (or: brew install --cask tailscale)" >&2
      echo "" >&2
      echo "  Already installed? The standalone app keeps its CLI inside the bundle" >&2
      echo "  and not on PATH. Point ShipIt straight at it:" >&2
      echo "      export SHIPIT_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale" >&2
      echo "  (Do not symlink it onto PATH — it resolves its bundle identifier from" >&2
      echo "   its own path and will abort.)" >&2
      ;;
    *)
      echo "  Install it with: curl -fsSL https://tailscale.com/install.sh | sh" >&2
      echo "" >&2
      echo "  Installed somewhere unusual? Set SHIPIT_TAILSCALE_BIN to its full path." >&2
      ;;
  esac
  echo "" >&2
  echo "  Then run this script again." >&2
  exit 1
fi

TS_IP="$("$TS_BIN" ip -4 2>/dev/null | head -n1 || true)"
if [ -z "$TS_IP" ]; then
  echo "Error: found the Tailscale CLI at '$TS_BIN', but this machine is not" >&2
  echo "       connected to a tailnet." >&2
  echo "" >&2
  echo "  Run 'tailscale up' (or connect from the Tailscale app), then re-run this." >&2
  exit 1
fi

if [ ! -d "$SHIPIT_HOME" ]; then
  echo "Error: no ShipIt install found at $SHIPIT_HOME." >&2
  echo "       Run deployment/local/setup.sh first." >&2
  exit 1
fi

# --- Record the opt-in ------------------------------------------------------
# Idempotent: rewrite any existing SHIPIT_TAILNET_BIND line rather than appending
# a duplicate, so re-running never grows the file. The IP is deliberately NOT
# persisted here — lib.sh re-reads it from Tailscale on every start so a changed
# address needs no edit (docs/254 req 6).
touch "$SHIPIT_ENV_FILE"
if grep -q '^SHIPIT_TAILNET_BIND=' "$SHIPIT_ENV_FILE" 2>/dev/null; then
  tmp="$(mktemp "${SHIPIT_ENV_FILE}.XXXXXX")"
  grep -v '^SHIPIT_TAILNET_BIND=' "$SHIPIT_ENV_FILE" > "$tmp" || true
  printf 'SHIPIT_TAILNET_BIND=1\n' >> "$tmp"
  mv -f "$tmp" "$SHIPIT_ENV_FILE"
else
  printf 'SHIPIT_TAILNET_BIND=1\n' >> "$SHIPIT_ENV_FILE"
fi
echo "==> Recorded tailnet opt-in in $SHIPIT_ENV_FILE"

# --- Restart so the binding takes effect ------------------------------------
echo "==> Restarting ShipIt to add the tailnet binding..."
shipit_build_and_up

# Report the address that was ACTUALLY bound. shipit_build_and_up re-derives it
# (that is the whole point of doing it at start time), so the TS_IP read during
# preflight above can be stale by now — or the binding may have been skipped
# entirely if Tailscale dropped in between. Print what happened, not what we
# hoped would happen.
if [ -z "${SHIPIT_TAILNET_IP:-}" ]; then
  echo "" >&2
  echo "Tailscale became unreachable while starting, so ShipIt came up on" >&2
  echo "localhost only. The opt-in is recorded — re-run update.sh once Tailscale" >&2
  echo "is connected and tailnet access will be there." >&2
  exit 1
fi
SSLIP_HOST="${SHIPIT_TAILNET_IP//./-}.sslip.io"
TS_IP="$SHIPIT_TAILNET_IP"

echo ""
echo "${C_BANNER}===========================================${C_RESET}"
echo "${C_BANNER}  Tailscale access configured${C_RESET}"
echo "${C_BANNER}===========================================${C_RESET}"
echo ""
echo "  Open ShipIt from any device on your tailnet at:"
echo "${C_PASTE}      http://${SSLIP_HOST}:4123${C_RESET}"
echo ""
echo "  Use that URL rather than http://${TS_IP}:4123 — previews are served at"
echo "  {sessionId}--{port}.<host>, and a raw IP address cannot carry a wildcard"
echo "  subdomain, so previews are blank on the raw-IP URL."
echo ""
echo "  On this machine, http://localhost:4123 keeps working as before."
echo ""
echo "  Notes:"
echo "    - Traffic rides the encrypted tailnet, but the connection is HTTP: there"
echo "      is no wildcard TLS certificate for these names. Clipboard and PWA"
echo "      install need a secure context and will be unavailable."
echo "    - sslip.io is a public DNS resolver, so it sits in the resolution path."
echo "      Some networks block public names that resolve into CGNAT (100.64/10)"
echo "      as DNS-rebinding protection; if a device can't resolve the host, that"
echo "      is usually why."
echo "    - If Tailscale is down when ShipIt starts, it still starts on localhost"
echo "      and picks the tailnet binding back up on the next start."
echo "    - For real HTTPS, point a wildcard record you own at ${TS_IP}."
echo ""
