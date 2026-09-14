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

⚠️ **These were re-run after a first attempt measured the wrong version.** The
binary was first extracted into a *writable* directory, so the CLI's own
auto-updater replaced it with 1.2.2 partway through — the very mechanism the
integration exists to suppress, quietly invalidating the evidence for it. The
captures here come from a binary extracted into a directory sealed with
`chmod -R a-w` first, which stayed at 1.1.27 across every run.

- `endpoint-redirect.ndjson` — every request the CLI made while redirected.
  Proves `GOOGLE_GEMINI_BASE_URL` works, that the path is
  `/v1beta/models/<id>:streamGenerateContent?alt=sse`, that the key rides
  `x-goog-api-key`, and which model id each `--model`/`--effort` pair resolves
  to. It also shows the CLI's own conversation-title side call, on
  `gemini-3.1-flash-lite-preview` — a second model per run that ShipIt never
  selected.
- `refusal-no-effort.ndjson` — a terminal refusal under `--output-format
  stream-json`: exit 1, a `result` envelope with `status: ERROR` and an empty
  `response`, and **nothing at all on stderr**. The fixture for the outcome rule,
  and the reason the adapter falls back to `result.error` for text on a turn it
  has already ruled failed.
- `refusal-text-format.stderr.txt` — the same refusal under `--output-format
  text`, the sign-in run's format. Here the text IS on stderr, prefixed
  `Error:` — capitalised, where 1.2.2 wrote `error:`. The reader matches either.
- `compact-1127.ndjson` — `/compact` still reaches the model as plain user text
  on the pinned version: no summary step, and the resumed turn's
  `system_message` notice.
- `plugin-on-the-wire.json` — the part of the recorder's request BODIES that
  carries the claim, for the two turns that had the plugin installed: the rule
  inside the CLI's own `<RULE[path]>` block, the symlinked skill's name and
  description in the tool preamble, and the global MCP server's tool. Excerpts
  rather than whole bodies, because a body is ~46 KB of the CLI's own system
  prompt; the marker strings are the probe's, so an excerpt around each one is
  the assertion. `endpoint-redirect.ndjson` records the same requests' URLs,
  headers and sizes — it is the *routing* evidence and does not, on its own,
  substantiate what the bodies contained.
- `updater-sealed.txt` / `updater-writable-control.txt` — the updater's own log
  lines for the two cases: it skips a non-writable install directory, and
  spawns a background update process for a writable one. The control is what
  shows the seal is doing the work.

## Tools-off: the measurement that found nothing (1.1.27, 2026-09-13)

`tools-off-1127.json`, `tools-off-1127-cli-log.txt`, `tools-off-probe.sh` — the
search for a mechanism that empties this CLI's tool set, the way every other
harness's entry in `src/server/shared/agent-tools-off.ts` was established.
**It found none**, which is why that file refuses a tools-off run here.

The negative control ran first and on purpose: a run with no flags sends **11**
tool definitions, so a later zero would have been a real zero rather than a
recorder that never captured a `tools` field. Five further configurations —
`--mode plan`, `--sandbox`, `--agent`, an `--agent` with an absolute `geminiDir`,
and a `permissions.deny: ["*"]` settings file with `--dangerously-skip-permissions`
removed — each sent the same 11.

Three things the captures settle that reading the CLI would not:

- **There is no `--tools` family flag.** 1.1.27's `--help` offers no `--tools`,
  `--allowed-tools` or `--disallowed-tools`.
- **The permission layer is an approval gate, not a tool-set switch** — the same
  trap as Claude's `--allowedTools ""`. The log line in
  `tools-off-1127-cli-log.txt` shows `permissions=&{Allow:[] Deny:[*] Ask:[]}`
  loaded and applied, and the body still carried all 11.
- **An unresolved `--agent` name fails open**, like an unknown name in grok's
  allowlist: the CLI logs `Agent "notools" not found, falling back to default`
  and runs with the full set rather than refusing.

`enabledTools` / `disabledTools` do exist in the binary, but on the MCP server
struct in `mcp_config.json` — they gate MCP servers, and the control already
sends 11 with no MCP server configured at all, so they cannot reduce it.
`enable_write_tools` / `enable_mcp_tools` / `enable_subagent_tools` belong to the
`define_subagent` schema, for subagents the agent spawns at runtime, and the
binary's own text puts a floor under even those: "all subagents have read tools
to research the codebase, and tools to communicate with other agents".

## 2026-09-14 — the billable-key runs (1.1.27, `gemini-3.1-pro`, effort `high`)

