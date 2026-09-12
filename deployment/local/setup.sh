#!/usr/bin/env bash
# Local installer. Use --dry-run to preview or --describe for question JSON.
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/nikzlabs/shipit.git"
REPO_URL="${SHIPIT_REPO_URL:-$DEFAULT_REPO_URL}"
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
export SHIPIT_HOME

OS="$(uname -s)"

# Keep this self-contained block byte-identical in both installers.
# --- BEGIN shipit-installer-common (docs/276) ------------------------------

# --- BEGIN shipit-picker (docs/271) ----------------------------------------
# Usage:
#   shipit_pick "<preselected,csv>" "key|Label|one-line hint" ...
#   -> SHIPIT_PICK_RESULT holds the chosen keys, comma-separated ("" when none).

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

# Restore the cursor on exit. read -s avoids stty races on interruption.
shipit_pick_restore() {
  printf '\033[?25h' > "${SHIPIT_PICK_DRAW:-/dev/stdout}"
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
  # Preserve defaults when no terminal is available.
  SHIPIT_PICK_RESULT="$(shipit_pick_selected)"
  if [ ! -t 0 ]; then return 1; fi

  # Draw on the controlling terminal when stdout is redirected.
  SHIPIT_PICK_DRAW="/dev/stdout"
  if [ ! -t 1 ]; then
    if { : > /dev/tty; } 2>/dev/null; then
      SHIPIT_PICK_DRAW="/dev/tty"
    else
      return 1
    fi
  fi

  # Bash 3.2 rejects fractional read timeouts.
  SHIPIT_PICK_ESC_T="0.05"
  if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then SHIPIT_PICK_ESC_T="1"; fi

  SHIPIT_PICK_C_ON=$'\033[1;36m'
  SHIPIT_PICK_C_OFF=$'\033[0m'
  SHIPIT_PICK_C_DIM=$'\033[2m'

  local key rest_seq
  SHIPIT_PICK_CURSOR=0
  SHIPIT_PICK_DONE=0
  trap 'shipit_pick_restore; exit 130' INT
  trap 'shipit_pick_restore; exit 143' TERM HUP

  {
    printf '\033[?25l'
    shipit_pick_render
    while [ "$SHIPIT_PICK_DONE" -eq 0 ]; do
      key=""
      if ! IFS= read -rsn1 key; then break; fi
      if [ "$key" = $'\e' ]; then
        rest_seq=""
        IFS= read -rsn2 -t "$SHIPIT_PICK_ESC_T" rest_seq || true
        key="$key$rest_seq"
      fi
      shipit_pick_key "$key"
      printf '\033[%dA' "$SHIPIT_PICK_COUNT"
      shipit_pick_render
    done
  } > "$SHIPIT_PICK_DRAW"

  trap - INT TERM HUP
  shipit_pick_restore
  SHIPIT_PICK_RESULT="$(shipit_pick_selected)"
  return 0
}
# --- END shipit-picker -----------------------------------------------------

# --- Machine-readable questions (docs/276) ---------------------------------
shipit_json_str() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

shipit_json_options() {
  local row first=1 key label hint
  printf '['
  for row in "$@"; do
    key="${row%%|*}"
    label="${row#*|}"
    label="${label%%|*}"
    hint="${row##*|}"
    if [ "$first" = "1" ]; then first=0; else printf ', '; fi
    printf '{"id": %s, "label": %s, "summary": %s}' \
      "$(shipit_json_str "$key")" \
      "$(shipit_json_str "$label")" \
      "$(shipit_json_str "$hint")"
  done
  printf ']'
}

HARNESS_ROWS=(
  "claude|Claude Code|Anthropic's CLI"
  "codex|Codex|OpenAI's CLI"
  "opencode|OpenCode|open-source, bring your own provider"
  "grok|Grok Build|xAI's CLI"
)
SUPPORTED_HARNESSES=""
for _row in "${HARNESS_ROWS[@]}"; do
  SUPPORTED_HARNESSES="${SUPPORTED_HARNESSES:+$SUPPORTED_HARNESSES }${_row%%|*}"
done
unset _row

# Keep synchronized with DEFAULT_HARNESSES in install-agent-clis.sh.
HARNESS_DEFAULT="claude,codex,opencode"

HARNESS_CHOICE=""
HARNESS_PERSIST=0
HARNESS_SOURCE=""

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

