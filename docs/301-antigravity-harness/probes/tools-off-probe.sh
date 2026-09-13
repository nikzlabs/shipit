#!/usr/bin/env bash
# Driver behind tools-off-1127.json: does any Antigravity 1.1.27 mechanism empty
# the CLI's tool set? The request body is the measurement — `--help` and the
# CLI's own claims about a flag decide nothing.
#
# Run the negative control FIRST. A measurement that has only ever seen zero
# cannot tell "the flag worked" from "the recorder never captured a tools field".
#
# Setup, once: download the pinned release, verify the sha256 in
# docker/agent-cli/install-agent-clis.sh, extract, then `chmod -R a-w` the
# install directory BEFORE its first run. The updater rewrites the evidence
# otherwise; AGY_CLI_DISABLE_AUTO_UPDATE must be the string `true`, not `1`.
set -u
ROOT="${ROOT:-/persist/agy-toolsoff}"
LABEL="$1"; shift

rm -f "$ROOT/bodies"/*.json
mkdir -p "$ROOT/out/$LABEL"

export AGY_CLI_DISABLE_AUTO_UPDATE=true
export HOME="$ROOT/home"
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8799   # recorder.js
export GEMINI_API_KEY=recorder-stand-in-key-not-a-real-credential

cd "$ROOT/ws" || exit 1
printf '%s\n' '{"event":"user","message":{"content":"Reply with the single word pong."}}' \
  | timeout --foreground 180 "$ROOT/bin/antigravity" \
      "--print=" --input-format stream-json --output-format stream-json \
      --dangerously-skip-permissions --print-timeout 3m "$@" \
      >"$ROOT/out/$LABEL/stream.ndjson" 2>"$ROOT/out/$LABEL/stderr.txt"

mkdir -p "$ROOT/out/$LABEL/bodies"
cp "$ROOT/bodies"/*.json "$ROOT/out/$LABEL/bodies/" 2>/dev/null

# Two requests per run: the turn itself, and the CLI's own conversation-title
# side call, which carries no `tools` key at all. Count the turn's.
for f in "$ROOT/out/$LABEL/bodies"/*.json; do
  node -e '
    const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const names = (b.tools || []).flatMap((t) => (t.functionDeclarations || []).map((d) => d.name));
    console.log(process.argv[1], "| toolDefinitions:", names.length, "|", names.join(", "));
  ' "$f"
done

# The permission runs also drop --dangerously-skip-permissions, and read back
# `CLI settings initialized: permissions=...` from --log-file to prove the
# setting was applied rather than silently ignored.
