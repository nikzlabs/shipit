---
issue: planning#543
title: Antigravity CLI harness — design
description: Google's Antigravity CLI (binary `antigravity`, release 1.2.x) as the fifth harness — Claude-shaped spawn-per-turn adapter with a per-spawn plugin for prompt, MCP and skills, per the docs/266 recipe.
---

# Antigravity CLI harness — design

Implements [requirements.md](./requirements.md) by following
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md)
(req 6). This doc holds only what is Antigravity-specific: the Phase 0
findings, the catalogue row, the install path, the credential and sign-in
design, and the adapter. The step-by-step is [checklist.md](./checklist.md).
Desk research and the first probes are in
[docs/266 candidates.md §Antigravity](../266-harness-integration-recipe/candidates.md);
the catalogue vendor row landed in
[docs/302-gemini-catalogue-vendor](../302-gemini-catalogue-vendor/plan.md)
(req 7).

## Phase 0 findings (CLI 1.2.2, 2026-09-13, in a session container)

All probes ran headless in key mode (`GEMINI_API_KEY`, a free-tier key) on
`gemini-3.8-flash-low` / `gemini-3.7-flash-low`. Raw captures, the probe
scripts and the run log are vendored under [probes/](./probes/) — they carry
no credential. Each finding cites its capture.

- **Stream shape** (`flash-test.ndjson`, `global-mcp.ndjson`): `init`
  (`conversation_id`, `init.{model, cwd, tools[57], permission_mode}`;
  `permission_mode` reads `always-proceed` under
  `--dangerously-skip-permissions`), `step_update` (`step_index`, `state`
  ACTIVE|DONE, `step_type` user_input | agent_response | system_message |
  error_message | tool, `text_delta`, `tool_name` + `tool_info.{name,
  parameters, output}`, per-step `usage`, `duration_seconds`), terminal
  `result` (`status`, `response`, `error`, `num_turns`, `usage`). Errors also
  print on stderr as an `error:` line; exit 1.
- **`result.status` / `result.error` describe the conversation, not the
  turn.** `plugin-mcp.ndjson`: a 503 hit one request mid-turn, the CLI
  retried, the tool call and the final text completed (`response`
  present), and the result still reads `status: "ERROR"` with `error` set,
  exit 0. Worse, `compact-c.ndjson` (a resumed turn with **no** error step
  of its own and a correct answer) carries the *previous* turn's 503 in
  `result.error`. So the adapter derives the turn's outcome from the
  current stream only: an `error_message` step in this stream with no
  `agent_response` text ⇒ error turn, text from the stream's `error_message`
  step or stderr; text present ⇒ success, with any error step of this
  stream narrated; `result.error` on its own is never a signal. Both
  captures are fixtures (success after an earlier turn's error is the
  regression case).
- **Token accounting, verified on every captured step and result**
  (`plugin-mcp.ndjson`, `compact-b.ndjson`): `total_tokens = input_tokens +
  output_tokens` always; `thinking_tokens` ⊂ `output_tokens`; and
  **`cache_read_tokens` is outside `input_tokens`** — the step that read
  8,174 cached tokens reports `input_tokens: 2561, total: 2805`, so `input`
  is the uncached prompt and context occupancy is `input + cache_read`.
  **A resumed run's `result.usage` is cumulative across the whole
  conversation**, not the turn: `compact-b` (`num_turns: 2`) reports
  `input_tokens: 12999` while its only new step used 2,567 uncached plus
  8,099 cached tokens — a context of 10,666 for that call. So the adapter
  sums the turn's `step_update.usage` for the turn total and takes the last
  step's `input + cache_read` as context occupancy; it never maps
  `result.usage` straight through. Cache reads price at the catalogue's
  `cacheRead` rate; no dollar figure is on the wire. These two captures are
  the fixtures for that arithmetic.
- **MCP** (`global-mcp.ndjson`, resolves the open question): servers from
  `~/.gemini/config/mcp_config.json` (`mcpServers`, stdio) are listed by
  `antigravity mcp list` and called through `call_mcp_tool` with
  `tool_info.parameters.{ServerName, ToolName, Arguments}` and
  `tool_info.output` on DONE. The CLI writes each server's tool schemas to
  `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`, and the model reads
  that file with `view_file` before its first call — an extra read step
  before every first MCP use, to be expected in transcripts. Plugin-supplied
  servers are namespaced `<plugin>_<server>`.
