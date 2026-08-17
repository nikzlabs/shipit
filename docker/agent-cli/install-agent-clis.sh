#!/bin/sh
# docs/252 phase 9 (req 14) — install the agent CLIs this deployment selected.
#
# WHICH harnesses an install has is a build input, not a setting: SHIPIT_HARNESSES
# (comma- or space-separated harness ids, defaulting to every harness this build
# knows) is a build arg on
# EVERY image that carries the CLIs, and this one script is what consumes it. Two
# images install them independently — the orchestrator (docker/Dockerfile.prod,
# which probes its own binaries for the picker and runs session naming locally) and
# the session worker (docker/Dockerfile.session-worker.prod, where turns run — so a
# selection applied to only one of them would leave an uninstalled harness still
# offered in the picker, or still used for background work.
#
# The pinned install itself is unchanged (docs/141): one committed manifest,
# `npm ci` against the committed lockfile, `--ignore-scripts` for the whole tree
# and a targeted `npm rebuild` for the one package that ships a native binary.
# Deselected harnesses are PRUNED after that install rather than excluded from it,
# because npm has no supported way to omit an arbitrary dependency from `npm ci`
# and splitting the manifest per CLI would fork the Renovate/contract-test flow
# docs/141 exists to keep single. The cost is download time for a CLI that is then
# deleted; the benefit is that the lockfile stays the one pinned, integrity-verified
# source and the image genuinely does not contain the deselected binary.
#
# Writes /opt/shipit/agents/installed.json — the declared set, which
# `src/server/shared/installed-harnesses.ts` reads instead of trusting a `which`
# probe of whatever happens to be on the orchestrator's own $PATH.
set -eu

AGENT_CLI_DIR="${AGENT_CLI_DIR:-/opt/agent-cli}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
INSTALL_REPORT="${SHIPIT_AGENTS_INSTALL_REPORT:-/opt/shipit/agents/installed.json}"

# Every harness ShipIt supports. MUST match the ids in
# src/server/shared/catalogue/harnesses.ts — guarded by
# src/server/orchestrator/agent-cli-install.test.ts, which fails the build when a
# harness is added to the catalogue without an install mapping here.
KNOWN_HARNESSES="claude codex opencode"

# The npm scope+name prefix each harness installs under. A prefix, not an exact
# name: both CLIs ship platform-specific optional dependencies alongside the main
# package (@anthropic-ai/claude-code-linux-x64, @openai/codex-linux-x64), and
# leaving those behind would keep ~100 MB of a harness we were told not to install.
harness_pkg_prefix() {
  case "$1" in
    claude) echo "@anthropic-ai/claude-code" ;;
    codex) echo "@openai/codex" ;;
    # opencode-ai's platform binaries install as sibling packages
    # (opencode-linux-x64, …), so the prefix "opencode" covers the shim AND
    # every platform payload for the prune (docs/268).
    opencode) echo "opencode" ;;
    *) return 1 ;;
  esac
}

# The binary each harness is spawned as (HarnessDef.binary in the catalogue).
harness_bin() {
  case "$1" in
    claude) echo "claude" ;;
    codex) echo "codex" ;;
    opencode) echo "opencode" ;;
    *) return 1 ;;
  esac
}

contains() {
  needle="$1"
  shift
  for item in "$@"; do
    [ "$item" = "$needle" ] || continue
    return 0
  done
  return 1
}

# Normalize the selection: commas → spaces, lowercase, de-duplicated, validated.
# Fail fast and loudly — a typo here would otherwise ship an image missing the
# harness the operator asked for, which surfaces much later as "the picker is empty".
# An EMPTY value means unset: the images pass the build arg through empty by
# default, and blanking the line in shipit.env gets the default rather than an
# agentless image. Naming nothing explicitly (",") is the error below.
#
# The default is KNOWN_HARNESSES — every harness this build knows about (docs/271).
# That is deliberately derived rather than spelled out: a new harness added to
# that one list is then on by default everywhere, with no build arg, compose file
# or installer to remember to update.
raw_selection="${SHIPIT_HARNESSES:-}"
if [ -z "$raw_selection" ]; then
  raw_selection="$KNOWN_HARNESSES"
fi
selected=""
for token in $(printf '%s' "$raw_selection" | tr ',' ' ' | tr '[:upper:]' '[:lower:]'); do
  if ! contains "$token" $KNOWN_HARNESSES; then
    echo "ERROR: unknown harness '$token' in SHIPIT_HARNESSES='$raw_selection'." >&2
    echo "       Valid harnesses: $(echo $KNOWN_HARNESSES | tr ' ' ',')" >&2
    exit 1
  fi
  contains "$token" $selected || selected="$selected $token"
done
if [ -z "$selected" ]; then
  echo "ERROR: SHIPIT_HARNESSES selected no harnesses; an install with none can run no sessions." >&2
  echo "       Valid harnesses: $(echo $KNOWN_HARNESSES | tr ' ' ',')" >&2
  exit 1
fi
echo "[install-agent-clis] installing harnesses:$selected"

cd "$AGENT_CLI_DIR"
npm ci --ignore-scripts

# @anthropic-ai/claude-code ships a native binary its install script links into
# place, so it needs the one script the `--ignore-scripts` blanket blocked. Only
# when it was selected — otherwise the package is about to be removed.
if contains claude $selected; then
  npm rebuild @anthropic-ai/claude-code
fi

# opencode-ai is the same shape: its postinstall copies the right
# platform-specific binary (an optionalDependency) into bin/opencode.exe, and
# without it the CLI errors at startup ("postinstall script was not run" —
# verified, docs/268). Only when selected.
if contains opencode $selected; then
  npm rebuild opencode-ai
fi

# Prune the deselected harnesses, bins first so a failed rm can't leave a dangling
# link that `which` would still answer.
for harness in $KNOWN_HARNESSES; do
  contains "$harness" $selected && continue
  bin="$(harness_bin "$harness")"
  rm -f "$AGENT_CLI_DIR/node_modules/.bin/$bin" "$BIN_DIR/$bin"
  rm -rf "$AGENT_CLI_DIR"/node_modules/"$(harness_pkg_prefix "$harness")"*
  echo "[install-agent-clis] pruned $harness ($bin)"
done

# Link the selected harnesses onto PATH, verifying each one survived the install.
# The verification is what makes the report below a fact rather than a restatement
# of the request.
for harness in $selected; do
  bin="$(harness_bin "$harness")"
  if [ ! -x "$AGENT_CLI_DIR/node_modules/.bin/$bin" ]; then
    echo "ERROR: $harness selected but $AGENT_CLI_DIR/node_modules/.bin/$bin is missing after install." >&2
    exit 1
  fi
  ln -sf "$AGENT_CLI_DIR/node_modules/.bin/$bin" "$BIN_DIR/$bin"
done

# playwright-mcp is not a harness — it is the browser MCP server every session
# gets — so it is installed and linked regardless of the selection.
ln -sf "$AGENT_CLI_DIR/node_modules/.bin/playwright-mcp" "$BIN_DIR/playwright-mcp"

# The install report: the authoritative installed set for both images.
mkdir -p "$(dirname "$INSTALL_REPORT")"
{
  printf '{"harnesses":['
  sep=""
  for harness in $selected; do
    printf '%s"%s"' "$sep" "$harness"
    sep=","
  done
  printf ']}\n'
} > "$INSTALL_REPORT"
echo "[install-agent-clis] wrote $INSTALL_REPORT: $(cat "$INSTALL_REPORT")"
