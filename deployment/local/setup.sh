#!/usr/bin/env bash
# One-line local installer for ShipIt (macOS, Linux, and Windows via WSL2).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)
#
# Clones ShipIt to ~/.shipit (override with SHIPIT_HOME), builds the prod images,
# and starts ShipIt detached at http://localhost:4123. Unlike the VPS installer
# it sets up no Cloudflare / Tailscale / systemd — local binds to localhost and
# updates are applied by re-running deployment/local/update.sh. Installing a
# fork? Set SHIPIT_REPO_URL before the command.
#
# --dry-run   ask the question, print what a real run would do, change nothing.
# --describe  print the questions as JSON and exit, so an agent can ask the
#             person instead of a terminal picker asking them (docs/276).
# Both run before the preflight, so neither needs Docker.
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/nikzlabs/shipit.git"
REPO_URL="${SHIPIT_REPO_URL:-$DEFAULT_REPO_URL}"
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
export SHIPIT_HOME

OS="$(uname -s)"

# --- BEGIN shipit-installer-common (docs/276) ------------------------------
# Everything the LOCAL installer needs too, kept byte-identical between
# deployment/vps/setup.sh and deployment/local/setup.sh. Both scripts are
# curl|bash'd as a string, so neither has a library file to source at the moment
# it asks — or DESCRIBES — its questions; docs/271 records the same constraint
# for the picker alone. installer-describe.test.ts compares the two blocks byte
# for byte, so a fix applied to one and not the other fails the build.
#
# Nothing in here may reference a variable defined outside the markers.

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
  # Set the answer to the preselection BEFORE the terminal checks, so the
  # non-interactive return still hands the caller a usable value.
  SHIPIT_PICK_RESULT="$(shipit_pick_selected)"
  if [ ! -t 0 ]; then return 1; fi

  # WHERE TO DRAW. Not blindly stdout: `sudo bash setup.sh | tee install.log` is
  # a normal way to run an installer, and the typed prompts this replaced stayed
  # usable under it because `read -p` prompts on stderr and reads stdin. Drawing
  # only on a stdout that is a terminal would silently skip a question the
  # operator is sitting there waiting to answer — and, worse, hand the caller a
  # preselection it would then record as a deliberate choice. So when stdout is
  # redirected, draw on the controlling terminal instead. Only when there is no
  # terminal at all does this give up and return non-zero.
  SHIPIT_PICK_DRAW="/dev/stdout"
  if [ ! -t 1 ]; then
    # An open-for-write, not `[ -w ]`: a process with no controlling terminal
    # can pass the permission check and still fail to open /dev/tty (ENXIO).
    if { : > /dev/tty; } 2>/dev/null; then
      SHIPIT_PICK_DRAW="/dev/tty"
    else
      return 1
    fi
  fi

  # Bash 3.2 — /bin/bash on macOS, and so the shell the LOCAL installer most
  # often runs under — rejects a fractional read timeout outright ("invalid
  # timeout specification"). That breaks arrow keys, because the rest of the
  # escape sequence is never read, AND prints an error line into the middle of
  # the list being drawn. A whole second costs nothing here: the timeout bounds
  # only a LONE Escape keypress, since an arrow key's remaining bytes are
  # already waiting to be read.
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

  # Everything the loop draws goes to the terminal; `read` still takes stdin.
  {
    printf '\033[?25l'
    shipit_pick_render
    while [ "$SHIPIT_PICK_DONE" -eq 0 ]; do
      key=""
      # A closed stdin (EOF) confirms the current state rather than spinning.
      if ! IFS= read -rsn1 key; then break; fi
      if [ "$key" = $'\e' ]; then
        # An arrow key arrives as three bytes at once, so this returns
        # immediately; the timeout only bounds a lone Escape keypress.
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
# `--describe` prints this installer's questions as JSON, so an agent can ask
# the person instead of a terminal picker asking them. There is no jq on a bare
# box and no repo to source a helper from, so the two characters that can appear
# in a label, a hint or a path are escaped here.
shipit_json_str() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# Emit a question's "options" array from "key|Label|hint" rows — the SAME rows
# the picker draws. A harness added to the list is therefore offered to an agent
# in the same commit, rather than in a second place that is forgotten.
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

# The harnesses this installer OFFERS, as "key|Label|hint" picker rows. Their keys
# are also what validates a scripted SHIPIT_HARNESSES, so adding a row here makes
# a harness both visible and accepted — one edit, no second list to remember.
HARNESS_ROWS=(
  "claude|Claude Code|Anthropic's CLI"
  "codex|Codex|OpenAI's CLI"
  "opencode|OpenCode|open-source, bring your own provider"
  "grok|Grok Build|xAI's CLI (API key only)"
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

HARNESS_CHOICE=""
HARNESS_PERSIST=0
HARNESS_SOURCE=""

# A list of recognized names with at least one entry. Counting the
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

# Set HARNESS_CHOICE, plus HARNESS_PERSIST (write it to the env file?) and
# HARNESS_SOURCE (where the answer came from, for the log line).
#
# Which agent CLIs this install has is chosen HERE, at install time, and is a
# property of the deployment rather than a setting: it is a build arg for both
# the orchestrator and the session-worker images, so changing it later means
# editing SHIPIT_HARNESSES in the operator env file and re-running the deploy.
#
# HARNESS_PERSIST stays 0 for an UNANSWERED question, so the variable is left
# unset and the image build's own DEFAULT_HARNESSES keeps applying. Two reasons,
# and both matter: writing the default out would freeze this install against a
# later change to that list, and a non-interactive RE-RUN of the installer would
# overwrite an operator's earlier narrower choice, since neither installer reads
# the env file it writes.
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
  echo "    Which agent CLIs should this install run? They are built into the"
  echo "    ShipIt images, so adding one later means running this installer again."
  echo ""
  echo "    [up/down] move    [space] select    [enter] confirm"
  echo ""
  # Branch on the RETURN CODE, never on the answer. A picker that could not draw
  # hands back the preselection, which is indistinguishable from an operator who
  # ticked exactly those boxes — and recording it as a choice is what freezes the
  # set and clobbers a narrower one on the next run.
  if ! shipit_pick "$HARNESS_DEFAULT" "${HARNESS_ROWS[@]}"; then
    HARNESS_CHOICE="$HARNESS_DEFAULT"
    HARNESS_SOURCE="default — no terminal to ask on"
    return 0
  fi
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

# The egress-containment answer, when one was given (docs/276). "off" accepts the
# security downgrade on a host that cannot run the containment sidecar; "on"
# refuses it. UNSET is not "off": with no answer the installer keeps containment
# on, so an agent can never disable it by omission — only by passing the answer
# the person actually gave.
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

# --- Describe: the questions as JSON, for an agent (docs/276) ---------------
# Printed from the SAME rows the picker draws, and emitted BEFORE the preflight,
# so an agent can read it on a machine with no Docker and no clone (req 6).
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

# --- Arguments (docs/276) ---------------------------------------------------
# --help is here for discovery, not for politeness: an agent told "install
# ShipIt" reaches for --help far sooner than it reads a README, and --describe is
# useless to it if it never learns the flag exists. The unknown-argument error
# names the same options for the same reason.
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
# The env forms exist for the `bash -c "$(curl …)"` shape, which cannot pass an
# argument.
if [ "${SHIPIT_DESCRIBE:-}" = "1" ]; then DESCRIBE=1; fi
if [ "${SHIPIT_DRY_RUN:-}" = "1" ]; then DRY_RUN=1; fi

if [ "$DESCRIBE" = "1" ]; then
  shipit_describe
  exit 0
fi

# --- Validate the pre-answers BEFORE anything on the host changes -----------
# A mistyped answer used to fail where it was consumed, which for the harnesses
# is after the clone. An agent that mistypes an option id gets the error in a
# second, on a machine it has not yet changed.
resolve_egress_answer
if [ -n "${SHIPIT_HARNESSES:-}" ] &&
  ! harnesses_valid "$(printf '%s' "$SHIPIT_HARNESSES" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"; then
  echo "Error: SHIPIT_HARNESSES must be a comma-separated list of: $(echo "$SUPPORTED_HARNESSES" | tr ' ' ',') (got '$SHIPIT_HARNESSES')" >&2
  exit 1
fi

# --- Dry run: ask, report, change nothing (docs/276) ------------------------
# The counterpart of the VPS installer's --dry-run, and it sits BEFORE the
# preflight on purpose: the machine may have no Docker yet, and the question this
# previews needs none. What you answer here is drawn by the same picker the real
# install uses, so it is also the way to try the list itself.
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

# --- Running blind? Say so, before anything changes (docs/276) --------------
# The one case where the questions are about to be skipped without anyone having
# seen them: no terminal to draw a picker on, and no answers supplied. That is
# exactly what an agent's shell looks like, so this is where --describe is named
# for a reader who never opened the README.
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

# --- Preflight: required tooling (check-and-instruct, never auto-install) ---
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

# --- Clone (or reuse) the checkout ---
if [ -d "$SHIPIT_HOME/.git" ]; then
  echo "==> ShipIt already cloned at $SHIPIT_HOME."
else
  echo "==> Cloning ShipIt to $SHIPIT_HOME ..."
  git clone "$REPO_URL" "$SHIPIT_HOME"
  # Fresh installs track the stable channel (matches the VPS installer).
  echo "stable" > "$SHIPIT_HOME/.release-channel"
fi

# shellcheck source=/dev/null
. "$SHIPIT_HOME/deployment/local/lib.sh"

# Sync to the channel tip (a no-op on a just-cloned tree).
shipit_sync_checkout

# --- Linux only: raise inotify limits if we can (best effort) ---
# inotify limits are per-host, and every session container's file-watcher plus
# every preview dev server registers watches against them. macOS runs Docker in
# a VM that manages its own limits, so this is Linux-only. Skipped silently when
# we lack root/sudo rather than failing the install.
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

# --- Agent egress containment preflight (docs/172, planning#92) ---
# Containment is ON by default for all ShipIt instances (fail-closed): the
# orchestrator runs a privileged NET_ADMIN sidecar in each agent container's
# netns to apply a default-deny egress allowlist. If this host can't run that
# sidecar, ShipIt fails closed and refuses to start sessions. When the host
# can't grant the capability we ASK the operator (interactive) whether to
# install with containment disabled, rather than aborting with a variable to
# look up. SHIPIT_EGRESS=off pre-answers that prompt for non-interactive runs.

# Persist the egress opt-out (SESSION_EGRESS_ENFORCE=0) to the operator env file
# so it survives re-runs and image rebuilds; compose reads it via ${VAR:-}.
disable_egress_containment() {
  shipit_persist_env SESSION_EGRESS_ENFORCE 0
}

echo "==> Checking agent egress containment support..."
# Bringing loopback down in a throwaway NET_ADMIN container requires
# CAP_NET_ADMIN and touches only that container's own netns — a safe,
# dependency-light proxy for "can run the egress sidecar".
if docker run --rm --cap-add NET_ADMIN alpine sh -c 'ip link set lo down' >/dev/null 2>&1; then
  echo "    Agent egress containment: enabled (default-deny allowlist)."
elif [ "$EGRESS_ANSWER" = "off" ]; then
  # Explicit, pre-answered opt-out (set before the command — e.g. CI/automation,
  # or an agent passing on the decision the person made; docs/276 req 12).
  disable_egress_containment
  echo "    Egress containment DISABLED (SHIPIT_EGRESS=off). Sessions will run with UNRESTRICTED outbound network."
elif [ "$EGRESS_ANSWER" = "on" ]; then
  # The person was asked and kept containment. Say so and stop, rather than
  # asking again on a host whose answer cannot change.
  echo "" >&2
  echo "  This host can't run the egress containment sidecar, and SHIPIT_EGRESS=on" >&2
  echo "  keeps containment required. Aborting — re-run on a host that can grant" >&2
  echo "  CAP_NET_ADMIN, or re-run with SHIPIT_EGRESS=off to install without it." >&2
  echo "" >&2
  exit 1
else
  # The host denied CAP_NET_ADMIN — common with rootless Docker or a locked-down
  # kernel. sudo can't grant a capability the daemon won't hand out (and ShipIt
  # runs Docker un-elevated anyway), so this isn't a privilege we can escalate:
  # the real choice is "containment or not", which only the operator can make.
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
    # No terminal to prompt (e.g. piped via 'curl … | bash'): fail closed and
    # surface the pre-answer for the non-interactive case.
    echo "  Non-interactive install (no terminal to prompt). To install without" >&2
    echo "  containment, re-run with SHIPIT_EGRESS=off set before the command:" >&2
    echo "" >&2
    echo "      SHIPIT_EGRESS=off bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)" >&2
    echo "" >&2
    exit 1
  fi
fi

# --- Agent harness selection (docs/276 reqs 1-3) ---
# Asked here rather than before the clone because the answer is only needed by
# the image build below, and because the checkout is where it is persisted. The
# question itself is the VPS installer's, byte for byte — see the common block.
#
# HARNESS_PERSIST is 0 for an UNANSWERED question, and then nothing is written:
# the image build's own DEFAULT_HARNESSES keeps applying, so a later change to
# the approved set reaches this install on its next update instead of being
# frozen by a default it never chose.
resolve_harnesses
if [ "$HARNESS_PERSIST" = "1" ]; then
  shipit_persist_env SHIPIT_HARNESSES "$HARNESS_CHOICE"
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE; persisted in $SHIPIT_ENV_FILE)."
else
  echo "==> Agent harnesses: $HARNESS_CHOICE ($HARNESS_SOURCE)."
fi

# --- Build + start ---
shipit_build_and_up

echo ""
echo "==========================================="
echo "  ShipIt is running"
echo "==========================================="
echo ""
echo "  Open:    http://localhost:4123"
echo "  Update:  $SHIPIT_HOME/deployment/local/update.sh"
echo "  Stop:    $SHIPIT_HOME/deployment/local/stop.sh"
echo ""
echo "  On first launch, sign in to Claude Code or Codex from the in-app provider flow."
echo ""
# Stated as a property of THIS install, with no reference to Tailscale: docs/254
# req 3 requires the default path not to mention it, since most local users will
# never use it. Remote access is documented in deployment/README.md for the few
# who want it.
echo "  ShipIt is bound to localhost, so it is not reachable from other devices."
echo "  See deployment/README.md if you want to reach it from another device."
echo ""
