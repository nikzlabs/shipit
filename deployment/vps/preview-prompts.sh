#!/usr/bin/env bash
# Dry run of the VPS installer's interactive questions (docs/271).
#
#   bash deployment/vps/preview-prompts.sh
#
# Draws the two checklists exactly as `setup.sh` draws them — the picker code is
# extracted from setup.sh itself, so what you see here is the real prompt — then
# prints what the installer WOULD do and exits. It touches nothing: no packages,
# no Docker, no /etc/shipit, no clone. Use it to check a change to the picker
# without provisioning a VPS.
#
# The option rows below mirror the two calls in setup.sh. They are a visual
# preview, not the source of truth: setup.sh is.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="$HERE/setup.sh"

if [ ! -f "$SETUP" ]; then
  echo "Error: cannot find $SETUP" >&2
  exit 1
fi

# Pull the picker out of the installer rather than copying it, so this script
# cannot drift from the code it is previewing.
PICKER="$(mktemp)"
trap 'rm -f "$PICKER"' EXIT
sed -n '/BEGIN shipit-picker/,/END shipit-picker/p' "$SETUP" > "$PICKER"
if [ ! -s "$PICKER" ]; then
  echo "Error: no shipit-picker block found in $SETUP" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$PICKER"

if [ ! -t 0 ]; then
  echo "This is an interactive preview; run it from a terminal." >&2
  exit 1
fi

echo "==========================================="
echo "  ShipIt - Server Provisioning  (DRY RUN)"
echo "==========================================="
echo ""
echo "Access setup — how do you want to reach ShipIt from your browser?"
echo ""
echo "  Select both to get both. Select neither to install ShipIt without exposing"
echo "  it yet — you can run cloudflare.sh or tailscale.sh later to add access."
echo ""
echo "  [up/down] move    [space] select    [enter] confirm"
echo ""
shipit_pick "cloudflare" \
  "cloudflare|Cloudflare Tunnel|public HTTPS domain, Zero Trust protected" \
  "tailscale|Tailscale|private, reachable from your tailnet only"
ACCESS="$SHIPIT_PICK_RESULT"
echo ""

echo "==> Agent harnesses"
echo "    Which agent CLIs should this install run?"
echo ""
echo "    [up/down] move    [space] select    [enter] confirm"
echo ""
shipit_pick "claude,codex" \
  "claude|Claude Code|Anthropic's CLI" \
  "codex|Codex|OpenAI's CLI" \
  "opencode|OpenCode|open-source, bring your own provider"
HARNESSES="$SHIPIT_PICK_RESULT"
echo ""

echo "==========================================="
echo "  Nothing was installed. The real run would:"
echo "==========================================="
case ",$ACCESS," in
  *,cloudflare,*) echo "  - run cloudflare.sh (domain + Zero Trust + tunnel)" ;;
esac
case ",$ACCESS," in
  *,tailscale,*) echo "  - run tailscale.sh (tailnet access + preview forwarder)" ;;
esac
if [ -z "$ACCESS" ]; then
  echo "  - expose nothing; ShipIt listens on 127.0.0.1:4123 inside the VPS"
fi
if [ -z "$HARNESSES" ]; then
  echo "  - keep the default harnesses (claude,codex) — a deployment needs at least one"
else
  echo "  - persist SHIPIT_HARNESSES=$HARNESSES and build the images with it"
fi
echo ""
echo "  Equivalent non-interactive install:"
echo "    SHIPIT_ACCESS=${ACCESS:-none} SHIPIT_HARNESSES=${HARNESSES:-claude,codex} \\"
echo "      sudo -E bash deployment/vps/setup.sh"
echo ""
