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
# Each spawn gets its OWN body directory, so a body is always attributable to
# the configuration that produced it, and leftovers from an earlier run cannot
# be read back as this one's. Result of the 2026-09-14 run: tool-declarations.json.
#
# KEY MODE ONLY. An account-mode spawn talks to cloudcode-pa.googleapis.com,
# which this override does not redirect, so nothing here measures it.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"   # absolute, before any cd
AGY="${1:?path to the pinned antigravity binary}"
PORT="${2:-8801}"
WORK="$(mktemp -d)"
REPO="$WORK/repo"
mkdir -p "$REPO"
echo '{"name":"probe"}' >"$REPO/package.json"

# <label> <model> <effort> <mcp:yes|no> [conversation-id] [home-label]
#
# One recorder per spawn, each writing to its own body directory: the recorder
# is what writes the bodies, so isolating them means isolating IT, not the CLI.
#
# `home-label` exists for the RESUME: the conversation store lives under HOME, so
# a resume from a fresh home silently starts a new conversation instead — which
# looks identical in the declarations and measures nothing.
run() {
  local label="$1" model="$2" effort="$3" mcp="$4" conv="${5:-}" homeLabel="${6:-$1}"
  local home="$WORK/home-$homeLabel"
  local bodies="$WORK/bodies-$label"
  AGY_BODY_DIR="$bodies" node "$HERE/recorder.js" "$PORT" 2>"$WORK/recorder-$label.log" &
  local rec=$!
  sleep 1
  mkdir -p "$home/.gemini/antigravity-cli" "$home/.gemini/config"
  echo '{"modelProvider":"gemini"}' >"$home/.gemini/antigravity-cli/settings.json"
  if [ "$mcp" = yes ]; then
    cat >"$home/.gemini/config/mcp_config.json" <<EOF
{"mcpServers":{"probe":{"command":"node","args":["$HERE/mcp-server.js"]}}}
EOF
  fi
  ( cd "$REPO" && HOME="$home" AGY_CLI_DISABLE_AUTO_UPDATE=true \
      GEMINI_API_KEY=not-a-real-key GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:$PORT" \
      "$AGY" --print= --input-format stream-json --output-format stream-json \
        --dangerously-skip-permissions --print-timeout 1m \
        --model "$model" --effort "$effort" --add-dir "$REPO" \
        ${conv:+--conversation "$conv"} \
      < <(printf '{"event":"user","message":{"content":"ping"}}\n') \
      >"$WORK/$label.ndjson" 2>"$WORK/$label.stderr" )
  local rc=$?
  kill "$rec" 2>/dev/null
  wait "$rec" 2>/dev/null
  # A refused spawn sends NOTHING, and an empty body directory reads exactly
  # like a configuration that declares no tools. Say which happened.
  echo "== $label: exit $rc, model=$model effort=$effort mcp=$mcp${conv:+ resumed}"
  grep -o '"error":"[^"]*"' "$WORK/$label.ndjson" | head -1
}

run plain          gemini-3.1-pro   high no
CONV=$(grep -o '"conversation_id":"[^"]*"' "$WORK/plain.ndjson" | head -1 | cut -d'"' -f4)
run resumed        gemini-3.1-pro   high no "$CONV" plain
run flash          gemini-3.8-flash high no
run mcp            gemini-3.1-pro   high yes

echo "-- resume check: plain=$CONV resumed=$(grep -o '"conversation_id":"[^"]*"' "$WORK/resumed.ndjson" | head -1 | cut -d'"' -f4)"

WORK="$WORK" python3 - <<'PY'
import glob, json, os
root = os.environ["WORK"]
for d in sorted(glob.glob(f"{root}/bodies-*")):
    label = os.path.basename(d).removeprefix("bodies-")
    bodies = sorted(glob.glob(f"{d}/agy-body-*.json"), key=os.path.getmtime)
    if not bodies:
        print(f"{label}: NO REQUEST REACHED THE RECORDER (a refusal, not an empty tool set)")
        continue
    for f in bodies:
        b = json.load(open(f))
        names = sorted(fd["name"] for t in (b.get("tools") or []) for fd in t.get("functionDeclarations", []))
        print(f"{label}/{os.path.basename(f)}: {len(names)} {names or '(no tools key — the title-generator side call)'}")
PY