# Do not persist unanswered defaults; future approved defaults must still apply.
resolve_harnesses() {
  HARNESS_PERSIST=0
  if [ -n "${SHIPIT_HARNESSES:-}" ]; then
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
  echo "    Which agent CLIs should this install run? They are built into the"
  echo "    ShipIt images, so adding one later means running this installer again."
  echo ""
  echo "    [up/down] move    [space] select    [enter] confirm"
  echo ""
  # A failed picker returns defaults that must remain unpersisted.
  if ! shipit_pick "$HARNESS_DEFAULT" "${HARNESS_ROWS[@]}"; then
    HARNESS_CHOICE="$HARNESS_DEFAULT"
    HARNESS_SOURCE="default — no terminal to ask on"
    return 0
  fi
  HARNESS_CHOICE="$SHIPIT_PICK_RESULT"
  echo ""
  if [ -z "$HARNESS_CHOICE" ]; then
    HARNESS_CHOICE="$HARNESS_DEFAULT"
    HARNESS_SOURCE="default — nothing selected, and an install needs at least one"
  else
    HARNESS_PERSIST=1
    HARNESS_SOURCE="selected"
  fi
}

# An omitted egress answer keeps containment enabled.
EGRESS_ANSWER=""
egress_answer_valid() {
  case "$1" in
    on | off) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_egress_answer() {
  EGRESS_ANSWER="$(printf '%s' "${SHIPIT_EGRESS:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  if [ -n "$EGRESS_ANSWER" ] && ! egress_answer_valid "$EGRESS_ANSWER"; then
    echo "Error: SHIPIT_EGRESS must be 'on' or 'off' (got '${SHIPIT_EGRESS:-}')" >&2
    exit 1
  fi
}

# --- END shipit-installer-common -------------------------------------------

shipit_describe() {
  cat <<JSON
{
  "schema": "shipit.installer/1",
  "installer": "local",
  "summary": "ShipIt on your own macOS or Linux machine, bound to localhost. Updated by running update.sh.",
  "command": "bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)",
  "needsRoot": false,
  "platforms": ["macos", "linux", "wsl2"],
  "instructions": [
    "Show every question below to the person, with its options and its default.",
    "Do not choose for the person. Ask, then use the answer.",
    "A question whose askedWhen is not 'always' is asked only in that case; collect its answer first anyway, because the install cannot stop to ask later.",
    "Run the command with each answer exported as its variable. An answered question is never asked.",
    "Never print, log, or write to a file any value of a question marked secret.",
    "Docker must already be installed and running. This installer checks for it and stops; it never installs it."
  ],
  "questions": [
    {
      "id": "harnesses",
      "title": "Which agent CLIs to install",
      "summary": "The agent CLIs are built into the images, so this is an install-time choice, not a setting. Changing it later means editing the answer and running update.sh again. At least one is required. A harness still needs an account or key connected in Settings before it can run.",
      "type": "multi_select",
      "variable": "SHIPIT_HARNESSES",
      "valueFormat": "comma-separated option ids",
      "default": "$HARNESS_DEFAULT",
      "askedWhen": "always",
      "secret": false,
      "options": $(shipit_json_options "${HARNESS_ROWS[@]}")
    },
    {
      "id": "egress",
      "title": "Agent network containment",
      "summary": "ShipIt limits what each agent container can reach on the network. Some hosts (rootless Docker, a locked-down kernel) refuse the capability this needs. With containment on, the install stops on such a host; with it off, a prompt-injected agent could send your credentials out. Ask the person before you answer this, and say what it costs.",
      "type": "select",
      "variable": "SHIPIT_EGRESS",
      "valueFormat": "one option id",
      "default": "on",
      "askedWhen": "this host cannot run the containment sidecar",
      "secret": false,
      "options": [
        {"id": "on", "label": "Keep containment on", "summary": "the secure default; the install stops on such a host"},
        {"id": "off", "label": "Install without containment", "summary": "sessions get unrestricted outbound network"}
      ]
    }
  ],
  "parameters": [
    {
      "id": "home",
      "title": "Where to install",
      "variable": "SHIPIT_HOME",
      "default": "\$HOME/.shipit"
    },
    {
      "id": "repo",
      "title": "Install a fork instead of ShipIt itself",
      "variable": "SHIPIT_REPO_URL",
      "default": "$DEFAULT_REPO_URL"
    }
  ],
  "followUps": [
    {
      "id": "tailscale",
      "title": "Reach this install from another device",
      "summary": "The install binds to localhost only, because ShipIt has no built-in sign-in. This script adds a binding on the machine's Tailscale address and prints a URL that also serves the previews. Loopback keeps working.",
      "command": "\$SHIPIT_HOME/deployment/local/tailscale.sh",
      "askWhen": "the person wants to open ShipIt from a phone or another computer"
    }
  ]
}
JSON
}

shipit_help() {
  cat <<'HELP'
ShipIt — local install (macOS, Linux, WSL2)

  Clones ShipIt to ~/.shipit, builds the images, and starts it at
  http://localhost:4123. Docker must already be installed.

Options
  --dry-run    Ask the questions, print what a real run would do, change nothing.
  --describe   Print the questions as JSON and exit. Use this when you are
               running the install for someone else: ask them the questions it
               lists, then re-run with their answers in the variables it names.
  --help       This text.

  Neither --dry-run nor --describe needs Docker, and neither writes anything.

Answers (set before the command; an answered question is not asked)
  SHIPIT_HARNESSES   which agent CLIs to install, comma-separated
  SHIPIT_EGRESS      on|off — asked only if this machine cannot contain the
                     agent network. Unset keeps containment ON.

Other settings
  SHIPIT_HOME        where to install (default ~/.shipit)
  SHIPIT_REPO_URL    install a fork
HELP
}

DESCRIBE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --describe) DESCRIBE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help | -h)
      shipit_help
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$arg' (the options are --dry-run, --describe and --help)" >&2
      exit 1
      ;;
  esac
