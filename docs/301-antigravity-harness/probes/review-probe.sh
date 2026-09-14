#!/usr/bin/env bash
# docs/266 item 15 (`supportsReview`) — depth-0 probe for the Antigravity CLI.
#
# Runs the PINNED 1.1.27 binary with ShipIt's exact spawn argv, inside a real
# ShipIt session container (so `shipit agent run --role reviewer` is genuinely
# brokered and the caller-depth guard sees depth 0), and feeds it the verbatim
# output of composeReviewMessage(path, { mode: "role" }).
#
#   ./run-review-probe.sh <label> <prompt-file>
#
# Outputs: <label>.ndjson, <label>.stderr, <label>.meta

set -u
ROOT=/persist/agy-review-probe
AGY=/persist/agy-login-test/pinned/antigravity
LABEL="${1:?label}"
PROMPT_FILE="${2:?prompt file}"
MODEL="${AGY_MODEL:-gemini-3.1-pro}"
EFFORT="${AGY_EFFORT:-high}"

HOME1="$ROOT/home-$LABEL"
rm -rf "$HOME1"
mkdir -p "$HOME1/.gemini/antigravity-cli"
# Key mode: the adapter derives this from the home's own token presence.
echo '{"modelProvider":"gemini"}' >"$HOME1/.gemini/antigravity-cli/settings.json"

cd "${AGY_CWD:-$ROOT/repo}" || exit 1
start=$(date +%s)
HOME="$HOME1" \
AGY_CLI_DISABLE_AUTO_UPDATE=true \
GEMINI_API_KEY="$GEMINI_API_KEY" \
  "$AGY" \
    "--print=" \
    --input-format stream-json \
    --output-format stream-json \
    --dangerously-skip-permissions \
    --print-timeout "${AGY_PRINT_TIMEOUT:-180m}" \
    --model "$MODEL" \
    --effort "$EFFORT" \
    ${AGY_ADD_DIR:+--add-dir "$AGY_ADD_DIR"} \
  < <(python3 -c '
import json,sys
print(json.dumps({"event":"user","message":{"content":open(sys.argv[1]).read()}}))
' "$PROMPT_FILE") \
  >"$ROOT/$LABEL.ndjson" 2>"$ROOT/$LABEL.stderr"
rc=$?
end=$(date +%s)

{
  echo "label:        $LABEL"
  echo "cli_version:  $("$AGY" --version 2>&1 | head -1)"
  echo "model:        $MODEL  effort: $EFFORT"
  echo "prompt_file:  $PROMPT_FILE"
  echo "exit_code:    $rc"
  echo "wall_seconds: $((end - start))"
  echo "stderr_bytes: $(wc -c <"$ROOT/$LABEL.stderr")"
  echo "date_utc:     $(date -u +%FT%TZ)"
} >"$ROOT/$LABEL.meta"
cat "$ROOT/$LABEL.meta"
