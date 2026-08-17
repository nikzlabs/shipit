#!/bin/bash
# One-time server provisioning for ShipIt on a fresh Ubuntu VPS.
# Safe to re-run - skips steps that are already done.
# Run as root: bash setup.sh
set -euo pipefail

CONFIG_FILE="/etc/shipit/setup.conf"

# --- BEGIN shipit-picker (docs/271) ----------------------------------------
# A checkbox prompt: arrow keys (or j/k) move, space toggles, Enter confirms.
#
# Bash and ANSI escapes only — no whiptail, dialog, ncurses, `tput`, or even
# `stty`. This script is curl|bash'd onto a bare Ubuntu box BEFORE anything is
# installed (req 9), so the prompt cannot depend on a package the install has not
# reached yet.
#
# Usage:
#   shipit_pick "<preselected,csv>" "key|Label|one-line hint" ...
#   -> SHIPIT_PICK_RESULT holds the chosen keys, comma-separated ("" when none).
#
# Returns non-zero WITHOUT prompting when there is no terminal to draw on,
# leaving the caller's preselection in SHIPIT_PICK_RESULT — so a non-interactive
# install keeps today's defaults rather than hanging on a read (req 7).
#
# The block between these markers is extracted verbatim and driven under a pty by
# src/server/orchestrator/services/installer-picker.test.ts. Keep it
# self-contained: nothing in here may call a helper defined outside the markers.

# Join the selected keys into the comma-separated answer.
shipit_pick_selected() {
  local i out=""
  for ((i = 0; i < SHIPIT_PICK_COUNT; i++)); do
    if [ "${SHIPIT_PICK_MARKS[i]}" = "1" ]; then
      if [ -n "$out" ]; then out="$out,"; fi
      out="$out${SHIPIT_PICK_KEYS[i]}"
    fi
  done
  printf '%s' "$out"
}

# Apply one keystroke to the picker state. Split out from the read loop so the
# whole key map is exercisable without a terminal.
shipit_pick_key() {
  case "$1" in
    # $'\eOA'/$'\eOB' are the same arrows in application-cursor mode, which some
    # terminals switch into; accepting both costs one alternative each.
    $'\e[A' | $'\eOA' | k | K)
      SHIPIT_PICK_CURSOR=$(((SHIPIT_PICK_CURSOR + SHIPIT_PICK_COUNT - 1) % SHIPIT_PICK_COUNT))
      ;;
    $'\e[B' | $'\eOB' | j | J)
      SHIPIT_PICK_CURSOR=$(((SHIPIT_PICK_CURSOR + 1) % SHIPIT_PICK_COUNT))
      ;;
    ' ')
      SHIPIT_PICK_MARKS[SHIPIT_PICK_CURSOR]=$((1 - SHIPIT_PICK_MARKS[SHIPIT_PICK_CURSOR]))
      ;;
    '')
      # `read -n1` strips the newline, so Enter arrives as the empty string.
      SHIPIT_PICK_DONE=1
      ;;
  esac
}

# Draw the list, one line per row, leaving the cursor on the line after the last.
shipit_pick_render() {
  local i box
  for ((i = 0; i < SHIPIT_PICK_COUNT; i++)); do
    if [ "${SHIPIT_PICK_MARKS[i]}" = "1" ]; then box="[*]"; else box="[ ]"; fi
    printf '\r\033[K'
    if [ "$i" -eq "$SHIPIT_PICK_CURSOR" ]; then
      printf '  %s>%s %s' "$SHIPIT_PICK_C_ON" "$SHIPIT_PICK_C_OFF" "$SHIPIT_PICK_C_ON"
    else
      printf '    '
    fi
    printf '%s %-*s' "$box" "$SHIPIT_PICK_WIDTH" "${SHIPIT_PICK_LABELS[i]}"
    if [ "$i" -eq "$SHIPIT_PICK_CURSOR" ]; then printf '%s' "$SHIPIT_PICK_C_OFF"; fi
    if [ -n "${SHIPIT_PICK_HINTS[i]}" ]; then
      printf '  %s%s%s' "$SHIPIT_PICK_C_DIM" "${SHIPIT_PICK_HINTS[i]}" "$SHIPIT_PICK_C_OFF"
    fi
    printf '\n'
  done
}

