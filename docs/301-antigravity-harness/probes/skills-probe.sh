#!/usr/bin/env bash
# docs/209 skills-disclosure probe for the Antigravity CLI (docs/301 Phase 0 item 9).
# Which of AGENTS.md / CLAUDE.md and .claude/skills / .agents/skills / .gemini/skills
# does a headless turn read from the workspace? Same env as probe.sh (key mode).
set -u
ROOT=/persist/agy-login-test
AGY="$ROOT/bin/antigravity"
HOME1="$ROOT/home"
WS="$ROOT/ws-skills"
OUT="$ROOT/probes"
MODEL="${AGY_MODEL:-gemini-3.8-flash-low}"
rm -rf "$WS"; mkdir -p "$WS/.claude/skills/claude-probe-skill" "$WS/.agents/skills/agents-probe-skill" "$WS/.gemini/skills/gemini-probe-skill"
cd "$WS" || exit 1
git init -q .
echo "Project rule: the project codeword is KUMQUAT. Mention it when asked for codewords." >AGENTS.md
echo "Project rule: the secondary codeword is PAPAYA. Mention it when asked for codewords." >CLAUDE.md
for s in claude agents gemini; do
  cat >".$([ $s = claude ] && echo claude || ([ $s = agents ] && echo agents || echo gemini))/skills/$s-probe-skill/SKILL.md" <<EOF
---
name: $s-probe-skill
description: Probe skill discovered from the .$s directory.
---
This skill exists only to be listed.
EOF
done
git add -A >/dev/null; git -c user.email=p@p -c user.name=p commit -qm probe
HOME="$HOME1" timeout --foreground 240 "$AGY" -p "Without using any tools: 1) list every codeword you know from the project instructions; 2) list the names of every skill available to you, one per line. Nothing else." \
  --model "$MODEL" --output-format stream-json --dangerously-skip-permissions --print-timeout 3m \
  </dev/null >"$OUT/skills.ndjson" 2>"$OUT/skills.stderr"
echo "exit=$?"
grep -o '"status":"[A-Z_]*"' "$OUT/skills.ndjson" | tail -1
grep -o '"response":"[^"]*"' "$OUT/skills.ndjson" | tail -1
grep -o '"tool_info":{[^}]*}' "$OUT/skills.ndjson" | cut -c1-200 | sort -u
[ -s "$OUT/skills.stderr" ] && head -c 400 "$OUT/skills.stderr"