- **Plugins load rules, MCP and skills — after an install step**
  (`plugin-rules`, `plugin-mcp`, `plugin-skill`, `probe-run.txt`). A plugin
  directory dropped under `~/.gemini/antigravity-cli/plugins/<name>/` is
  ignored and its data directory deleted ("uninstalled plugin"). After
  `antigravity plugin install <path>` the CLI copies the plugin to
  `~/.gemini/config/plugins/<name>/` (`plugin.json`, `rules/AGENTS.md`,
  `mcp_config.json`, `skills/`) and records it in
  `~/.gemini/config/import_manifest.json`; from then on every headless turn
  honoured the rule (`ZEBRA-PLUGIN` prefix), called the plugin's MCP server
  and listed and used the plugin skill (`MARMALADE`). Two built-in skills
  (`agy-customizations`, `antigravity-guide`) are always disclosed.
- **Workspace instructions and skills are NOT read in a headless turn**
  (`skills.ndjson`, `skills-cli-log.txt`, `skills-transcript_full.jsonl`;
  the docs/209 probe, run with **no plugin installed**, status `SUCCESS`):
  a fresh git repo carrying `GEMINI.md`, `AGENTS.md` and `CLAUDE.md` (three
  distinct codewords) plus `.claude/skills/`, `.agents/skills/` and
  `.gemini/skills/` got the answer "1) None" and only the two built-in
  skills; the CLI log for that run resolves the `user_rules` prompt section
  as `empty component`, and the CLI's own transcript never contains a
  codeword. The vendor documentation says rules load from
  `GEMINI.md`/`AGENTS.md` walking up from cwd; 1.2.2 print mode did not, in
  two runs on two models. The positive control is the plugin run above,
  where a rule of the same shape was honoured. So for instructions and
  skills the plugin is the only proven path; MCP needs no plugin (the global
  `config/mcp_config.json` worked on its own, `global-mcp.ndjson`).
- **`/compact` is not compaction** (`compact-a/b/c.ndjson`,
  `compact-transcript_full.jsonl`, `compact-run.txt`; item 14 probe, run on
  `gemini-3.7-flash-low`, and once before on 3.8 with the same outcome):
  sent as the prompt of a resumed conversation it reached the model as
  `<USER_REQUEST>/compact</USER_REQUEST>` (step 2 of the CLI's own
  transcript, vendored), no summary step ran, every earlier step is still in
  the transcript, the next turn's input tokens did not fall, and the model
  answered conversationally ("I have noted the compaction request…").
  Recall on the following turn worked. The binary compiles no `/compact`
  (its slash commands are `/status`, `/goal`, `/model`, …; `strings` sweep,
  not vendored) and carries only an automatic `context_summary`
  pre-invocation hook. `supportsCompaction: false`, probed.
- **Resume works and injects a notice** (`compact-b`, `compact-c`):
  `--conversation <id>` continued the conversation and recalled the codeword
  (`TANGERINE`). Every resumed print turn first emits a `system_message`
  step whose content is Google's own "[Notice] All your subagents and
  background tasks have been stopped due to server restart" — one per
  spawn-per-turn resume. The adapter drops that step from the transcript.