# Undo what the loop did to the terminal. Runs on the normal exit path AND from
# the SIGINT trap — a Ctrl-C that left the cursor hidden would hand the operator
# a shell with no visible cursor.
#
# Echo is deliberately NOT managed here. The obvious `stty -echo` around the loop
# is a trap: `read` saves the terminal state as it finds it and re-applies that
# state when an interrupt tears it down, which happens AFTER this trap runs — so
# a hand-set `-echo` is restored *back* on Ctrl-C, leaving the operator typing
# blind. `read -s` on both reads below suppresses echo for the window that
# matters and leaves the saved state echoing, which is what makes Ctrl-C safe.
shipit_pick_restore() {
  printf '\033[?25h'
}

shipit_pick() {
  local preselected="$1"
  shift
  SHIPIT_PICK_KEYS=()
  SHIPIT_PICK_LABELS=()
  SHIPIT_PICK_HINTS=()
  SHIPIT_PICK_MARKS=()
  SHIPIT_PICK_WIDTH=0
  SHIPIT_PICK_RESULT=""

  local spec rest label
  for spec in "$@"; do
    SHIPIT_PICK_KEYS+=("${spec%%|*}")
    rest="${spec#*|}"
    label="${rest%%|*}"
    SHIPIT_PICK_LABELS+=("$label")
    if [ "$rest" = "${rest#*|}" ]; then
      SHIPIT_PICK_HINTS+=("")
    else
      SHIPIT_PICK_HINTS+=("${rest#*|}")
    fi
    SHIPIT_PICK_MARKS+=(0)
    if [ "${#label}" -gt "$SHIPIT_PICK_WIDTH" ]; then SHIPIT_PICK_WIDTH="${#label}"; fi
  done
  SHIPIT_PICK_COUNT="${#SHIPIT_PICK_KEYS[@]}"
  if [ "$SHIPIT_PICK_COUNT" -eq 0 ]; then return 1; fi

  local i pre
  for pre in $(printf '%s' "$preselected" | tr ',' ' '); do
    for ((i = 0; i < SHIPIT_PICK_COUNT; i++)); do
      if [ "${SHIPIT_PICK_KEYS[i]}" = "$pre" ]; then SHIPIT_PICK_MARKS[i]=1; fi
    done
  done
  # Set the answer to the preselection BEFORE the terminal check, so the
  # non-interactive return still hands the caller a usable value.
  SHIPIT_PICK_RESULT="$(shipit_pick_selected)"
  if [ ! -t 0 ] || [ ! -t 1 ]; then return 1; fi

  SHIPIT_PICK_C_ON=$'\033[1;36m'
  SHIPIT_PICK_C_OFF=$'\033[0m'
  SHIPIT_PICK_C_DIM=$'\033[2m'

  printf '\033[?25l'
  trap 'shipit_pick_restore; exit 130' INT

  local key rest_seq
  SHIPIT_PICK_CURSOR=0
  SHIPIT_PICK_DONE=0
  shipit_pick_render
  while [ "$SHIPIT_PICK_DONE" -eq 0 ]; do
    key=""
    # A closed stdin (EOF) confirms the current state rather than spinning.
    if ! IFS= read -rsn1 key; then break; fi
    if [ "$key" = $'\e' ]; then
      # An arrow key arrives as three bytes at once, so this returns
      # immediately; the timeout only bounds a lone Escape keypress.
      rest_seq=""
      IFS= read -rsn2 -t 0.05 rest_seq || true
      key="$key$rest_seq"
    fi
    shipit_pick_key "$key"
    printf '\033[%dA' "$SHIPIT_PICK_COUNT"
    shipit_pick_render
  done

  trap - INT
  shipit_pick_restore
  SHIPIT_PICK_RESULT="$(shipit_pick_selected)"
  return 0
}
# --- END shipit-picker -----------------------------------------------------

