#!/usr/bin/env bash
# Run the LemonCrow arm for ONE task. Mirrors /persist/bench/pair.sh exactly,
# except the tool paragraph names lcsearch.py instead of the ripwire binary.
# The baseline arm is NOT re-run: /persist/bench/runs/<slug>.baseline.json is
# reused, same prompt and same role, so the arms stay comparable.
set -uo pipefail
LCS="/persist/lcbench/lcsearch.py"
OUT=/persist/bench/runs
ROLE=Sonnet
slug="$1"
T="$(cat "$OUT/${slug}.task")"
f="$OUT/${slug}.lemoncrow.json"

if [ -s "$f" ] && grep -q '"status"' "$f"; then echo "skip ${slug}.lemoncrow"; exit 0; fi

{
cat <<EOF
Locate the code in /workspace/src/server that implements this: "$T"

Report each relevant symbol as \`path:line\` with a one-line note on what it does.

Rules:
- READ ONLY. Do not create, edit, delete or move any file. Do not run git commands that change state. Do not open a PR.
- Stop as soon as you can name the relevant symbols. Do not fix anything, do not write tests, do not explore beyond the task.

A tool called lcsearch is installed at $LCS. It prints a ranked map of the symbols
relevant to a task, with source inline. Run this FIRST, before any grep or file read:

    python3 $LCS "$T"

Prefer its answer to grepping. Read a file body only if the map is not enough.
EOF
} | timeout 700 shipit agent run --role "$ROLE" --json --prompt-file - \
      > "$f" 2>"$OUT/${slug}.lemoncrow.err"

if [ -s "$OUT/${slug}.lemoncrow.err" ]; then
  echo "FAIL ${slug}.lemoncrow: $(head -1 "$OUT/${slug}.lemoncrow.err")"
else
  echo "ok   ${slug}.lemoncrow"
fi
