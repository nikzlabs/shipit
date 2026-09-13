#!/usr/bin/env bash
# Antigravity CLI Phase 0 probes for docs/301 (metered key or one Google sign-in).
#
#   ./probe.sh [all|mcp|plugin|compact]   run the selected probe group (default all)
#   ./probe.sh reset                      delete the scratch home and probe outputs
#
# Probes (outputs under /persist/agy-login-test/probes/):
#   mcp      global-mcp   how an MCP tool call appears in the stream (call_mcp_tool)
#   plugin   plugin-*     does an INSTALLED plugin load rules, MCP, skills
#   compact  compact-*    what /compact does on a resumed headless conversation
#
# The free tier allows 5 requests/min on flash and a turn makes several, so runs
# are paced (PACE seconds between runs) and a 429 run is retried once.

set -u
trap 'echo; echo "aborted"; pkill -TERM -P $$ 2>/dev/null; exit 130' INT TERM
ROOT=/persist/agy-login-test
AGY="$ROOT/bin/antigravity"
HOME1="$ROOT/home"
WS="$ROOT/ws"
OUT="$ROOT/probes"
TOKEN="$HOME1/.gemini/antigravity-cli/antigravity-oauth-token"
CONF="$HOME1/.gemini/config"
PLUG="$HOME1/.gemini/antigravity-cli/plugins/shipitprobe"
GROUP="${1:-all}"
PACE="${PACE:-65}"
# The free tier has zero quota for the default gemini-3.1-pro; flash has some.
MODEL="${AGY_MODEL:-gemini-3.8-flash-low}"

say() { printf '\n== %s\n' "$*"; }
want() { [ "$GROUP" = all ] || [ "$GROUP" = "$1" ]; }

if [ "$GROUP" = "reset" ]; then
  rm -rf "$HOME1" "$ROOT/home-copy" "$WS" "$OUT"
  echo "scratch home and probe outputs removed"
  exit 0
fi

[ -x "$AGY" ] || { echo "binary missing; run ./run.sh first"; exit 1; }
unset GOOGLE_API_KEY AGY_ADC_AUTH GOOGLE_APPLICATION_CREDENTIALS
mkdir -p "$HOME1" "$WS" "$OUT"
cd "$WS" || exit 1

# 0. Credential: a metered key from the environment (ShipIt secret, agent: true)
#    wins; otherwise sign in once if no token is saved.
if [ -n "${GEMINI_API_KEY:-}" ]; then
  say "Using GEMINI_API_KEY from the environment (metered key mode, model $MODEL)"
  mkdir -p "$HOME1/.gemini/antigravity-cli"
  echo '{"modelProvider":"gemini"}' >"$HOME1/.gemini/antigravity-cli/settings.json"
elif [ ! -f "$TOKEN" ]; then
  say "SIGN-IN: the CLI prints a Google URL and waits 60 s for the code"
  read -r -p "Press Enter to start..." _
  HOME="$HOME1" "$AGY" -p "Reply with the single word pong." --output-format text
  rc=$?
  echo "CLI exited with status $rc"
  [ -f "$TOKEN" ] || { echo "no token saved; sign-in did not complete"; exit 1; }
else
  say "Using saved token ($TOKEN)"
fi

