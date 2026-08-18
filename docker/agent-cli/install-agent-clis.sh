#!/bin/sh
# docs/252 phase 9 (req 14) — install the agent CLIs this deployment selected.
#
# WHICH harnesses an install has is a build input, not a setting: SHIPIT_HARNESSES
# (comma- or space-separated harness ids, defaulting to DEFAULT_HARNESSES below) is
# a build arg on EVERY image that carries the CLIs, and this one script is what
# consumes it. Two
# images install them independently — the orchestrator (docker/Dockerfile.prod,
# which probes its own binaries for the picker and runs session naming locally) and
# the session worker (docker/Dockerfile.session-worker.prod, where turns run — so a
# selection applied to only one of them would leave an uninstalled harness still
# offered in the picker, or still used for background work.
#
# The pinned install itself is unchanged (docs/141): one committed manifest,
# `npm ci` against the committed lockfile, `--ignore-scripts` for the whole tree
# and a targeted `npm rebuild` for each package whose postinstall materializes
# its binary inside the tree. Grok's postinstall does NOT (planning#442) — it
# installs to $GROK_HOME outside node_modules — so its binary is decompressed
# in place by this script instead of rebuilt; see the grok block below.
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
KNOWN_HARNESSES="claude codex opencode grok"

# The harnesses an install gets when SHIPIT_HARNESSES says nothing. A SEPARATE,
# hand-maintained list — deliberately NOT derived from KNOWN_HARNESSES (docs/271).
#
# Adding a harness above makes it installable and offerable at once; it does NOT
# make it default-on. Shipping a newly integrated agent CLI to every install that
# accepted the defaults is a product decision, so it stays off until someone edits
# this line. `deployment/vps/setup.sh` carries the same list as its picker
# preselection, and agent-cli-install.test.ts pins the two together.
DEFAULT_HARNESSES="claude codex opencode"

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
    # @xai-official/grok is the same shape as opencode-ai: platform binaries as
    # sibling packages under the same scope (@xai-official/grok-linux-x64, …),
    # so the scope+name prefix covers the shim AND every platform payload for
    # the prune (docs/274).
    grok) echo "@xai-official/grok" ;;
    *) return 1 ;;
  esac
}

# The binary each harness is spawned as (HarnessDef.binary in the catalogue).
harness_bin() {
  case "$1" in
    claude) echo "claude" ;;
    codex) echo "codex" ;;
    opencode) echo "opencode" ;;
    grok) echo "grok" ;;
    *) return 1 ;;
  esac
}

# What BIN_DIR/<bin> points at. Default: the npm-generated `.bin` shim. Grok is
# the exception (planning#442): its shim is a JS launcher whose job is to
# install or decompress the real binary at runtime, which either fails (read-
# only install tree) or costs a 157MB copy per spawn (throwaway $GROK_HOME).
# The grok block above already decompressed the binary in place, so PATH points
# straight at it and the launcher is never involved.
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

# Normalize the selection: commas → spaces, lowercase, de-duplicated, validated.
# Fail fast and loudly — a typo here would otherwise ship an image missing the
# harness the operator asked for, which surfaces much later as "the picker is empty".
# An EMPTY value means unset: the images pass the build arg through empty by
# default, and blanking the line in shipit.env gets the default rather than an
# agentless image. Naming nothing explicitly (",") is the error below.
#
# The default is DEFAULT_HARNESSES, the approved set — not every known harness.
# See its declaration above for why the two lists are separate.
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

# @xai-official/grok is NOT the same shape, though it looks it (planning#442).
# Its postinstall decompresses the platform package's brotli payload to
# $GROK_HOME/bin (default ~/.grok/bin) — OUTSIDE node_modules — which at image
# build time is root's home: 157MB of dead weight the runtime uid cannot see.
# And the `.bin/grok` JS launcher's own recovery paths both need a writable
# directory the runtime doesn't have or shouldn't pay for: its last-resort
# in-place decompress fails in the root-owned read-only install tree, and its
# preferred bootstrap would copy the 157MB binary into the adapter's throwaway
# per-spawn $GROK_HOME on every turn. So no `npm rebuild` here: decompress the
# payload in place ourselves and link PATH straight at the real binary (see
# harness_link_target), so the launcher never runs. The .br is deleted —
# nothing reads it after this step and it would ship 46MB of dead weight.
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
  target="$(harness_link_target "$harness")"
  if [ ! -x "$target" ]; then
    echo "ERROR: $harness selected but $target is missing after install." >&2
    exit 1
  fi
  ln -sf "$target" "$BIN_DIR/$bin"
done

# Prove each selected binary EXECUTES, not merely that its link resolves.
# planning#442 shipped because the old existence check passed while grok's real
# binary was still an undecompressed brotli blob. Scratch HOME (and GROK_HOME,
# which grok prefers over HOME) so a CLI's first-run state cannot land in the
# image layer — the build runs as root, and root's dotfiles are invisible to
# the runtime uid anyway.
verify_home="$(mktemp -d)"
for harness in $selected; do
  bin="$(harness_bin "$harness")"
  if ! out="$(HOME="$verify_home" GROK_HOME="$verify_home/.grok" timeout 120 "$BIN_DIR/$bin" --version 2>&1)"; then
    echo "ERROR: $harness installed but '$bin --version' does not execute:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "[install-agent-clis] verified $bin --version: $(printf '%s' "$out" | head -n 1)"
done
rm -rf "$verify_home"

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