# --- The interactive questions (docs/271) -----------------------------------
# Both questions live in functions here, ahead of every step that touches the
# host, so `--dry-run` can ask them and exit. That is the whole reason they are
# functions: a separate preview script would be a second copy of the rows and
# the defaults to keep in step with these.

SHIPIT_ENV_FILE="/etc/shipit/shipit.env"

# Tailscale is the default access path: it exposes ShipIt to your own devices and
# nothing else, with no domain to own and no public URL to protect. Cloudflare is
# the deliberate choice, since a public hostname is the bigger commitment.
ACCESS_DEFAULT="tailscale"

# The harnesses this installer OFFERS, as "key|Label|hint" picker rows. Their keys
# are also what validates a scripted SHIPIT_HARNESSES, so adding a row here makes
# a harness both visible and accepted — one edit, no second list to remember.
HARNESS_ROWS=(
  "claude|Claude Code|Anthropic's CLI"
  "codex|Codex|OpenAI's CLI"
  "opencode|OpenCode|open-source, bring your own provider"
)
SUPPORTED_HARNESSES=""
for _row in "${HARNESS_ROWS[@]}"; do
  SUPPORTED_HARNESSES="${SUPPORTED_HARNESSES:+$SUPPORTED_HARNESSES }${_row%%|*}"
done
unset _row

# The harnesses PRESELECTED in that list. Deliberately its own list rather than
# "every row" (docs/271): adding a harness above offers it to the operator right
# away, but turning it on for everyone who accepts the defaults is a product
# decision that happens here, on purpose. A newly added harness therefore appears
# unchecked until this line names it.
#
# Mirrors DEFAULT_HARNESSES in docker/agent-cli/install-agent-clis.sh, which is
# what an install that never sees this prompt gets; agent-cli-install.test.ts
# fails if the two disagree. They are separate files because this question is
# asked before the repo is cloned.
HARNESS_DEFAULT="claude,codex,opencode"

ACCESS=""
INSTALL_CLOUDFLARE=false
INSTALL_TAILSCALE=false
HARNESS_CHOICE=""
HARNESS_PERSIST=0
HARNESS_SOURCE=""

# True only for a list of recognized names with at least one entry, so that a
# value made of nothing but separators (",") is rejected rather than quietly
# meaning "expose nothing" — that is what `none` is for.
access_valid() {
  local candidate count=0
  for candidate in $(printf '%s' "$1" | tr ',' ' '); do
    case "$candidate" in
      cloudflare | tailscale) count=$((count + 1)) ;;
      *) return 1 ;;
    esac
  done
  [ "$count" -gt 0 ]
}

# As above: a list of recognized names with at least one entry. Counting the
# entries rather than testing the raw string is what rejects "," and " ", which
# name no harness and would otherwise fail much later in the image build.
harnesses_valid() {
  local candidate count=0
  for candidate in $(printf '%s' "$1" | tr ',' ' '); do
    case " $SUPPORTED_HARNESSES " in
      *" $candidate "*) count=$((count + 1)) ;;
      *) return 1 ;;
    esac
  done
  [ "$count" -gt 0 ]
}