first_run=1
run_once() {  # run_once <label> <prompt> [extra args...]
  local label="$1"; shift
  local prompt="$1"; shift
  HOME="$HOME1" timeout --foreground 240 "$AGY" -p "$prompt" --model "$MODEL" \
    --output-format stream-json --dangerously-skip-permissions --print-timeout 3m "$@" \
    </dev/null >"$OUT/$label.ndjson" 2>"$OUT/$label.stderr"
  echo "exit=$?"
}
run() {  # run <label> <prompt> [extra args...]
  local label="$1"
  say "PROBE $label"
  if [ "$first_run" = 1 ]; then first_run=0; else echo "(pacing ${PACE}s)"; sleep "$PACE"; fi
  run_once "$@"
  if grep -q "Error 429" "$OUT/$label.stderr" "$OUT/$label.ndjson" 2>/dev/null; then
    echo "429 — retrying once after ${PACE}s"; sleep "$PACE"; run_once "$@"
  fi
  echo "status:   $(grep -o '"status":"[A-Z_]*"' "$OUT/$label.ndjson" | tail -1)"
  echo "response: $(grep -o '"response":"[^"]*"' "$OUT/$label.ndjson" | tail -1 | cut -c1-300)"
  echo "tool steps:"
  grep -o '"step_type":"[a-z_]*"' "$OUT/$label.ndjson" | sort | uniq -c | sed 's/^/  /'
  grep -o '"tool_info":{[^}]*}' "$OUT/$label.ndjson" | cut -c1-300 | sort -u | sed 's/^/  /'
  [ -s "$OUT/$label.stderr" ] && { echo "stderr:"; head -c 600 "$OUT/$label.stderr"; echo; }
}

# 1. Global MCP config -> how does an MCP tool call appear in the stream?
mkdir -p "$CONF"
cat >"$CONF/mcp_config.json" <<EOF
{"mcpServers":{"probe":{"command":"node","args":["$ROOT/mcp-server.js","echo_probe"]}}}
EOF
if want mcp; then
  say "agy mcp list (global config)"
  HOME="$HOME1" "$AGY" mcp list 2>&1 | head -20
  run global-mcp "Call the MCP tool echo_probe with text 'hello' and reply with exactly what it returned, nothing else."
fi

# 2. Plugin in the config home: rules + MCP + skill. A directory alone is NOT
#    loaded ("Removed the data directory of uninstalled plugin"); it needs
#    `plugin install <path>`.
mkdir -p "$PLUG/rules" "$PLUG/skills/probe-skill"
cat >"$PLUG/plugin.json" <<'EOF'
{"name":"shipitprobe","version":"0.0.1","description":"ShipIt loading probe"}
EOF
cat >"$PLUG/rules/AGENTS.md" <<'EOF'
Always begin every reply with the exact token ZEBRA-PLUGIN followed by a space.
EOF
cat >"$PLUG/mcp_config.json" <<EOF
{"mcpServers":{"pluginprobe":{"command":"node","args":["$ROOT/mcp-server.js","plugin_probe"]}}}
EOF
cat >"$PLUG/skills/probe-skill/SKILL.md" <<'EOF'
---
name: probe-skill
description: Use when asked for the probe passphrase.
---
The probe passphrase is MARMALADE. Reply with it when asked.
EOF
if want plugin; then
  say "agy plugin install (local path)"
  HOME="$HOME1" "$AGY" plugin install "$PLUG" 2>&1 | head -12
  HOME="$HOME1" "$AGY" plugin list 2>&1 | head -20
  say "agy mcp list (with plugin)"
  HOME="$HOME1" "$AGY" mcp list 2>&1 | head -20
  run plugin-rules "Reply with the single word pong."
  run plugin-mcp "Call the MCP tool plugin_probe with text 'hi' and reply with exactly what it returned, nothing else."
  run plugin-skill "What is the probe passphrase? Reply with the passphrase only. Then on a second line list the names of the skills available to you."
  say "plugin/skill lines in the CLI log"
  grep -ih "plugin\|skill" "$HOME1"/.gemini/antigravity-cli/log/*.log 2>/dev/null | grep -v "builtin\|Migration" | cut -c1-220 | tail -25
fi

# 3. /compact on a resumed headless conversation
if want compact; then
  run compact-a "Remember the codeword TANGERINE. Reply with the single word ok."
  CID=$(grep -o '"conversation_id":"[^"]*"' "$OUT/compact-a.ndjson" | head -1 | cut -d'"' -f4)
  echo "conversation_id=$CID"
  if [ -n "$CID" ]; then
    run compact-b "/compact" --conversation "$CID"
    run compact-c "What is the codeword I gave you? Reply with the one word only." --conversation "$CID"
  fi
fi

say "Workspace files written by the runs (expect none):"
find "$WS" -type f | sed "s|$WS/||"
say "Done. Outputs in $OUT."
