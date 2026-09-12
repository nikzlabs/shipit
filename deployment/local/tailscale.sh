#!/usr/bin/env bash
# Add a tailnet binding while preserving loopback. See deployment/README.md.
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

echo "==> ShipIt — Tailscale access (local install)"

# Load persisted CLI overrides before resolving Tailscale.
shipit_load_env_file

TS_BIN="$(shipit_tailscale_bin || true)"
if [ -z "$TS_BIN" ]; then
  echo "Error: could not find the Tailscale CLI." >&2
  echo "" >&2
  case "$(uname -s)" in
    Darwin)
      echo "  Install it from https://tailscale.com/download/mac (or: brew install --cask tailscale)" >&2
      echo "" >&2
      echo "  Already installed? The standalone app keeps its CLI inside the bundle" >&2
      echo "  and not on PATH. Record the path so every future start finds it:" >&2
      echo "      echo 'SHIPIT_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale' \\" >&2
      echo "        >> $SHIPIT_ENV_FILE" >&2
      echo "" >&2
      echo "  It must go in that file, not just your shell: a bare 'export' lasts only" >&2
      echo "  for the current shell, so the next update.sh would lose tailnet access" >&2
      echo "  and silently start on localhost only." >&2
      echo "  (Do not symlink it onto PATH — it resolves its bundle identifier from" >&2
      echo "   its own path and will abort.)" >&2
      ;;
    *)
      echo "  Install it with: curl -fsSL https://tailscale.com/install.sh | sh" >&2
      echo "" >&2
      echo "  Installed somewhere unusual? Record its full path so every future start" >&2
      echo "  finds it:" >&2
      echo "      echo 'SHIPIT_TAILSCALE_BIN=/full/path/to/tailscale' >> $SHIPIT_ENV_FILE" >&2
      echo "" >&2
      echo "  It must go in that file, not just your shell: a bare 'export' lasts only" >&2
      echo "  for the current shell, so the next update.sh would lose tailnet access" >&2
      echo "  and silently start on localhost only." >&2
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

# Persist the opt-in, but resolve the current IP at each start.
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

echo "==> Restarting ShipIt to add the tailnet binding..."
shipit_build_and_up

# Report the address resolved during the restart, not the preflight value.
if [ -z "${SHIPIT_TAILNET_IP:-}" ]; then
  echo "" >&2
  echo "Tailscale became unreachable while starting, so ShipIt came up on" >&2
  echo "localhost only. The opt-in is recorded — re-run update.sh once Tailscale" >&2
  echo "is connected and tailnet access will be there." >&2
  exit 1
fi
SSLIP_HOST="${SHIPIT_TAILNET_IP//./-}.sslip.io"

echo ""
echo "  Tailnet access is ready. Worth knowing:"
echo "    - On this machine, http://localhost:4123 keeps working as before."
echo "    - HTTP only — these names have no TLS certificate, so the clipboard"
echo "      and PWA install stay unavailable."
echo "    - sslip.io, a public DNS resolver, resolves this name; some networks"
echo "      block names that point into 100.64/10 and cannot reach it."
echo "    - If Tailscale is down at start, ShipIt starts on localhost and picks"
echo "      the tailnet binding back up on the next start."
echo "    - Owned domains, HTTPS, and the full reasoning: deployment/README.md"
echo ""
echo "${C_BANNER}=======================================================================${C_RESET}"
echo "${C_BANNER}  Open ShipIt on your tailnet at   ${C_PASTE}http://${SSLIP_HOST}:4123${C_RESET}"
echo "${C_BANNER}=======================================================================${C_RESET}"
echo ""