# Set ACCESS and the two INSTALL_* flags it drives.
#
# Cloudflare and Tailscale are independent, so they are two checkboxes rather
# than a four-item menu: both selected installs both, neither selected installs
# ShipIt without exposing it. SHIPIT_ACCESS pre-answers the question for a
# scripted install, the same way SHIPIT_HARNESSES does.
resolve_access() {
  if [ -n "${SHIPIT_ACCESS:-}" ]; then
    ACCESS="$(printf '%s' "$SHIPIT_ACCESS" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    # "none" is the spelling for "expose nothing"; an empty variable is
    # indistinguishable from unset, so it cannot carry that meaning.
    if [ "$ACCESS" = "none" ]; then
      ACCESS=""
    elif ! access_valid "$ACCESS"; then
      echo "Error: SHIPIT_ACCESS must be a comma-separated list of 'cloudflare' and/or 'tailscale', or 'none' (got '$SHIPIT_ACCESS')" >&2
      exit 1
    fi
    echo "Access setup: ${ACCESS:-none} (from the environment)"
  elif [ -t 0 ]; then
    echo "Access setup — how do you want to reach ShipIt from your browser?"
    echo ""
    echo "  Cloudflare Tunnel exposes ShipIt at https://your-domain.com (a domain you"
    echo "  own and have added to Cloudflare). Cloudflare proxies traffic into this VPS"
    echo "  over an outbound tunnel — no inbound ports to open, no public IP exposed."
    echo "  Cloudflare Zero Trust is required by default so only authorized users can"
    echo "  reach ShipIt; the script can create the Access app and policy."
    echo ""
    echo "  Tailscale exposes ShipIt only to devices on your Tailscale network"
    echo "  (tailnet). No public URL; no one outside your tailnet can reach it."
    echo ""
    echo "  Select both to get both. Select neither to install ShipIt without exposing"
    echo "  it yet — you can run cloudflare.sh or tailscale.sh later to add access."
    echo ""
    echo "  [up/down] move    [space] select    [enter] confirm"
    echo ""
    shipit_pick "$ACCESS_DEFAULT" \
      "cloudflare|Cloudflare Tunnel|public HTTPS domain, Zero Trust protected" \
      "tailscale|Tailscale|private, reachable from your tailnet only" || true
    ACCESS="$SHIPIT_PICK_RESULT"
    echo ""
  else
    ACCESS="$ACCESS_DEFAULT"
  fi

  INSTALL_CLOUDFLARE=false
  INSTALL_TAILSCALE=false
  case ",$ACCESS," in *,cloudflare,*) INSTALL_CLOUDFLARE=true ;; esac
  case ",$ACCESS," in *,tailscale,*) INSTALL_TAILSCALE=true ;; esac
}

# Set HARNESS_CHOICE, plus HARNESS_PERSIST (write it to the env file?) and
# HARNESS_SOURCE (where the answer came from, for the log line).
#
# Which agent CLIs this install has is chosen HERE, at install time, and is a
# property of the deployment rather than a setting: it is a build arg for both
# the orchestrator and the session-worker images, so changing it later means
# editing SHIPIT_HARNESSES in the env file and re-running deploy.sh.
#
# HARNESS_PERSIST stays 0 for an UNANSWERED question, so the variable is left
# unset and the image build's own default (every harness it knows) keeps
# applying. Two reasons, and both matter: writing the default out would freeze
# this install against a harness added later, and a non-interactive RE-RUN of
# this script would overwrite an operator's earlier narrower choice, since
# setup.sh does not read the env file it writes.
resolve_harnesses() {
  HARNESS_PERSIST=0
  if [ -n "${SHIPIT_HARNESSES:-}" ]; then
    # Normalized FIRST, exactly as docker/agent-cli/install-agent-clis.sh does
    # before its own check: it accepts "Claude, Codex", so rejecting that here
    # would break scripted installs that work today.
    HARNESS_CHOICE="$(printf '%s' "$SHIPIT_HARNESSES" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if ! harnesses_valid "$HARNESS_CHOICE"; then
      echo "Error: SHIPIT_HARNESSES must be a comma-separated list of: $(echo "$SUPPORTED_HARNESSES" | tr ' ' ',') (got '$SHIPIT_HARNESSES')" >&2
      exit 1
    fi
    HARNESS_PERSIST=1
    HARNESS_SOURCE="from the environment"
    return 0
  fi
  if [ ! -t 0 ]; then
    HARNESS_CHOICE="$HARNESS_DEFAULT"
    HARNESS_SOURCE="default"
    return 0
  fi
  echo ""
  echo "==> Agent harnesses"
  echo "    Which agent CLIs should this install run? They are installed into the"
  echo "    ShipIt images, so adding one later means re-running this deploy."
  echo ""
  echo "    [up/down] move    [space] select    [enter] confirm"
  echo ""
  shipit_pick "$HARNESS_DEFAULT" "${HARNESS_ROWS[@]}" || true
  HARNESS_CHOICE="$SHIPIT_PICK_RESULT"
  echo ""
  if [ -z "$HARNESS_CHOICE" ]; then
    # An image with no harness fails the build, so an empty selection cannot be
    # honoured.
    HARNESS_CHOICE="$HARNESS_DEFAULT"
    HARNESS_SOURCE="default — nothing selected, and an install needs at least one"
  else
    HARNESS_PERSIST=1
    HARNESS_SOURCE="selected"
  fi
}

