#!/usr/bin/env bash
# What does the Antigravity CLI actually offer the MODEL in a headless spawn?
#
# `init.tools` advertises the CLI's whole catalogue (57 on 1.1.27) and is NOT
# that answer. The answer is on the wire: redirect GOOGLE_GEMINI_BASE_URL at
# recorder.js and read tools[].functionDeclarations[].name out of the outgoing
# streamGenerateContent body. No quota is spent — the recorder answers itself.
#
#   ./tool-declarations.sh <path-to-pinned-antigravity> [port]
#
# Result of the 2026-09-14 run on 1.1.27: tool-declarations.json.

set -u
AGY="${1:?path to the pinned antigravity binary}"
PORT="${2:-8801}"
WORK="$(mktemp -d)"
REPO="$WORK/repo"
mkdir -p "$REPO"
echo '{"name":"probe"}' >"$REPO/package.json"

node "$(dirname "$0")/recorder.js" "$PORT" 2>"$WORK/recorder.log" &
REC=$!
trap 'kill $REC 2>/dev/null' EXIT
sleep 1

run() { # <label> <extra-home-setup>
  local label="$1" home="$WORK/home-$1"
  mkdir -p "$home/.gemini/antigravity-cli" "$home/.gemini/config"
  echo '{"modelProvider":"gemini"}' >"$home/.gemini/antigravity-cli/settings.json"
  [ "$label" = mcp ] && cat >"$home/.gemini/config/mcp_config.json" <<EOF
{"mcpServers":{"probe":{"command":"node","args":["$(dirname "$0")/mcp-server.js"]}}}
EOF
  (cd "$REPO" && HOME="$home" AGY_CLI_DISABLE_AUTO_UPDATE=true \
    GEMINI_API_KEY=not-a-real-key GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:$PORT" \
    "$AGY" --print= --input-format stream-json --output-format stream-json \
      --dangerously-skip-permissions --print-timeout 1m \
      --model gemini-3.1-pro --effort high --add-dir "$REPO" \
    < <(printf '{"event":"user","message":{"content":"ping"}}\n') >/dev/null 2>&1)
}

run plain
run mcp

python3 - <<'PY'
import glob, json, os
for f in sorted(glob.glob("/tmp/agy-body-*.json"), key=os.path.getmtime):
    b = json.load(open(f))
    names = sorted(fd["name"] for t in (b.get("tools") or []) for fd in t.get("functionDeclarations", []))
    print(os.path.basename(f), len(names), names or "(no tools — the title-generator side call)")
PY