Every capture above was made on a free-tier key, which has **zero** quota on Pro
and 5 requests/minute on flash. On 2026-09-14 the key became billable
(`serviceTier: "standard"` on `gemini-3.1-pro-preview`), so the four items that
were blocked on a credential were measured. `review-probe.sh` is the runner — it
reproduces ShipIt's exact spawn argv and takes the prompt on stdin as a
`stream-json` user frame, the way the adapter does.

Each capture has a `.meta` beside it recording the CLI version, model, exit code,
wall time and stderr size. Those are process-local facts the stream cannot carry,
and they are exactly what the adapter's outcome rule turns on — a capture without
them cannot show whether its turn succeeded.

- **`review.ndjson` — `supportsReview`, item 15, settled `true`.** The docs/266
  depth-0 probe, run inside a real ShipIt session container so `shipit agent run`
  is genuinely brokered and the caller-depth guard sees depth 0. The prompt is
  `review-message.txt`, the verbatim output of
  `composeReviewMessage("rate-limit.ts", { mode: "role" })`. The CLI composed the
  heredoc itself, ran `shipit agent run --role reviewer --prompt-file -` (twice —
  the first attempt gave a relative path the reviewer could not resolve), polled
  the backgrounded command with `manage_task {Action: "status"}`, read the
  reviewer's markdown off stdout, and then applied the fixes. One turn, 419 s,
  exit 0, no MCP tool. That is the whole composed flow, including
  `parentFollowUp()`.

- **`tour-no-add-dir.ndjson` vs `tour2.ndjson` — the workspace-root defect.**
  The same docs/272 tour prompt (`tour-prompt.txt`), spawned the same way, the
  only difference being `--add-dir`. Without it every file tool addressed
  `$HOME`: `view_file` on the repo's `package.json` ended `ERROR` because the CLI
  looked under the home, `grep_search` and `find_by_name` took the home as their
  search root, and `probe-note.md` was written into the home. With it, all of
  them address the repository. `pwd-probe.ndjson` and `adddir.ndjson` are the
  minimal pair behind that: `run_command`'s own `pwd` prints `$HOME` without
  `--add-dir` and the repository with it. `init.cwd` echoes the spawn cwd in
  **all four**, so nothing in the stream distinguishes the two states — only the
  tool arguments do.

- **`partial-fail.ndjson` — a failure AFTER partial output**, the fixture
  docs/301's checklist listed as never observed. Forced with `--print-timeout
  45s` against a turn told to `sleep 400`. The capture holds a complete
  `agent_response` step (two real paragraphs), then an `ACTIVE` `run_command`
  with no terminal event, then `result` with `status: "ERROR"` and
  `error: "timeout waiting for response"`; the process exits **1** and stderr is
  **empty**. It confirms the adapter's outcome rule from the other side: text
  never implies success, and under `--output-format stream-json` there is nothing
  on stderr to read.

- **`state: "ERROR"` is a real terminal tool state.** It appears in two of the
  runs above, on two different tools and with two different messages — a
  `run_command` whose arguments the CLI rejects
  (`invalid arguments: at '/WaitMsBeforeAsync': got string, want integer`,
  `review.ndjson`) and a `view_file` the permission layer refuses to convert
  (`tour-no-add-dir.ndjson`) — so it is not one tool's quirk. Such a step ends at
  `ERROR` with `tool_info.error` and never at `DONE`. None of the 1.2.2 captures
  contained a failed tool, which is why the stream types declared only
  `ACTIVE | DONE`.

- **`longcmd.ndjson` — the shell tool's timeout behaviour**, which item 15 says
  to check rather than assume. A `run_command` told to run for 250 s is
  **backgrounded**, not killed: `manage_task {Action: "list"}` reports it as a
  running background task, `{Action: "status"}` reads its log while it runs, and
  the step still ends `DONE` carrying the command's real stdout
  (`LONGCMD-NONCE-7731-COMPLETE`). Turn total 272 s, exit 0. This is the
  property a review depends on — a real review turn took 240 s on the harnesses
  probed for docs/266 — and it is measured here rather than inferred from
  `--print-timeout`.

- **`resume-add-dir-a.ndjson` / `resume-add-dir-b.ndjson` — `--add-dir` on a
  resumed turn.** The flag is passed on every spawn, including the
  `--conversation <id>` resumes, so the pair checks that a resumed conversation
  does not carry a stale workspace of its own: `pwd` returns the repository on
  the first turn and on the resume, and `ls -1` on the resume lists the
  repository's files.