# --- Dry run: ask, report, change nothing (docs/271) ------------------------
# Runs before the saved config is even read, so it needs no root and touches no
# file. Everything it prints comes from the same functions the real install uses.
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Error: unknown argument '$arg' (the only option is --dry-run)" >&2
      exit 1
      ;;
  esac
done
if [ "${SHIPIT_DRY_RUN:-}" = "1" ]; then DRY_RUN=1; fi

if [ "$DRY_RUN" = "1" ]; then
  echo "==========================================="
  echo "  ShipIt - Server Provisioning  (DRY RUN)"
  echo "==========================================="
  echo ""
  echo "  Nothing will be installed, started, or written."
  echo ""
  resolve_access
  resolve_harnesses
  echo "==========================================="
  echo "  Dry run complete — nothing was changed."
  echo "==========================================="
  echo ""
  echo "  A real run would:"
  if [ "$INSTALL_CLOUDFLARE" = "true" ]; then
    echo "    - run cloudflare.sh: ask for your domain, create the Zero Trust app and"
    echo "      policy, create the tunnel and DNS routes, and lock down the firewall"
  fi
  if [ "$INSTALL_TAILSCALE" = "true" ]; then
    echo "    - run tailscale.sh: join the tailnet and start the preview forwarder"
  fi
  if [ "$INSTALL_CLOUDFLARE" != "true" ] && [ "$INSTALL_TAILSCALE" != "true" ]; then
    echo "    - expose nothing; ShipIt would listen on 127.0.0.1:4123 inside the VPS"
  fi
  echo "    - build the images with harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE)"
  echo ""
  echo "  It would also install Docker, clone ShipIt to /opt/shipit, raise the host"
  echo "  limits, install the systemd units, and — only if this host cannot run the"
  echo "  NET_ADMIN egress sidecar — ask one more y/N question about containment."
  echo "  Those steps need root. This one did not."
  echo ""
  echo "  To run the real install with these answers and no questions, set:"
  echo "    SHIPIT_ACCESS=${ACCESS:-none}"
  echo "    SHIPIT_HARNESSES=$HARNESS_CHOICE"
  echo ""
  exit 0
fi

# --- Load saved config from previous run, if any ---
DOMAIN=""
REPO_URL=""
ZERO_TRUST_DONE=""
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

# --- Resolve repo URL ---
# Precedence: SHIPIT_REPO_URL env (lets a fork override on the one-liner) >
# saved config from a previous run > the origin of an existing /opt/shipit
# clone > the public repo default. This keeps the curl|bash install prompt-free.
DEFAULT_REPO_URL="https://github.com/nikzlabs/shipit.git"
REPO_URL="${SHIPIT_REPO_URL:-$REPO_URL}"
if [ -z "$REPO_URL" ] && [ -d /opt/shipit/.git ]; then
  REPO_URL=$(git -C /opt/shipit remote get-url origin 2>/dev/null || true)
fi
if [ -z "$REPO_URL" ]; then
  REPO_URL="$DEFAULT_REPO_URL"
fi

echo "==========================================="
echo "  ShipIt - Server Provisioning"
echo "==========================================="
echo ""
resolve_access

# --- Save config for future re-runs (no secrets stored) ---
mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOC
DOMAIN="$DOMAIN"
REPO_URL="$REPO_URL"
ZERO_TRUST_DONE="${ZERO_TRUST_DONE:-}"
EOC
chmod 600 "$CONFIG_FILE"

# --- Clone or update repo (channel-aware, feature 162) ---
# The release channel lives in an untracked file so it survives git resets and
# rebuilds. Default to edge when absent so existing installs keep tracking main;
# fresh installs are pinned to stable below.
CHANNEL_FILE="/opt/shipit/.release-channel"