done
# The curl-through-bash form cannot pass an argument.
if [ "${SHIPIT_DESCRIBE:-}" = "1" ]; then DESCRIBE=1; fi
if [ "${SHIPIT_DRY_RUN:-}" = "1" ]; then DRY_RUN=1; fi

if [ "$DESCRIBE" = "1" ]; then
  shipit_describe
  exit 0
fi

resolve_egress_answer
if [ -n "${SHIPIT_HARNESSES:-}" ] &&
  ! harnesses_valid "$(printf '%s' "$SHIPIT_HARNESSES" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"; then
  echo "Error: SHIPIT_HARNESSES must be a comma-separated list of: $(echo "$SUPPORTED_HARNESSES" | tr ' ' ',') (got '$SHIPIT_HARNESSES')" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "==========================================="
  echo "  ShipIt — Local install  (DRY RUN)"
  echo "==========================================="
  echo ""
  echo "  Nothing will be installed, started, or written."
  echo ""
  resolve_harnesses
  echo ""
  echo "==========================================="
  echo "  Dry run complete — nothing was changed."
  echo "==========================================="
  echo ""
  echo "  A real run would:"
  echo "    - check for git and Docker, and stop with instructions if either is missing"
  echo "    - clone ShipIt to $SHIPIT_HOME and build the images with harnesses:"
  echo "      $HARNESS_CHOICE ($HARNESS_SOURCE)"
  echo "    - start ShipIt detached at http://localhost:4123"
  echo ""
  echo "  It would also — only if this machine cannot run the NET_ADMIN egress"
  echo "  sidecar — ask one more y/N question about containment. That question"
  echo "  cannot be previewed, because it depends on a Docker probe."
  echo ""
  echo "  To run the real install with this answer and no questions, set:"
  echo "    SHIPIT_HARNESSES=$HARNESS_CHOICE"
  echo ""
  echo "  For the same questions as JSON, run this with --describe instead."
  echo ""
  exit 0
fi

if [ ! -t 0 ] && [ -z "${SHIPIT_HARNESSES:-}" ]; then
  echo "==> No terminal to ask on, so every question will use its default."
  echo "    Installing this for someone else? Nothing has changed yet — stop,"
  echo "    run this again with --describe to get the questions and their"
  echo "    options, ask them, then run it with their answers."
  echo ""
fi

echo "==========================================="
echo "  ShipIt — Local install"
echo "==========================================="
echo ""

missing=0
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is not installed." >&2
  missing=1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed." >&2
  case "$OS" in
    Darwin) echo "  Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/" >&2 ;;
    *)      echo "  Install Docker Engine + the compose plugin: https://docs.docker.com/engine/install/" >&2 ;;
  esac
  missing=1
elif ! docker compose version >/dev/null 2>&1; then
  echo "Error: the Docker Compose v2 plugin ('docker compose') is not available." >&2
  echo "  See https://docs.docker.com/compose/install/" >&2
  missing=1
else
  docker_api_version="$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null || true)"
  minimum_docker_api="1.48"
  if [ -z "$docker_api_version" ] || [ "$(printf '%s\n%s\n' "$minimum_docker_api" "$docker_api_version" | sort -V | head -n1)" != "$minimum_docker_api" ]; then
    echo "Error: Docker Engine API $minimum_docker_api or newer is required (found ${docker_api_version:-unknown})." >&2
    missing=1
  fi
  compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  minimum_compose="2.24.4"
  if [ "$(printf '%s\n%s\n' "$minimum_compose" "$compose_version" | sort -V | head -n1)" != "$minimum_compose" ]; then
    echo "Error: Docker Compose $minimum_compose or newer is required (found $compose_version)." >&2
    missing=1
  fi
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if [ -d "$SHIPIT_HOME/.git" ]; then
  echo "==> ShipIt already cloned at $SHIPIT_HOME."
