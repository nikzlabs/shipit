#!/bin/sh
set -eu

AGENT_CLI_DIR="${AGENT_CLI_DIR:-/opt/agent-cli}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
INSTALL_REPORT="${SHIPIT_AGENTS_INSTALL_REPORT:-/opt/shipit/agents/installed.json}"

KNOWN_HARNESSES="claude codex opencode grok"
# New harnesses are opt-in until added here and to the setup pickers' defaults.
DEFAULT_HARNESSES="claude codex opencode"

# Prefixes also cover platform-specific sibling packages during pruning.
harness_pkg_prefix() {
  case "$1" in
    claude) echo "@anthropic-ai/claude-code" ;;
    codex) echo "@openai/codex" ;;
    opencode) echo "opencode" ;;
    grok) echo "@xai-official/grok" ;;
    *) return 1 ;;
  esac
}

harness_bin() {
  case "$1" in
    claude) echo "claude" ;;
    codex) echo "codex" ;;
    opencode) echo "opencode" ;;
    grok) echo "grok" ;;
    *) return 1 ;;
  esac
}

harness_link_target() {
  case "$1" in
    grok) echo "$AGENT_CLI_DIR/node_modules/@xai-official/grok-$(node -p 'process.platform + "-" + process.arch')/bin/grok" ;;
    *) echo "$AGENT_CLI_DIR/node_modules/.bin/$(harness_bin "$1")" ;;
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

raw_selection="${SHIPIT_HARNESSES:-}"
if [ -z "$raw_selection" ]; then
  raw_selection="$DEFAULT_HARNESSES"
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
# OpenCode needs Codex for ChatGPT login/renewal, without offering its harness.
required_clis="$selected"
if contains opencode $selected && ! contains codex $selected; then
  required_clis="$required_clis codex"
fi
echo "[install-agent-clis] installing harnesses:$selected"

cd "$AGENT_CLI_DIR"
npm ci --ignore-scripts

# These postinstall scripts materialize binaries inside node_modules.
if contains claude $selected; then
  npm rebuild @anthropic-ai/claude-code
fi

if contains opencode $selected; then
  npm rebuild opencode-ai
fi

# Grok's postinstall writes outside node_modules. Decompress once here to avoid
# a copy into each spawn's throwaway GROK_HOME or writes to the read-only install.
if contains grok $selected; then
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const zlib = require("node:zlib");
    const dir = path.join(process.cwd(), "node_modules",
      `@xai-official/grok-${process.platform}-${process.arch}`, "bin");
    const br = path.join(dir, "grok.br");
    const raw = path.join(dir, "grok");
    if (!fs.existsSync(raw)) {
      fs.writeFileSync(raw, zlib.brotliDecompressSync(fs.readFileSync(br)));
    }
    fs.chmodSync(raw, 0o755);
    fs.rmSync(br, { force: true });
    console.log(`[install-agent-clis] decompressed ${raw}`);
  '
  # .bin precedes BIN_DIR on PATH; remove the launcher so the direct link wins.
  rm -f "$AGENT_CLI_DIR/node_modules/.bin/grok"
  echo "[install-agent-clis] removed the grok launcher shim; PATH now resolves grok to the real binary"
fi

for harness in $KNOWN_HARNESSES; do
  contains "$harness" $required_clis && continue
  bin="$(harness_bin "$harness")"
  rm -f "$AGENT_CLI_DIR/node_modules/.bin/$bin" "$BIN_DIR/$bin"
  rm -rf "$AGENT_CLI_DIR"/node_modules/"$(harness_pkg_prefix "$harness")"*
  echo "[install-agent-clis] pruned $harness ($bin)"
done

for harness in $required_clis; do
  bin="$(harness_bin "$harness")"
  target="$(harness_link_target "$harness")"
  if [ ! -x "$target" ]; then
    echo "ERROR: $harness selected but $target is missing after install." >&2
    exit 1
  fi
  ln -sf "$target" "$BIN_DIR/$bin"
done

# A valid link does not prove execution. Keep first-run state out of the image.
verify_home="$(mktemp -d)"
for harness in $required_clis; do
  bin="$(harness_bin "$harness")"
  if ! out="$(HOME="$verify_home" GROK_HOME="$verify_home/.grok" timeout 120 "$BIN_DIR/$bin" --version 2>&1)"; then
    echo "ERROR: $harness installed but '$bin --version' does not execute:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "[install-agent-clis] verified $bin --version: $(printf '%s' "$out" | head -n 1)"
done
rm -rf "$verify_home"

ln -sf "$AGENT_CLI_DIR/node_modules/.bin/playwright-mcp" "$BIN_DIR/playwright-mcp"

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