channel_ref() {
  # Echo the remote ref for a channel, falling back to main when the stable
  # branch does not yet exist on the remote (first-release bootstrap).
  local ch="$1"
  if [ "$ch" = "stable" ] && git -C /opt/shipit ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
    echo "origin/stable"
  else
    echo "origin/main"
  fi
}

if [ -d /opt/shipit/.git ]; then
  echo "==> Repo already cloned, syncing to its release channel..."
  CHANNEL="$(cat "$CHANNEL_FILE" 2>/dev/null || echo edge)"
  REF="$(channel_ref "$CHANNEL")"
  echo "    channel=$CHANNEL ref=$REF"
  # Mirror update.sh: never `git pull` (that would advance a stable box to the
  # upstream tip and silently un-pin it). Fetch + hard-reset to the channel ref.
  git -C /opt/shipit fetch origin --tags --prune
  git -C /opt/shipit fetch origin "${REF#origin/}"
  git -C /opt/shipit reset --hard "$REF"
else
  echo "==> Cloning repo..."
  apt-get update -qq
  apt-get install -y -qq git
  git clone "$REPO_URL" /opt/shipit
  # Fresh installs default to the stable channel and boot on the latest release
  # rather than the tip of main (falls back to main until the first stable cut).
  echo "stable" > "$CHANNEL_FILE"
  git -C /opt/shipit fetch origin --tags --prune
  REF="$(channel_ref stable)"
  echo "==> Pinning new install to stable channel (ref $REF)"
  git -C /opt/shipit reset --hard "$REF"
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

compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
minimum_compose="2.24.4"
if [ "$(printf '%s\n%s\n' "$minimum_compose" "$compose_version" | sort -V | head -n1)" != "$minimum_compose" ]; then
  echo "Error: Docker Compose $minimum_compose or newer is required (found $compose_version)." >&2
  exit 1
fi
docker_api_version="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null || true)"
minimum_docker_api="1.48"
if [ -z "$docker_api_version" ] || [ "$(printf '%s\n%s\n' "$minimum_docker_api" "$docker_api_version" | sort -V | head -n1)" != "$minimum_docker_api" ]; then
  echo "Error: Docker Engine API $minimum_docker_api or newer is required (found ${docker_api_version:-unknown})." >&2
  exit 1
fi

# --- Configure Docker network address pools ---
# ShipIt creates two Docker networks per contained Compose session. The default pool (~30 /16 subnets)
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

# --- Agent egress containment preflight (docs/172, planning#92) ---
# Egress containment is ON by default for all ShipIt instances (fail-closed):
# the orchestrator runs a privileged NET_ADMIN sidecar in each agent container's
# network namespace to apply a default-deny egress allowlist. If this host can't
# run that sidecar (NET_ADMIN denied, rootless Docker, locked-down kernel),
# ShipIt would fail closed and refuse to start sessions. Detect that here and
# offer the opt-out, persisted where deploy.sh reads it. SHIPIT_ENV_FILE is set
# with the questions above, since resolve_harnesses names it too.

# Probe whether a NET_ADMIN container can manipulate its network namespace — the
# capability the egress sidecar needs to install iptables rules. Bringing
# loopback down requires CAP_NET_ADMIN and touches only the throwaway container's
# own netns, so it's a safe, dependency-light proxy for "can run the sidecar".
egress_host_capable() {
  docker run --rm --cap-add NET_ADMIN alpine sh -c 'ip link set lo down' >/dev/null 2>&1
}

# Persist SESSION_EGRESS_ENFORCE into the env file deploy.sh loads (replace any
# existing line, else append). The file is created 0600 since it tunes runtime.
persist_egress_enforce() {
  local value="$1"
  mkdir -p "$(dirname "$SHIPIT_ENV_FILE")"
  touch "$SHIPIT_ENV_FILE"
  chmod 600 "$SHIPIT_ENV_FILE"
  if grep -q '^SESSION_EGRESS_ENFORCE=' "$SHIPIT_ENV_FILE" 2>/dev/null; then
    sed -i "s/^SESSION_EGRESS_ENFORCE=.*/SESSION_EGRESS_ENFORCE=$value/" "$SHIPIT_ENV_FILE"
  else
    echo "SESSION_EGRESS_ENFORCE=$value" >> "$SHIPIT_ENV_FILE"
  fi
}