else
  echo "==> Cloning ShipIt to $SHIPIT_HOME ..."
  git clone "$REPO_URL" "$SHIPIT_HOME"
  echo "stable" > "$SHIPIT_HOME/.release-channel"
fi

# shellcheck source=/dev/null
. "$SHIPIT_HOME/deployment/local/lib.sh"

shipit_sync_checkout

# Linux hosts need more watches for concurrent sessions and previews.
if [ "$OS" = "Linux" ]; then
  conf="/etc/sysctl.d/99-shipit-inotify.conf"
  if [ ! -f "$conf" ]; then
    SUDO=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    fi
    if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
      echo "==> Raising inotify watcher limits (sessions + dev servers need these)..."
      $SUDO sh -c "printf 'fs.inotify.max_user_watches=524288\nfs.inotify.max_user_instances=512\n' > '$conf'" || true
      $SUDO sysctl --system >/dev/null 2>&1 || true
    else
      echo "==> Skipping inotify limit bump (needs root/sudo)."
      echo "    If file watching misbehaves, raise fs.inotify.max_user_watches manually."
    fi
  fi
fi

# Persist an explicit egress opt-out across rebuilds.
disable_egress_containment() {
  shipit_persist_env SESSION_EGRESS_ENFORCE 0
}

echo "==> Checking agent egress containment support..."
# Probe NET_ADMIN inside a disposable network namespace.
if docker run --rm --cap-add NET_ADMIN alpine sh -c 'ip link set lo down' >/dev/null 2>&1; then
  echo "    Agent egress containment: enabled (default-deny allowlist)."
elif [ "$EGRESS_ANSWER" = "off" ]; then
  disable_egress_containment
  echo "    Egress containment DISABLED (SHIPIT_EGRESS=off). Sessions will run with UNRESTRICTED outbound network."
elif [ "$EGRESS_ANSWER" = "on" ]; then
  echo "" >&2
  echo "  This host can't run the egress containment sidecar, and SHIPIT_EGRESS=on" >&2
  echo "  keeps containment required. Aborting — re-run on a host that can grant" >&2
  echo "  CAP_NET_ADMIN, or re-run with SHIPIT_EGRESS=off to install without it." >&2
  echo "" >&2
  exit 1
else
  echo "" >&2
  echo "  This host can't run the egress containment sidecar." >&2
  echo "  ShipIt isolates each agent container's outbound network with a privileged" >&2
  echo "  NET_ADMIN sidecar (default-deny + allowlist), and this host denied that" >&2
  echo "  capability (common with rootless Docker or a locked-down kernel)." >&2
  echo "" >&2
  echo "  Containment is ON by default and fails closed. You can install anyway with" >&2
  echo "  it DISABLED, but then a prompt-injected agent could exfiltrate credentials" >&2
  echo "  over the network." >&2
  echo "" >&2
  if [ -t 0 ]; then
    egress_reply=""
    read -rp "  Install with egress containment DISABLED (unrestricted egress)? [y/N]: " egress_reply
    case "$egress_reply" in
      y|Y|yes|Yes|YES)
        disable_egress_containment
        echo "    Egress containment DISABLED. Sessions will run with UNRESTRICTED outbound network."
        ;;
      *)
        echo "  Aborting — egress containment is required. Re-run on a host that can grant" >&2
        echo "  CAP_NET_ADMIN, or accept the prompt above to install without containment." >&2
        exit 1
        ;;
    esac
  else
    # Non-interactive installs fail closed without an explicit opt-out.
    echo "  Non-interactive install (no terminal to prompt). To install without" >&2
    echo "  containment, re-run with SHIPIT_EGRESS=off set before the command:" >&2
    echo "" >&2
    echo "      SHIPIT_EGRESS=off bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)" >&2
    echo "" >&2
    exit 1
  fi
fi

resolve_harnesses
if [ "$HARNESS_PERSIST" = "1" ]; then
  shipit_persist_env SHIPIT_HARNESSES "$HARNESS_CHOICE"
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE; persisted in $SHIPIT_ENV_FILE)."
else
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE)."
fi

shipit_build_and_up

echo ""
echo "  Sign in to Claude Code or Codex from the in-app provider flow on first launch."
echo "  Bound to localhost, so other devices cannot reach it — see deployment/README.md."
echo "  Update:  $SHIPIT_HOME/deployment/local/update.sh"
echo "  Stop:    $SHIPIT_HOME/deployment/local/stop.sh"
echo ""
echo "==================================================================="
echo "  Open ShipIt at   http://localhost:4123"
echo "==================================================================="
echo ""
