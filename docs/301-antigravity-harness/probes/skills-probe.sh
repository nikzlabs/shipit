#!/usr/bin/env bash
# docs/209 instructions + skills disclosure probe for the Antigravity CLI
# (docs/301 Phase 0 items 7 and 9). NO plugin installed: which of GEMINI.md /
# AGENTS.md / CLAUDE.md and .claude/skills / .agents/skills / .gemini/skills does
# a headless turn read from the workspace natively? Same env as probe.sh (key mode).
set -u
ROOT=/persist/agy-login-test
AGY="$ROOT/bin/antigravity"
HOME1="$ROOT/home"
WS="$ROOT/ws-skills"
OUT="$ROOT/probes"
MODEL="${AGY_MODEL:-gemini-3.6-flash-low}"
mkdir -p "$OUT" "$HOME1/.gemini/antigravity-cli"
[ -n "${GEMINI_API_KEY:-}" ] && echo '{"modelProvider":"gemini"}' >"$HOME1/.gemini/antigravity-cli/settings.json"
rm -rf "$WS"; mkdir -p "$WS/.claude/skills/claude-probe-skill" "$WS/.agents/skills/agents-probe-skill" "$WS/.gemini/skills/gemini-probe-skill"
cd "$WS" || exit 1
git init -q .
echo "Project rule: the project codeword is KUMQUAT. Mention it when asked for codewords." >AGENTS.md
echo "Project rule: the secondary codeword is PAPAYA. Mention it when asked for codewords." >CLAUDE.md
echo "Project rule: the tertiary codeword is QUINCE. Mention it when asked for codewords." >GEMINI.md
for s in claude agents gemini; do
  cat >".$s/skills/$s-probe-skill/SKILL.md" <<EOF
---
name: $s-probe-skill
description: Probe skill discovered from the .$s directory.
---
This skill exists only to be listed.
EOF
done
git add -A >/dev/null; git -c user.email=p@p -c user.name=p commit -qm probe
before=$(date -u +%H:%M:%S)
HOME="$HOME1" timeout --foreground 240 "$AGY" -p "Without using any tools: 1) list every codeword you know from the project instructions; 2) list the names of every skill available to you, one per line. Nothing else." \
  --model "$MODEL" --output-format stream-json --dangerously-skip-permissions --print-timeout 3m \
  </dev/null >"$OUT/skills.ndjson" 2>"$OUT/skills.stderr"
echo "exit=$?"
grep -o '"status":"[A-Z_]*"' "$OUT/skills.ndjson" | tail -1
grep -o '"response":"[^"]*"' "$OUT/skills.ndjson" | tail -1
[ -s "$OUT/skills.stderr" ] && head -c 400 "$OUT/skills.stderr"
# Evidence the reviewer asked for: the CLI's own log lines about rules/skills for this run.
{ echo "# CLI log lines (run started $before UTC), model $MODEL, no plugin installed"; grep -h "user_rules\|rules\|skill\|GEMINI.md\|AGENTS.md\|CLAUDE.md" "$HOME1"/.gemini/antigravity-cli/log/*.log 2>/dev/null | grep -v "Migration\|builtin" | cut -c1-240; } >"$OUT/skills-cli-log.txt"
C=$(grep -o '"conversation_id":"[^"]*"' "$OUT/skills.ndjson" | head -1 | cut -d'"' -f4)
cp "$HOME1/.gemini/antigravity-cli/brain/$C/.system_generated/logs/transcript_full.jsonl" "$OUT/skills-transcript_full.jsonl" 2>/dev/null
grep -c -i "kumquat\|papaya\|quince" "$OUT/skills-transcript_full.jsonl"