echo ""
echo "==> Checking agent egress containment support..."
if egress_host_capable; then
  echo "    Agent egress containment: enabled (default-deny allowlist)."
else
  echo ""
  echo "  WARNING: this host can't run the egress containment sidecar."
  echo "  ShipIt isolates each agent container's outbound network with a privileged"
  echo "  NET_ADMIN sidecar (default-deny + allowlist). This host denied that"
  echo "  capability — common with rootless Docker or a locked-down kernel."
  echo ""
  echo "  Egress containment is ON by default and FAILS CLOSED: with it on, ShipIt"
  echo "  will refuse to start agent sessions on this host. You can disable"
  echo "  containment to let sessions run with UNRESTRICTED outbound network"
  echo "  (a prompt-injected agent could then exfiltrate credentials)."
  echo ""
  read -rp "  Proceed with egress containment DISABLED? [y/N]: " EGRESS_DISABLE
  EGRESS_DISABLE="${EGRESS_DISABLE:-N}"
  case "$EGRESS_DISABLE" in
    y|Y|yes|Yes|YES)
      persist_egress_enforce 0
      echo "    Egress containment DISABLED (SESSION_EGRESS_ENFORCE=0 persisted in $SHIPIT_ENV_FILE)."
      echo "    Re-enable later by removing that line and re-running deploy.sh."
      ;;
    *)
      echo "    Keeping egress containment ON (secure default). Sessions will fail to"
      echo "    start until this host can run the NET_ADMIN sidecar. To override later,"
      echo "    set SESSION_EGRESS_ENFORCE=0 in $SHIPIT_ENV_FILE and re-run deploy.sh."
      ;;
  esac
fi

# --- Agent harness selection (docs/252 req 14) ---
# The question itself is resolve_harnesses, defined with the other question near
# the top so `--dry-run` can ask it. All that is left here is to act on it: the
# answer is a build arg for the images deploy.sh is about to build.
persist_shipit_env() {
  local key="$1" value="$2"
  mkdir -p "$(dirname "$SHIPIT_ENV_FILE")"
  touch "$SHIPIT_ENV_FILE"
  chmod 600 "$SHIPIT_ENV_FILE"
  if grep -q "^${key}=" "$SHIPIT_ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$SHIPIT_ENV_FILE"
  else
    echo "${key}=${value}" >> "$SHIPIT_ENV_FILE"
  fi
}

resolve_harnesses
if [ "$HARNESS_PERSIST" = "1" ]; then
  persist_shipit_env SHIPIT_HARNESSES "$HARNESS_CHOICE"
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE; persisted in $SHIPIT_ENV_FILE)."
else
  # Left unset on purpose — see resolve_harnesses.
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE)."
fi

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
  echo "  WARNING: Cloudflare Zero Trust was disabled by explicit override."
  echo "  Your instance is publicly accessible unless another access layer protects it."
  echo "  To enable Zero Trust, run cloudflare.sh again without"
  echo "  SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1 and provide a Cloudflare API token."
fi

echo ""
echo "  Next steps:"
if [ -n "${DOMAIN:-}" ] && [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "    1. Open https://$DOMAIN in your browser"
elif [ "$INSTALL_TAILSCALE" = "true" ]; then
  echo "    1. Open the Tailscale URL printed above by tailscale.sh"
else
  echo "    1. Run cloudflare.sh or tailscale.sh when you're ready to expose ShipIt"
fi
if [ "${ZERO_TRUST_DONE:-}" = "true" ]; then
  echo "    2. Authenticate through Cloudflare Zero Trust"
elif [ "$INSTALL_CLOUDFLARE" = "true" ]; then
  echo "    2. This Cloudflare route is public because you explicitly disabled Zero Trust"
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
