#!/usr/bin/env bash
# Run ONE task's two arms. Sub-agent spawns are capped at 3 per turn, so the
# 12-run experiment has to be spread across turns: call this with one slug.
#   ./pair.sh t2
set -uo pipefail
RW=/persist/rw/ripwire-0.4.0-linux-x64/ripwire
OUT=/persist/bench/runs
ROLE=Sonnet
slug="$1"
T="$(cat "$OUT/${slug}.task")"

arm() {
  local a="$1"
  local f="$OUT/${slug}.${a}.json"
  if [ -s "$f" ] && grep -q '"status"' "$f"; then echo "skip ${slug}.${a}"; return; fi
  {
    cat <<EOF
Locate the code in /workspace/src/server that implements this: "$T"

Report each relevant symbol as \`path:line\` with a one-line note on what it does.

Rules:
- READ ONLY. Do not create, edit, delete or move any file. Do not run git commands that change state. Do not open a PR.
- Stop as soon as you can name the relevant symbols. Do not fix anything, do not write tests, do not explore beyond the task.
EOF
    [ "$a" = ripwire ] && cat <<EOF

A tool called ripwire is installed at $RW. It prints a ranked map of the symbols
relevant to a task. Run this FIRST, before any grep or file read:

    $RW /workspace/src/server --for="$T"

Prefer its answer to grepping. Read a file body only if the map is not enough.
EOF
  } | timeout 700 shipit agent run --role "$ROLE" --json --prompt-file - \
        > "$f" 2>"$OUT/${slug}.${a}.err"
  local rc=$?
  if [ -s "$OUT/${slug}.${a}.err" ]; then
    echo "FAIL ${slug}.${a}: $(head -1 "$OUT/${slug}.${a}.err")"
  else
    echo "ok   ${slug}.${a} rc=$rc"
  fi
}

arm baseline
arm ripwire