- **Free-tier keys are unusable for real sessions.** Google answers 429
  `RESOURCE_EXHAUSTED` with `limit: 0` for `gemini-3.1-pro` and 5/min +
  20/day per flash model. The text is Google's own and lands in
  `result.error` + stderr; it must reach the user (see "Errors reach the
  user verbatim").
- **Model ids on the CLI carry the effort as a suffix**: `antigravity
  models` lists `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-*`,
  `gemini-3.6-flash-*`, `gemini-3.1-pro-{high,low}`; `--effort
  low|medium|high` also exists ("--effort is not supported for the current
  model" is compiled in). The catalogue ids are `gemini-3.8-flash` and
  `gemini-3.1-pro-preview` (docs/302).
- **No login subcommand.** The top-level commands are `help`, `mcp`,
  `models`, `plugin`, `update`. Sign-in happens inside a print run: URL on
  stderr, code read from stdin within 60 s, token file written
  (candidates.md, probed once with a real account).

## Catalogue row (recipe step 2, req 1)

The row is what makes the harness selectable wherever a harness can be
selected (req 1): pickers, roles and `SHIPIT_HARNESSES` all derive from
`HARNESSES`.

- `id: "antigravity"`, `name: "Antigravity"`, `binary: "antigravity"`,
  `nativeService: "google"`, `styles: ["gemini-generate-content"]` — the
  docs/302 row joins the moment this lands; its "vendor no harness speaks
  yet" guard becomes this harness's join assertions.
- `spawn.credential`: `string: { kind: "env", name: "GEMINI_API_KEY" }`
  (plus `{"modelProvider":"gemini"}` written into the spawn home's
  `settings.json` by the adapter — the key alone is not enough, probed) and
  `account: { kind: "scoped-home" }` (req 2; the token is a plain file).
  `spawn.model: { kind: "flag", flag: "--model" }`; `spawn.endpoint`: env
  `GOOGLE_GEMINI_BASE_URL` (vendor-documented, **unprobed** — verify with the
  recorder at implementation before the endpoint override is declared).
- The `google` `ServiceDef` gains a `sub` mode (the free-preview account)
  with `login: "google-antigravity-oauth"`, `carriers: ["antigravity"]`, and
  the account-mode models observed in candidates.md (the Gemini pair plus
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`).
  **Quota is a gap**: a `sub` mode requires a `QuotaIntegrationId`
  (`types.ts`), and no usage reader is known for the Antigravity account.
  Search the binary and the account-mode host for a usage route with a
  signed-in token before deciding; if none exists, the docs/274 "no-reader
  subscription gets no meters" rule applies and the `quota: null` arm that
  docs/274 removed comes back for this one mode.
- **Model delivery must translate ids.** The CLI wants `<catalogue-id>-<effort>`
  (and `gemini-3.1-pro-*` without `-preview`), the service receives the
  catalogue id. Probe at implementation which of `--model gemini-3.8-flash
  --effort high` and `--model gemini-3.8-flash-high` the CLI accepts, then
  either translate in the adapter (Claude's `[1m]`-strip precedent) or record
  the CLI ids as the harness's own aliases.
- Capabilities, each grounded above: `supportsResume: true`
  (`--conversation`); `supportsImages: false` — **not-wired**, tracked in
  planning#543's follow-ups: the CLI has no image flag and the
  `<attached_images>` block is untested (docs/266 item 13 says probe with a
  negative control; run it in Phase 10 before flipping); `supportsSystemPrompt:
  true` (standing instructions via the plugin rule — Grok's `--rules`
  shape); `supportsPermissionModes: true` with a one-member
  `ANTIGRAVITY_PERMISSION_MODES` (full-auto only, req 8);
  `reasoning: { options: low|medium|high }` with the Pro row narrowed to
  `low|high` via `ModelDef.reasoningEfforts` (docs/302 left the field for
  this); `supportsReview`: **set by the item-15 probe, not declared here**
  — docs/266 rejects "unexercised at launch" as a basis; the three things
  the flow needs are all in `init.tools` (`run_command` with
  `command_status` for a minutes-long command, `invoke_subagent`,
  `view_file`/`grep_search`), so the expectation is `true`, and the
  depth-0 probe with the real composed review message runs on the first
  session the implementation can open (checklist Phase 0); `supportsSteering: false` —
  **structural** (spawn per turn; the CLI's `--input-format stream-json`
  resident shape is a follow-up); `startsOwnTurns: false` — structural;
  `supportsCompaction: false` — probed; `supportsGoals: false` — not-wired
  (the CLI has a `/goal` command; docs/297 shape, follow-up);
  `skillsDirName: ".claude"` with disclosure through the plugin (below);
  `skillInvocationPrefix: "/"` — **probed** (`slash-skill.ndjson`,
  `slash-skill-transcript_full.jsonl`, `slash-probe.sh`): a print-mode turn
  whose whole prompt was `/probe-skill`, the bare name of an installed
  plugin skill, answered that skill's passphrase.
- `ANTIGRAVITY_TOOL_NAMES`: the 57 names in `probes/flash-test.ndjson`'s
  `init.tools`. The transcript vocabulary normalizer maps `view_file` →
  read, `write_to_file` / `replace_file_content` /
  `multi_replace_file_content` / `sed_file` → edit, `run_command` +
  `command_status` + `send_command_input` → shell, `grep_search` /
  `find_by_name` / `list_dir` → search, `manage_task` → the task panel,
  `invoke_subagent` / `define_subagent` / `browser_subagent` → the subagent
  card, and `call_mcp_tool` → the MCP label built from
  `ServerName`/`ToolName` (planning#437 pattern). Parameter keys are
  PascalCase (`AbsolutePath`, `SearchDirectory`) and translate at the same
  boundary.

## Install (recipe step 3, req 5)

The binary is not on npm. `install-agent-clis.sh` keeps its shape and gains
one non-npm branch, gated on `contains antigravity $selected`:

- `KNOWN_HARNESSES` gains `antigravity`; `harness_bin` echoes `antigravity`;
  `harness_pkg_prefix` gets a sentinel arm (the parity test requires the arm
  and the pruning loop calls it; it prunes nothing for this harness).
- `ANTIGRAVITY_VERSION=<x.y.z>` and `ANTIGRAVITY_SHA256_{x64,arm64}` pinned
  in the script; the branch curls
  `https://github.com/google-antigravity/antigravity-cli/releases/download/<version>/agy_cli_linux_<arch>.tar.gz`
  (arch from `uname -m` as `Dockerfile.session-worker.docker` does), checks
  the digest, extracts to `/opt/antigravity/`, and `chmod -R a-w` the
  directory. **A checksum on a curled artefact is a new convention in this
  repo** (Gradle, the Android tools and docker-compose are version-pinned
  without one); it is proposed here because the tarball is the only
  unhashed executable in the image and the pin is what makes req 5 true.
- `harness_link_target` returns `/opt/antigravity/antigravity`; the generic
  link, `--version` verification (under the scratch `HOME`) and
  `installed.json` loops then cover it. The prune arm removes
  `/opt/antigravity` when deselected.
- **Read-only install neutralises the updater — for the worker uid.** On
  1.2.2 the updater logs `Directory … is not fully accessible (readable:
  true, writable: false), skipping update` and exits (probed as the
  unprivileged session user, candidates.md). `/opt/agent-cli` is already
  root-owned and read-only to the worker; `/opt/antigravity` follows the
  same rule, and that covers every turn. **It does not cover root**: the
  orchestrator-side spawns (the sign-in run in the auth manager, session
  naming) inherit the orchestrator's identity, and mode bits do not stop a
  root process. Probe the updater's decision as root at implementation; if
  it writes, run those two spawns under a dropped uid (the docs/266 git
  rule) or mount the install path read-only in the orchestrator image. The
  checksum proves the artefact at build time only; the runtime guarantee is
  this one. Re-check the log line on every version bump (docs/272).
- **Version choice**: daily 1.x releases; take the newest that is ≥ 7 days
  old at implementation time and record its date — `check-deps` covers only
  the two npm manifests, so this pin is policed by review, not CI.
- `agent-cli-install.test.ts` runs the real script against a stub `npm`; the
  tarball fetch needs a stub of the same kind (an env override pointing the
  branch at a local tarball) so the behavioural tests stay offline.
- Dogfood: the root `docker-compose.yml` hard-codes `SHIPIT_HARNESSES` in
  both dogfood blocks; add `antigravity` to both. `DEFAULT_HARNESSES` and
  `HARNESS_DEFAULT` stay unchanged (docs/271: installable, not default).

## Credentials, sign-in and identity (reqs 2–4)

- **Credential root is `~/.gemini`**, linked as a directory:
  `AGENT_CREDENTIAL_PATHS.antigravity = [".gemini"]`, Dockerfile symlinks
  `/home/shipit/.gemini → /credentials/.gemini` (+ `chown -h`) in the three
  images, `entrypoint.sh` materialises `/credentials/.gemini` via gosu as it
  does for `.grok` (planning#444). `AGENT_TOKEN_FILES.antigravity =
  [".gemini/antigravity-cli/antigravity-oauth-token"]` — the token is one
  level below the link, so a refresh rename cannot swap the link (docs/266
  step 3 rule).
- **Revocation is a silent site the recipe list does not name.**
  `removeProviderSubtreeForReplacement` (`session-agent-credentials.ts`)
  returns without deleting anything for a directory root that has no
  `SUBTREE_STATE_SUBPATHS` entry (`token-sync-manager.ts`), so a bare
  `AGENT_CREDENTIAL_PATHS` entry would leave a revoked account's token in
  place. And the entry cannot simply preserve `antigravity-cli/`, because
  the token sits inside it beside the state. So the entry lists the
  state subpaths *under* `antigravity-cli/` (`conversations`, `brain`,
  `conversation_summaries.db`, `mcp`, `plugin_data`, `cache`, `log`) and the
  removal walks one level deeper for this root — with a test that revokes a
  seeded `.gemini` and asserts the token is gone and a conversation file
  survives.
- **Nested token paths are a second silent site.** `tokenFileNamesForSubtree`
  (`token-sync-manager.ts`) matches only two-component entries
  (`<root>/<file>`), so a three-component
  `.gemini/antigravity-cli/antigravity-oauth-token` is invisible to orphan
  discovery and leak repair — which would preserve the conversation state
  and delete the only token copy. The helper returns paths relative to the
  declared root instead, and the orphan-recovery test gets a nested-token
  case.
- **`settings.json` has one owner: the adapter, from the home's own
  state.** The CLI needs `{"modelProvider":"gemini"}` in
  `antigravity-cli/settings.json` to use the key (probed), and that file
  lives in the credential root. At every spawn the adapter derives the
  value from what the home contains — token file present ⇒ the
  `modelProvider` key is removed (account wins, the key is scrubbed anyway);
  token absent and a key routed ⇒ `gemini` — and writes it only when it
  differs. Idempotent, needs no routing information, and covers every
  spawn path (turn, brokered run, naming, local mode) with the same code.
  `POST_PROVISION_CONFIG` was considered and rejected: it receives only a
  directory, so it cannot know the route, and it does not run for local or
  naming homes. This is the one file the adapter writes into the durable
  directory.
- **Freshness reader** on the token's `expiry` field (ISO-8601 per
  candidates.md; verify on the real file), falling back to the JWT `exp` of
  `id_token`/`access_token` (Codex's shape). Fixture: the real file with
  values blanked, committed under `__fixtures__/token-freshness/antigravity.json`
  (the guard test requires it).
- **Identity** (`provider-account-identity.ts`): decode `id_token`'s
  payload — `sub` as `externalId`, `email` as the label. No plan name:
  the preview is free; the row says nothing about a plan (docs/274's
  honest-absence rule).
- **Auth manager `google-antigravity-oauth`** (`orchestrator/agents/antigravity/auth-manager.ts`),
  the Claude `code-paste-url` shape with Grok's process handling: spawn
  `antigravity -p "Reply with the single word pong." --output-format text`
  with `HOME` at the account's credential root and stdin piped (no PTY — the
  CLI reads the code from plain stdin, probed), scrub `GEMINI_API_KEY` first,
  detect the Google URL on stderr and emit `pending {kind: "code-paste-url",
  verificationUri}`; `submitCode` writes the code + `\n` to stdin; success =
  exit 0 and a fresh token file; the 60 s window is the CLI's, surfaced as
  the failure reason on timeout. The client already renders the paste box
  for `code-paste-url` — the only client edit is `ServicesPanel.tsx`'s
  hardcoded `signInProvider === "claude" ? "paste" : "code"` placeholder
  gate, which becomes a set of paste-shaped providers.
- **Refusals reach the user verbatim (req 4).** At sign-in: the manager
  emits `failed({reason: "error", message: <the stderr error: line>})` —
  `app-lifecycle.ts` forwards `message` and `useServerEvents.ts` prefers it
  over the generic copy (verified at source), so the eligibility sentence
  renders in the sign-in card as-is. At turn time: the adapter does **not**
  classify an `error:` line as `auth_required` (that path replaces the text
  with `AGENT_NOT_AUTHENTICATED_MESSAGE` in `agent-auth-handler.ts`); it ends
  the turn as an error whose text is `result.error` (or the stderr line when
  no result arrives), which the error row shows. The one exception is a
  missing credential before spawn, where the generic gate is the right
  answer. Same rule carries Google's 429 quota text to the user.
- **Key mode**: `settings.json` as above, and the adapter scrubs
  `GEMINI_API_KEY` when the account file is present (Grok's "file auth
  wins" rule; `HARNESS_CREDENTIAL_VARS.antigravity = ["GEMINI_API_KEY",
  "GOOGLE_API_KEY"]`). Egress: sign-in and refresh need
  Google's OAuth hosts and account mode talks to a host candidates.md does
  not name — measure both with a signed-in token before the allowlist tests
  are extended.

## Adapter (`session/agents/antigravity/`, Claude-shaped)

- **Spawn per turn**: `antigravity --print='' --input-format stream-json
  --output-format stream-json --dangerously-skip-permissions --model <id>
  [--effort <lvl>] [--conversation <id>] --print-timeout <n>` with cwd = the
  workspace, the prompt written to stdin as one
  `{"event":"user","message":{"content":"…"}}` line, then stdin closed —
  the prompt never rides argv (128 KiB ceiling; Grok's `--prompt-file`
  lesson). The `conversation_id` from `init` is stored for `--conversation`
  on the next turn; an unknown id starts a new conversation with a warning
  (candidates.md) — surface it as Claude's resume-invalid recovery does.
- **Spawn home** (`makeSpawnHome`, Grok's shape): a throwaway `HOME` under
  `/tmp` holding `.gemini/antigravity-cli → <credential root>/.gemini/antigravity-cli`
  (a directory link: token, conversations, `mcp/` schema cache and
  `plugin_data/` stay durable and shared) and a fresh `.gemini/config/`
  written per spawn: `mcp_config.json` (Playwright + the `shipit` bridge +
  the user's servers with `$secret:` resolved, in `mcpServers` shape),
  `plugins/shipit/` (`plugin.json`; `rules/AGENTS.md` = ShipIt's system
  prompt fragment **followed by the repository's own instructions**, read at
  spawn from the workspace's `AGENTS.md`, else `CLAUDE.md`, else `GEMINI.md`,
  under a heading naming the file — because the CLI reads none of them
  itself (probed above) and ShipIt's instruction builder does not include
  them for any harness; `skills/` = symlinks to the repo's `.claude/skills/*`
  for docs/209 disclosure) and `import_manifest.json` naming it. **Verify at
  implementation** that a hand-written `config/plugins/<name>/` +
  manifest entry is honoured without running `plugin install` (the probe ran
  the command; the files it wrote are exactly these), and that a symlinked
  skill directory inside the plugin is followed. Cleanup is `rmSync` on the
  throwaway root. **Why a throwaway root at all, given ShipIt already
  scopes homes:** in container mode every spawn has its own home — a turn
  runs in the session's credential copy and a same-harness `shipit agent
  run` gets a provisioned `homeDir` of its own (`services/sub-agent.ts`,
  forwarded through `agent-controller.ts`; verified at source, the docs/274
  gap is closed). There the throwaway root duplicates isolation the
  platform provides. What still needs it is **local mode** (dogfood,
  `RUNTIME_MODE=local`): a spawn's `HOME` is the account root itself, so a
  turn and a brokered run on the same harness would both write
  `config/mcp_config.json` into one directory — the exact race docs/274
  hit. One code path for both modes is simpler than a mode switch, so the
  root is built unconditionally, and it is cheap (a directory, one symlink,
  a few small files). The durable link is what keeps the token,
  conversations and the MCP schema cache shared.
- **Event mapping** (`mapEvent`): `init` → `agent_init`; `agent_response`
  deltas → `agent_assistant` text; a `tool` step ACTIVE → tool_use (name +
  normalized input), DONE → `agent_tool_result` (`tool_info.output`);
  `error_message` → the error narration; the resume `system_message` notice
  is dropped; `result` → `agent_result` with disjoint tokens, cost priced
  from the catalogue, and the "answer present, status ERROR" rule above. A
  truncated stream (no `result`) synthesises the terminal result from the
  exit code (OpenCode precedent). Conformance fixtures replay the vendored
  captures byte for byte.
- **Permission gate**: none at launch (req 8) — `--dangerously-skip-permissions`
  always; the `PreToolUse` hook (`hooks.json` in the plugin) is the tracked
  guarded-mode follow-up.
- **Session naming**: `--output-format json` is Antigravity's own envelope
  (`result.response`), so a `parseAntigravityJson` beside `parseGrokJson`,
  under a scratch home as Grok's naming runs get.
- Env discipline at spawn, Grok's shape, not Claude's: `resolveAgentHome()`
  → `scrubHarnessEnvCredentials(env, "antigravity")` → deliver the routed
  credential to `routing.credentialTarget` and the endpoint to
  `GOOGLE_GEMINI_BASE_URL = routing.baseUrl` in the adapter itself.
  `scrubEnvAuthForScopedHome` and `applyServiceRouting` (`spawn-routing.ts`)
  are Anthropic-specific — the latter sets `ANTHROPIC_BASE_URL` — and are
  not reused (verified at source). Also unset `GOOGLE_API_KEY` /
  `AGY_ADC_AUTH` / `GOOGLE_APPLICATION_CREDENTIALS` so ADC cannot bill a
  different Google account (the probes unset them for the same reason). The
  naming run takes the same env path under its scratch home.

## Follow-ups tracked on planning#543, not in this feature

Guarded mode via `PreToolUse` (req 8); images (`supportsImages`, probe with
a negative control); steering via the resident `--input-format stream-json`
process; goals via the CLI's `/goal`; an account-usage reader if one
exists. Each is a `false` of the not-wired kind and says so beside the
flag. `supportsReview` is not on this list: its probe is part of this
feature (item 15) and sets the launch value.
