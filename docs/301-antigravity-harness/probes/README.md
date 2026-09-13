# Probe evidence — Antigravity CLI

Raw captures behind the claims in [../plan.md](../plan.md). None carries a
credential: the recorder replaces every key/auth/token header with its length.

## Captured on 1.2.2 (2026-09-13, key mode, free-tier key)

- `flash-test.ndjson` — a plain turn; its `init.tools` is the 57-name list.
- `global-mcp.ndjson` — an MCP call through `call_mcp_tool` from the global
  `~/.gemini/config/mcp_config.json`.
- `plugin-rules/-mcp/-skill.ndjson`, `probe-run.txt` — an INSTALLED plugin
  delivering rules, MCP servers and skills. `plugin-mcp.ndjson` is also the
  "recovered 503 reports status ERROR beside a complete answer" fixture.
- `compact-a/b/c.ndjson`, `compact-transcript_full.jsonl`, `compact-run.txt` —
  `/compact` on a resumed conversation. `compact-c.ndjson` is the "resumed turn
  repeats the PREVIOUS turn's error" fixture.
- `skills.ndjson`, `skills-cli-log.txt`, `skills-transcript_full.jsonl` — the
  docs/209 disclosure probe: no workspace instructions or skills are read.
- `slash-skill.ndjson`, `slash-skill-transcript_full.jsonl` — `/<skill-name>`
  invocation of an installed plugin skill.
- `probe.sh`, `skills-probe.sh`, `slash-probe.sh`, `mcp-server.js` — the drivers.

## Captured on 1.1.27, the PINNED version (2026-09-13)

Run against `recorder.js`, a local HTTP recorder pointed at by
`GOOGLE_GEMINI_BASE_URL`. Redirecting the endpoint is what makes these cheap and
repeatable: the request itself is the measurement, so no quota is spent and the
assertion is about what reaches the wire rather than what the model happened to
answer.

- `endpoint-redirect.ndjson` — every request the CLI made while redirected.
  Proves `GOOGLE_GEMINI_BASE_URL` works, that the path is
  `/v1beta/models/<id>:streamGenerateContent?alt=sse`, that the key rides
  `x-goog-api-key`, and which model id each `--model`/`--effort` pair resolves
  to. It also shows the CLI's own conversation-title side call, on
  `gemini-3.1-flash-lite-preview` — a second model per run that ShipIt never
  selected.
- `refusal-no-effort.ndjson` + `.stderr.txt` — a terminal refusal: exit 1, a
  `result` envelope with `status: ERROR` and an empty `response`, and the
  sentence on stderr as an `error:` line. The fixture for the outcome rule.
- `compact-1127.ndjson` — `/compact` still reaches the model as plain user text
  on the pinned version: no summary step, and the resumed turn's
  `system_message` notice.
