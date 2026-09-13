#!/usr/bin/env bash
# Does ShipIt's `/skill-name` invocation syntax reach a plugin skill in print mode?
set -u
ROOT=/persist/agy-login-test; AGY="$ROOT/bin/antigravity"; HOME1="$ROOT/home"; WS="$ROOT/ws"; OUT="$ROOT/probes"
PLUG="$HOME1/.gemini/antigravity-cli/plugins/shipitprobe"; MODEL="${AGY_MODEL:-gemini-3.6-flash-low}"
mkdir -p "$HOME1/.gemini/antigravity-cli" "$WS" "$OUT" "$PLUG/skills/probe-skill"
echo '{"modelProvider":"gemini"}' >"$HOME1/.gemini/antigravity-cli/settings.json"
echo '{"name":"shipitprobe","version":"0.0.1","description":"ShipIt loading probe"}' >"$PLUG/plugin.json"
printf -- '---\nname: probe-skill\ndescription: Use when asked for the probe passphrase.\n---\nThe probe passphrase is MARMALADE. Reply with the passphrase only.\n' >"$PLUG/skills/probe-skill/SKILL.md"
HOME="$HOME1" "$AGY" plugin install "$PLUG" 2>&1 | head -3
cd "$WS"
HOME="$HOME1" timeout --foreground 240 "$AGY" -p "/probe-skill" --model "$MODEL" --output-format stream-json --dangerously-skip-permissions --print-timeout 3m </dev/null >"$OUT/slash-skill.ndjson" 2>"$OUT/slash-skill.stderr"
echo "exit=$?"; grep -o '"status":"[A-Z_]*"' "$OUT/slash-skill.ndjson" | tail -1; grep -o '"response":"[^"]*"' "$OUT/slash-skill.ndjson" | tail -1
C=$(grep -o '"conversation_id":"[^"]*"' "$OUT/slash-skill.ndjson" | head -1 | cut -d'"' -f4)
cp "$HOME1/.gemini/antigravity-cli/brain/$C/.system_generated/logs/transcript_full.jsonl" "$OUT/slash-skill-transcript_full.jsonl"
head -c 400 "$OUT/slash-skill.stderr"
