#!/bin/sh
set -eu

AGENT_CLI_DIR="${AGENT_CLI_DIR:-/opt/agent-cli}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
INSTALL_REPORT="${SHIPIT_AGENTS_INSTALL_REPORT:-/opt/shipit/agents/installed.json}"

KNOWN_HARNESSES="claude codex opencode grok antigravity"
# New harnesses are opt-in until added here and to the setup pickers' defaults.
DEFAULT_HARNESSES="claude codex opencode"

# Antigravity ships a per-version GitHub release tarball, not an npm package. The
# pin is hand-verified against the release list (>= 7 days old at the time it was
# raised) because check-deps only reads the two npm manifests. Overridable so the
# behavioural tests can point the fetch at a local file:// tarball with its own
# digest — there is ONE fetch path and it always verifies.
ANTIGRAVITY_VERSION="${ANTIGRAVITY_VERSION:-1.1.27}"
ANTIGRAVITY_BASE_URL="${ANTIGRAVITY_BASE_URL:-https://github.com/google-antigravity/antigravity-cli/releases/download}"
ANTIGRAVITY_SHA256_X64="${ANTIGRAVITY_SHA256_X64:-f874d4f6b8a73c2df660f580f25fb656fcb6e64adbfd746e6692e837fd9a20be}"
ANTIGRAVITY_SHA256_ARM64="${ANTIGRAVITY_SHA256_ARM64:-97fc9fe5a6067406cd02cbe4ae6e362c9623a24d33bec486911246c17ceb6a94}"
# Read-only and outside node_modules: the CLI's auto-updater has no off-switch
# flag and skips itself when its install directory is not writable.
ANTIGRAVITY_DIR="${ANTIGRAVITY_DIR:-/opt/antigravity}"

# Prefixes also cover platform-specific sibling packages during pruning.
harness_pkg_prefix() {
  case "$1" in
    claude) echo "@anthropic-ai/claude-code" ;;
    codex) echo "@openai/codex" ;;
    opencode) echo "opencode" ;;
    grok) echo "@xai-official/grok" ;;
    # Not an npm package; the sentinel matches no node_modules entry so the
    # generic prune loop is a no-op for it (the tarball prune is explicit).
    antigravity) echo "__antigravity-is-not-on-npm__" ;;
    *) return 1 ;;
  esac
}

harness_bin() {
  case "$1" in
    claude) echo "claude" ;;
    codex) echo "codex" ;;
    opencode) echo "opencode" ;;
    grok) echo "grok" ;;
    antigravity) echo "antigravity" ;;
    *) return 1 ;;
  esac
}

harness_link_target() {
  case "$1" in
    grok) echo "$AGENT_CLI_DIR/node_modules/@xai-official/grok-$(node -p 'process.platform + "-" + process.arch')/bin/grok" ;;
    antigravity) echo "$ANTIGRAVITY_DIR/antigravity" ;;
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

if contains antigravity $selected; then
  case "$(uname -m)" in
    x86_64|amd64) agy_arch="x64"; agy_sha="$ANTIGRAVITY_SHA256_X64" ;;
    aarch64|arm64) agy_arch="arm64"; agy_sha="$ANTIGRAVITY_SHA256_ARM64" ;;
    *) echo "ERROR: antigravity has no release asset for $(uname -m)." >&2; exit 1 ;;
  esac
  agy_tar="$(mktemp)"
  agy_url="$ANTIGRAVITY_BASE_URL/$ANTIGRAVITY_VERSION/agy_cli_linux_$agy_arch.tar.gz"
  echo "[install-agent-clis] fetching $agy_url"
  curl -fsSL -o "$agy_tar" "$agy_url"
  actual="$(sha256sum "$agy_tar" | cut -d' ' -f1)"
  if [ "$actual" != "$agy_sha" ]; then
    echo "ERROR: antigravity $ANTIGRAVITY_VERSION ($agy_arch) digest mismatch." >&2
    echo "       expected $agy_sha" >&2
    echo "       actual   $actual" >&2
    rm -f "$agy_tar"
    exit 1
  fi
  # A previous run sealed this directory; nothing can delete inside it until the
  # write bit is back, and relying on "we are root" would make a reinstall fail
  # for any other uid.
  [ -d "$ANTIGRAVITY_DIR" ] && chmod -R u+w "$ANTIGRAVITY_DIR"
  rm -rf "$ANTIGRAVITY_DIR"
  mkdir -p "$ANTIGRAVITY_DIR"
  tar -xzf "$agy_tar" -C "$ANTIGRAVITY_DIR"
  rm -f "$agy_tar"
  chmod 0755 "$ANTIGRAVITY_DIR/antigravity"
  # The updater logs "Directory ... is not fully accessible (readable: true,
  # writable: false), skipping update" and exits. Re-check that line on every
  # version bump (docs/272).
  chmod -R a-w "$ANTIGRAVITY_DIR"
  echo "[install-agent-clis] installed antigravity $ANTIGRAVITY_VERSION ($agy_arch) read-only into $ANTIGRAVITY_DIR"
fi

for harness in $KNOWN_HARNESSES; do
  contains "$harness" $required_clis && continue
  bin="$(harness_bin "$harness")"
  rm -f "$AGENT_CLI_DIR/node_modules/.bin/$bin" "$BIN_DIR/$bin"
  rm -rf "$AGENT_CLI_DIR"/node_modules/"$(harness_pkg_prefix "$harness")"*
  if [ "$harness" = "antigravity" ] && [ -d "$ANTIGRAVITY_DIR" ]; then
    chmod -R u+w "$ANTIGRAVITY_DIR"
    rm -rf "$ANTIGRAVITY_DIR"
  fi
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
