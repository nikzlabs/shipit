---
issue: planning#433
title: Grok Build harness
description: Grok Build (xAI's `grok` CLI 1.x, npm `@xai-official/grok`) as the fourth harness — Claude-shaped spawn-per-turn adapter, per the docs/266 recipe.
---

# Grok Build harness

Implements [requirements.md](./requirements.md), by following
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md)
(req 7). This doc holds only what is Grok-specific: the Phase 0 findings, the
catalogue row decisions, and the adapter design. The step-by-step is
[checklist.md](./checklist.md), copied from the recipe template.

## Phase 0 findings — no-credential half (verified against CLI 1.0.5, 2026-08-18, in-container)

Everything below was observed live — the installed binary's `--help`/
subcommand surface, `grok inspect`, real `mcp add` output, the downloaded
install script, the npm registry, and unauthenticated runs. Items still
requiring a credential are listed at the end. The desk-research fact sheet
([candidates.md §Grok Build](../266-harness-integration-recipe/candidates.md),
2026-08-15) predates the 1.0 release (2026-08-07) and is superseded on
several rows below.

- **The CLI is at 1.0.x, not 0.x** — `stable` channel pointer returns 1.0.5
  (weekly stable cadence per `grok update --help`; separate `alpha` channel).
- **An official npm package exists: `@xai-official/grok`** — the candidates.md
  "curl-only, third-party pin claim" row is obsolete. The package is
  exact-pinnable: platform binaries as `optionalDependencies`
  (`@xai-official/grok-linux-x64`, …, brotli-compressed) with a
  `postinstall` shim (`node bin/postinstall.js`).
  **It is NOT the OpenCode rebuild shape, though it looks it** (planning#442,
  found live after this doc first shipped): the postinstall decompresses the
  payload to `$GROK_HOME/bin` (`~/.grok/bin`) — *outside* node_modules, i.e.
  root's home at image-build time — and the `bin/grok` JS launcher's runtime
  recovery either needs a writable install tree (in-place decompress; fails
  in read-only `/opt/agent-cli`) or copies the 157MB binary into `$GROK_HOME`
  per spawn (ShipIt's throwaway per-turn root). So instead of `npm rebuild`,
  `install-agent-clis.sh` decompresses `grok.br` in place at build (0755,
  `.br` deleted) and links `/usr/local/bin/grok` **directly at the platform
  binary**; the installer then proves every selected harness binary executes
  (`--version` under a scratch HOME). Runtime `GROK_HOME` stays what the
  adapter says it is — pure config/state delivery, no longer part of binary
  resolution.
  **Linking `/usr/local/bin` did NOT on its own bypass the launcher** — this
  paragraph claimed it did, and planning#444 found the claim false as shipped.
  Every image prepends `/opt/agent-cli/node_modules/.bin` to `PATH`, *ahead* of
  `/usr/local/bin`, and the adapter spawned `grok` by name: measured in a live
  container, `command -v grok` answered
  `/opt/agent-cli/node_modules/.bin/grok`. Two edits make it true — the
  installer now **unlinks** that shim (the one harness whose `.bin` entry is a
  different program from its `/usr/local/bin` link), and the adapter resolves an
  absolute path that skips any `node_modules/.bin` candidate, so an image built
  before the installer change still runs the real binary.
  `bin: { grok: "bin/grok" }` matches the catalogue binary. One transitive
  dep (`@iarna/toml`). **Pin decision: `1.0.1`** (published 2026-08-11T00:30Z;
  `check-deps` compares strict milliseconds, so 1.0.1 crossed the 7-day line
  at 2026-08-18T00:30Z — passes; 1.0.2–1.0.5 are younger). Note
  `check-dependency-age.ts` mechanically scans only the ROOT `package.json`
  — the `docker/agent-cli/package.json` pin is bound by the same policy via
  the recipe, not by CI; verified here by hand. Flag surface of 1.0.1
  verified identical to 1.0.5 on the load-bearing rows (both streaming
  formats, `--reasoning-effort`, `--device-auth`, `-s`); the conformance
  capture runs against the pinned 1.0.1.
- **The curl installer** (`https://x.ai/cli/install.sh`, inspected) also pins
  first-party (`bash -s X.Y.Z`, strict version regex; artifact at the
  deterministic `https://x.ai/cli/grok-<version>-<platform>`, GCS fallback;
  no checksums). Not needed given npm, kept as provenance.
- **Headless**: `-p/--single` (also `--prompt-file`, `--prompt-json`,
  `--verbatim`, `--json-schema`). Unauthenticated headless run exits 1 and
  emits `{"type":"error","message":…}` on stdout. `--max-turns`, `--cwd`.
- **Output formats**: `plain | json | streaming-json | streaming-messages-json`.
  `streaming-json` is "NDJSON of the agent native ACP session updates";
  `streaming-messages-json` is "NDJSON in the **Anthropic Messages API wire
  format**" with `--include-partial-messages` adding `stream_event` deltas —
  a strong candidate for near-Claude adapter reuse. **Schema still
  undocumented** (docs.x.ai headless page fetched 2026-08-18 covers neither)
  — capture + conformance test remain mandatory (req 5).
- **Sessions/resume**: `-r/--resume <id-or-title>`, `-c/--continue`,
  `--fork-session`, and `-s/--session-id <uuid>` which lets the caller
  **pre-assign the session UUID for a new conversation** — potentially nicer
  than parsing the id from output. Store: `~/.grok/sessions` (docs).
- **Permissions**: Claude-compatible `--permission-mode
  default|acceptEdits|auto|dontAsk|bypassPermissions|plan`, plus
  `--always-approve`, `--allow`/`--deny` (compat aliases
  `--allowedTools`/`--disallowedTools`), `--tools`/`--disallowed-tools`,
  `--no-plan`, `--no-subagents`, `--disable-web-search`, `--sandbox`.
- **Reasoning control exists (req 8 / recipe row 12 — not blocked):**
  `--reasoning-effort <EFFORT>` (alias `--effort`) at top level and on
  `grok agent`; config `default_reasoning_effort`; the model catalog carries
  per-model `supports_reasoning_effort` + `reasoning_efforts` arrays
  (binary-verified), and an unsupported effort is **silently ignored**
  ("model does not support effort; ignoring it") — so ShipIt's catalogue owns
  validation, same as OpenCode's `--variant`. The concrete vocabulary comes
  from the authenticated catalog fetch — pending credential.
- **Auth (first-party verified, upgrading candidates.md's third-party rows):**
  `grok login --device-auth` (alias `--device-code`) is in the CLI's own
  help; the unauthenticated error names `XAI_API_KEY` as the alternative.
  Token store: `~/.grok/auth.json` (0600), scope-keyed
  `{"<scope-url>": {"key": …}}` — the OIDC scope is
  `https://auth.x.ai::b1a00492-…` (read by the install script too).
  Env overrides exist: `GROK_AUTH` / `GROK_AUTH_PATH`. Subscription tiers in
  the binary: `supergrok(_lite|_plus|_heavy)`, `x_premium(_plus)`.
  Enterprise: `GROK_DEPLOYMENT_KEY` + managed config (not in scope).
- **Models**: `grok models` works unauthenticated from the bundled catalog:
  `grok-4.6` (default), `grok-4.5`. Grok Build is service-fused to xAI's
  backend by default, but endpoint override surfaces exist first-party:
  `--xai-api-base-url` / `GROK_XAI_API_BASE_URL` and
  `--cli-chat-proxy-base-url` / `GROK_CLI_CHAT_PROXY_BASE_URL` (the
  subscription chat proxy, `https://cli-chat-proxy.grok.com/v1`), plus
  `[models]` config with `extra_headers`, `temperature`, `base URL`-style
  keys — which API style they speak needs a recorder (pending credential).
- **Config root is relocatable: `GROK_HOME`** (verified live — config.toml,
  sessions, logs all follow it), the `agent-home.ts` helper shape. Also
  `GROK_CONFIG` / `GROK_CONFIG_PATH` (extra config file pointers, to verify
  live before relying on them for per-turn config).
- **MCP**: TOML `[mcp_servers.<name>]` in `~/.grok/config.toml` (user) or
  `./.grok/config.toml` (project) — verified by running `grok mcp add`:
  `command`/`args`/`enabled` + `[mcp_servers.<name>.env]`; remote `http`/`sse`
  with per-server headers. Knobs: `GROK_MCP_STARTUP_TIMEOUT_SECS`,
  `GROK_MAX_MCP_OUTPUT_BYTES`, `GROK_MCP_AUTO_RESTART`.
- **Auto-update is real and disableable**: the TUI/leader auto-updates
  (`Leader auto-update: …` paths in the binary); `grok update --check --json`
  reports `installer`/`channel`/`autoUpdate`; kill switches:
  `--no-auto-update` (accepted, verified), config `[cli] auto_update`, env
  `GROK_DISABLE_AUTOUPDATER`. The npm install records
  `GROK_MANAGED_BY_NPM`, so the updater knows it doesn't own the binary.
- **Telemetry/error-reporting kill switches**: `GROK_TELEMETRY_ENABLED`,
  `DISABLE_TELEMETRY`, `GROK_ERROR_REPORTING` / `DISABLE_ERROR_REPORTING`,
  plus OTEL exporter env. Decide-and-set in the adapter env.
- **Harness compatibility layer (unexpected, load-bearing):** `grok inspect`
  shows first-class compat with **claude** (skills, rules, agents, mcps,
  hooks, sessions — all default-on), **cursor** (same), and **codex**
  (sessions), each with a `GROK_<VENDOR>_<AREA>_ENABLED` env toggle. So
  `.claude/skills/` auto-disclosure is native (docs/209 probe still runs
  empirically in Phase 10), and the adapter must *deliberately* set the
  toggles it doesn't want — e.g. Claude MCPs/hooks compat reading
  `.claude/settings.json`/`.mcp.json` behind ShipIt's back.
- **Workspace trust**: projects are trust-gated (`Project trusted: yes` in
  inspect; `GROK_FOLDER_TRUST`, folder-trust prompt paths in the binary) —
  the `LOCAL_WORKSPACE_TRUST` / `POST_PROVISION_CONFIG` extension point
  (recipe step 5) likely applies; verify which state a fresh container sees.
- **Subagents**: built-in `general-purpose` / `explore` / `plan` agents,
  `--agents` JSON injection, `--no-subagents`. `--rules` appends to the
  system prompt; `--system-prompt-override` replaces it
  (`supportsSystemPrompt`).

### Captured-stream findings (real key-mode tool-tour, CLI 1.0.1, 2026-08-18)

Raw captures with provenance:
`/persist/grok-capture/capture-2026-08-18-1017-{streaming-json,streaming-messages-json}.ndjson`
(tool-tour prompt per docs/272 Step 1, sandbox repo, `XAI_API_KEY` mode,
model `grok-4.20-0309-non-reasoning` — the key-mode default).

- **`streaming-messages-json` is Claude Code's stream-json wire, near
  verbatim** — the adapter format of choice. Observed: `system/init`
  (`session_id`, `model`, `cwd`, `permissionMode`, `tools`, `apiKeySource`),
  `assistant`/`user` envelopes holding Anthropic Messages objects
  (`tool_use` / `tool_result` content blocks, per-message `usage`), terminal
  `result` with `subtype: "success"`, `is_error`, `duration_ms`,
  `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`
  (incl. `server_tool_use`), `session_id`, `uuid`, plus xAI extras
  `stop_reason` and `modelUsage`. The Claude adapter's mapping should apply
  with minor extension.
- **`streaming-json` (ACP-flavored) vocabulary**, for reference:
  `available_commands` (commands + tools) → `text` deltas ×N → `tool_call`
  (`toolCallId`, `toolName`, `kind`: read/write/edit/execute/search/task/
  plan/list/background_task_action, `status: pending`, `rawInput`) →
  `tool_call_update` (`status: in_progress|completed`, `rawOutput`) →
  `plan` (todo entries with `content`/`priority`/`status`) → `usage`
  per step → terminal `end` (`stopReason`, `sessionId`, `requestId`,
  `usage`, `num_turns`, `total_cost_usd`, `modelUsage`).
- **Token semantics are disjoint — no normalizer.** Verified arithmetically
  on the terminal event: `input + cache_read + cache_creation + output +
  reasoning = total` (29623+88128+0+857+0 = 118608). Cost arrives as
  `total_cost_usd` (+ `_ticks`).
- **Tool vocabulary (`GROK_TOOL_NAMES` input, 25 advertised):**
  `run_terminal_command, read_file, search_replace, list_dir, grep,
  kill_command_or_subagent, todo_write, get_command_or_subagent_output,
  spawn_subagent, scheduler_create, scheduler_delete, scheduler_list,
  monitor, search_tool, use_tool, workflow, enter_plan_mode,
  exit_plan_mode, ask_user_question, web_search, image_gen, image_edit,
  image_to_video, …` (full list in the `system/init` capture).
- **Reasoning control, revised (req 8 — now the one open Phase 0 thread):**
  in key mode, `--reasoning-effort` is **silently dropped for every model
  probed** (grok-4.20-0309-reasoning, grok-4.6 — recorder-verified: the
  request body has no effort field at all); reasoning is selected by *model
  id* (`-reasoning` / `-non-reasoning` pairs), and `api.x.ai/v1/models`
  metadata carries no effort fields. The binary's `reasoning_efforts`
  catalog machinery therefore appears **subscription-catalog-gated**
  (cli-chat-proxy `/rest/modes`). Whether Grok offers real effort levels —
  and thus whether `REVIEWER_DEFAULT_EFFORT` can name one, or the
  reviewer-default mechanism needs the docs/266 "no-levels" design decision
  first — is now **pending the subscription (device-flow) login**.
- **Wire routing detail:** with an explicit `-m`, the main turn goes to
  `POST /chat/completions` (openai-chat-completions); the title side-call
  (and possibly catalog-default turns) uses `POST /responses`
  (openai-responses, `reasoning: {summary}` only). Both styles observed
  from one CLI — catalogue `styles` must list both, endpoint per style.
### API style (resolved 2026-08-18, recorder-verified with a dummy key)

Auth is checked server-side, so the request shape needed no real
credential. The CLI speaks **two** OpenAI styles (see the routing detail
above): `POST /chat/completions` (`stream` + `stream_options:
{include_usage}`) for explicit `-m` turns, and `POST /responses` (`input`
arrays, `include: ["reasoning.encrypted_content"]`, `reasoning:
{summary}`) for the title side-call / catalog-default path. Auth:
`Authorization: Bearer <key>`; model also in an `x-grok-model-override`
header, plus `x-grok-session-id` / `x-grok-conv-id` /
`x-grok-client-mode: headless` headers. Side facts: `GET /models` and
`GET /api-key` preflights precede the turn (an explicit `-m` **aborts
without any POST if `/models` fails** — recorder must answer it); a
session-title side-call rides every run (OpenCode-class cost noise); on
5xx the CLI retries with no stdout (bound with `GROK_MAX_RETRIES`).

### Phase 0 closing probes (all live, key mode, 2026-08-18)

- **grok-4.6 tool-tour (req 9)**: clean success in `streaming-messages-json`
  — identical schema to the 4.20 capture, all seven tour surfaces driven
  (`todo_write, read_file, write, search_replace, run_terminal_command,
  grep, spawn_subagent, list_dir`), side effects verified on disk,
  `modelUsage` keyed `grok-4.6`, $0.0865. Capture:
  `capture-2026-08-18-grok-4.6-messages.ndjson`. Nuance: the subagent's
  internals are NOT streamed (no event ever carried a non-null
  `parent_tool_use_id`); only the spawn's tool_result returns — the
  transcript shows the report, not child events.
- **Resume verified**: `-r <id>` re-inits with the SAME `session_id` and
  recalls turn facts. **Pre-assignment verified**: `-s <uuid>` on a new
  conversation adopts the caller's UUID (init + result both carry it) — the
  adapter pre-assigns ids instead of parsing them out.
- **AGENTS.md read; skills auto-disclosed from BOTH `.grok/skills/` and
  `.claude/skills/`** (docs/209 probe: all three markers surfaced, no
  tools). No symlink needed; `skillsDirName: ".grok"`.
- **Auth.json injection + account identity** — deferred to planning#435
  with the rest of subscription mode (req 6). **Images** — unprobed;
  `supportsImages: false` until observed (OpenCode precedent).

## Catalogue row (recipe step 2)

- `id: "grok"`, `name: "Grok Build"`, `binary: "grok"`. New vendor
  `ServiceDef` **xai** with `storageEnv: "XAI_API_KEY"` (already declared in
  the dev compose `x-shipit-secrets`); models per req 9: `grok-4.6` (500k
  ctx, premium tier), `grok-4.3` (1M ctx, budget tier — added by Nik
  2026-08-18), and `grok-4.20-0309-reasoning` / `-non-reasoning` (1M ctx,
  budget tier, the key-mode defaults) — prices translated from the live `/v1/models`
  price fields against xAI's published pricing page at implementation time
  (`catalogue.test.ts` rejects sentinels; raw capture in
  `/persist/grok-capture/models.json`).
- `styles: ["openai-chat-completions", "openai-responses"]` — both observed
  from one CLI; chat-completions first (the explicit `-m` path the adapter
  always drives). `spawn.endpoint`: env `GROK_XAI_API_BASE_URL`.
- `spawn.credential`: `{ kind: "env", name: "XAI_API_KEY" }`, **no
  `account` target** (req 6 — structurally excludes subscription modes,
  docs/268 precedent). `spawn.model`: flag `-m`.
- Capabilities (each grounded above): `supportsResume: true`,
  `supportsImages: false` (unprobed), `supportsSystemPrompt: true`
  (`--system-prompt-override`; wire-verify at implementation),
  `reasoning: []` (req 8 — with the reviewer-default no-levels extension),
  `supportsReview: false` at launch (unexercised as reviewer),
  `supportsSteering: false` (one-shot argv prompt), `startsOwnTurns:
  false`, `supportsCompaction: false` (config-driven autocompact only; no
  on-demand trigger found), `skillsDirName: ".grok"`,
  `skillInvocationPrefix: "/"`. Permission modes: Grok's set
  (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan`) differs from
  Claude's → per-harness constant (recipe step 1), though headless runs
  `--always-approve` regardless.

## Adapter design (`session/agents/grok/`, Claude-shaped)

- Spawn per turn: `grok -p <prompt> --output-format streaming-messages-json
  --always-approve --no-auto-update -m <modelId> [-s <newUuid> | -r
  <resumeId>] --cwd <workspace>` (prompt as argv, spawn array, no shell).
  ShipIt **pre-assigns** the session UUID via `-s` on first turn, resumes
  with `-r` after.
- Env: `resolveAgentHome()` (`grokHome()` helper on `GROK_HOME` —
  relocation verified) → `scrubEnvAuthForScopedHome` → `applyServiceRouting`
  (order per `claude/process.ts`), plus `GROK_DISABLE_AUTOUPDATER=1`,
  `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`,
  `GROK_OAUTH2_REFERRER=shipit`, and harness-compat toggles: Claude
  **skills/rules stay on** (native `.claude/skills` disclosure, AGENTS.md),
  Claude **mcps/hooks/agents/sessions off** and all Cursor/Codex compat
  off (`GROK_<VENDOR>_<AREA>_ENABLED=0`) — ShipIt owns MCP config and hook
  surfaces.
- Event mapping: the stream is Claude's stream-json near verbatim →
  `mapEvent` mirrors `claude/adapter.ts` (system/init → `agent_init`;
  assistant/user envelopes pass through; terminal `result` → `agent_result`
  with disjoint tokens + `total_cost_usd`), extended for xAI extras
  (`stop_reason`, `modelUsage`) and Grok's tool-name vocabulary
  (`GROK_TOOL_NAMES`, registry work per docs/272 — `todo_write` drives the
  task panel, `search_replace`/`write` the diff surfaces, `spawn_subagent`
  the subagent card with result-only report). That registry work landed as
  `grok-tool-normalizer.ts` (planning#437, the planning#432 pattern):
  tool_use names and the two divergent input keys
  (`target_file`→`file_path`, `target_directory`→`path`) translate to the
  transcript vocabulary at the Layer A boundary; the `spawn_subagent`
  result envelope (`SubagentCompleted`/`Text`) unwraps to the report text;
  Grok's `todo_write merge:true` patch calls are understood by the client
  fold (`task-list.ts`), which patches by item id instead of clearing. The
  three interactive tools (`ask_user_question`, `enter_plan_mode`,
  `exit_plan_mode`) deliberately stay raw until their card shapes are
  captured (revisit under planning#435).
- MCP: `writeMcpConfig(ctx)` renders a per-turn TOML (`[mcp_servers.<name>]`
  `command`/`args`/`env`, shape verified via `grok mcp add`) delivered via
  `GROK_CONFIG` → `{runtimeEnv, cleanup}`; **verify the CLI honors
  `GROK_CONFIG` early at implementation** (strings-sourced, not yet
  exercised). MCP tool subset for the shipit bridge: adapter's own list.
- Failure discipline (from observed behavior): on upstream 5xx the CLI
  retries with **no stdout** — keep Claude's warn-only watchdog narration;
  bound with `GROK_MAX_RETRIES` if turn-length pathology shows up. The
  title side-call cost noise is accepted (no disable switch found).
  Interrupt/kill paths follow Claude's contract; conformance fixtures
  replay the real captures including a truncated-stream synthesized-result
  case.

## Prior art: T3 Code's Grok integration (read 2026-08-18)

[pingdotgg/t3code](https://github.com/pingdotgg/t3code) (clone at
`/persist/refs/t3code`) drives Grok Build in production; its
`apps/server/src/provider/{Drivers/GrokDriver,Layers/GrokProvider,acp/GrokAcpSupport,acp/XAiAcpExtension}.ts`
are the reference. What transfers:

- **They implement no login flow at all.** Auth is either `XAI_API_KEY` in
  the env or the CLI's own cached login from a prior `grok login`
  (`GrokAcpCliProbe.test.ts` states this as the operating assumption). This
  validates ShipIt's design: user runs the device-code flow once, the cached
  `~/.grok/auth.json` is then portable — inject it via the credential
  symlinks; `XAI_API_KEY` is the metered mode. No bespoke OAuth code.
- **The Grok agent's ACP `authenticate` advertises two method ids** —
  `xai.api_key` and `cached_token` — and T3 picks by "is `XAI_API_KEY`
  set". In `-p` headless the CLI resolves the same two sources implicitly
  (our unauth probe named both).
- **`GROK_OAUTH2_REFERRER`** env tags the OAuth flow with the integrating
  product (they send `t3code`).
- **They drive `grok agent stdio` (ACP), not `-p`** — evidence that the ACP
  surface is what xAI supports for integrators. ShipIt's Claude-shaped plan
  stays `-p --output-format streaming-json` ("NDJSON of the agent native ACP
  session updates"), so their quirk handling predicts our stream:
  - A private `_x.ai/session/prompt_complete` notification (carries
    `stopReason`, optional `agentResult`) exists because the standard prompt
    response can fail to arrive — T3 races the two. Expect the same
    unreliable-terminal-event class OpenCode had; plan for a synthesized
    result path and lock it in the conformance test.
  - `stopReason` can be missing entirely (they flag it); observed vocabulary
    `cancelled | end_turn | max_tokens | max_turn_requests | refusal`.
  - `x.ai/ask_user_question` (sometimes wrapped in `{method, params}`)
    carries structured questions/options/multiSelect — Grok's user-question
    surface, relevant to the docs/272 recognition matrix.
  - The authenticated model catalog arrives typed on session setup
    (`SessionModelState`: `availableModels`, `currentModelId`) — likely
    where the per-model `reasoning_efforts` vocabulary surfaces;
    `session/set_model` switches models mid-session.
- They present Grok as "Early Access", one built-in model row, and
  `requiresNewThreadForModelChange: true`.

## What implementation corrected (2026-08-18)

Three Phase-0 assumptions did not survive contact with the code, and the
corrections are recorded here rather than silently applied — each was flagged
above as "verify at implementation", and each was wrong.

- **`GROK_CONFIG` / `GROK_CONFIG_PATH` do not exist.** The adapter design said
  MCP config would be delivered by pointing one of them at a per-turn file, with
  a note to verify. Probed directly: both are inert (the init event reported
  `mcp_servers: []` under each), and neither name appears in the binary — they
  were artifacts of loose string matching, not env vars. **The only delivery
  path is `$GROK_HOME/config.toml`** (`grok mcp add --scope user` writes exactly
  there, and a hand-written file was verified to produce
  `mcp_servers: [{name: "probe", status: "connected"}]`).

  **That single fixed path is a concurrency hazard, and the first cut had the
  bug.** The adapter originally wrote `$HOME/.grok/config.toml` and restored its
  previous contents afterwards. A container can have TWO grok processes alive at
  once — a turn, plus a `shipit agent run` sub-agent spawned *during* it — and
  the worker builds the sub-agent's adapter through `createWorkerAgent` with no
  scoped home (`agent-controller.ts:262`), so both resolve the same root. Under
  the backup/restore scheme whichever finished last decided what was left on
  disk, and the interleaving where the turn finishes first leaves ShipIt's
  per-turn config permanently in place. **The fix removes the shared file
  rather than locking it**: each spawn gets a throwaway `GROK_HOME` under
  `/tmp` holding its own `config.toml`, with `sessions/` — and `auth.json`,
  when one exists — symlinked back to the real root, so everything durable is
  still shared and nothing mutable is. Verified live: MCP servers connect under
  the throwaway root, session state writes through the link, and `-r` resumes a
  conversation started under a *different* throwaway root. Cleanup is
  `rmSync` on the directory, which does not follow symlinks.

  **The fallback in that builder was itself a trap (planning#444).** It caught
  any failure and returned `realRoot` as `GROK_HOME`, on the argument that a
  turn racing over one shared file beats a turn refused for a `mkdir`. That
  reasoning assumes the shared root works, and the failure it actually met was
  the case where it does not: the images symlink `~/.grok` at
  `/credentials/.grok`, key-billed Grok writes no credential material, and
  `copyCredentialPath` returns early on a missing source — so **nothing ever
  created the target and the link dangled in every session container**. A
  recursive `mkdir` through a dangling symlink throws (the raw syscall reports
  EEXIST, because the link is an existing entry; Node's recursive form reports
  ENOENT), the `catch` handed back that same unopenable path, and the CLI died
  at its own session creation with `FS_OTHER / "File exists (os error 17)"` and
  `duration_ms: 0` — before any stream event, which is why it surfaced as a bare
  `error` row (planning#438). Grok was non-functional in every real session
  container; only `Dockerfile.dev` escaped it, by creating no `.grok` symlink at
  all, which is why the dogfood runs were green while the outer install was dead.

  Fixed in three layers, each with a distinct job:
  1. **`docker/session-worker/entrypoint.sh`** creates `/credentials/.grok` via
     `gosu` as the worker on every boot — the same block, and the same gosu
     requirement, as OpenCode's `docs/270` line above it. This covers a wiped
     subtree, the terminal panel, and any spawn site ShipIt does not own.
  2. **`provisionAgentCredentialsFromRoot`** materializes every declared
     credential *directory* (`agentCredentialDirs`) whether or not there was
     anything to copy — the generic form of the class, so the next key-billed
     harness does not rediscover it. Orchestrator-side and per-session, so it
     never touches a shared tree and the existing chown covers it.
  3. **`makeSpawnHome`** never returns a root it has just proven unusable: the
     throwaway root is built first and unconditionally, the durable links are
     what may fail, and a failure narrates itself to the transcript. The turn
     runs with resume unavailable rather than not at all.
- **`GROK_HOME` is the `.grok` directory itself, not the home above it.**
  Verified: `GROK_HOME=/tmp/gh` produced `/tmp/gh/config.toml`, `/tmp/gh/logs/`,
  and the CLI reported the path back as `$GROK_HOME/config.toml`. Getting this
  backwards points the CLI at a config root one level off its credentials, which
  surfaces as "not authenticated" rather than as an error naming a path — hence
  the warning in `grokHome()`'s docstring.
- **`--output-format json` is NOT Claude's envelope**, which the session namer
  would otherwise have assumed. Grok's is `{text, usage, total_cost_usd, …}`;
  Claude's is `{result, usage, total_cost_usd, duration_ms}`. Reusing
  `parseClaudeJson` would find no `result`, fall through to its "unrecognized
  envelope" branch, and title the session with the raw JSON blob. `parseGrokJson`
  exists for exactly that, and Grok's naming runs get a throwaway `GROK_HOME`
  for the same reason OpenCode's get a scratch XDG root.

Two more design choices settled at implementation:

- **The prompt travels by `--prompt-file`, not argv.** `-p <PROMPT>` is argv,
  which has a 128 KiB per-argument ceiling on Linux that assembled prompts
  exceed. `--prompt-file` is first-party and was verified to run a full turn.
- **`--rules <FILE>` carries ShipIt's system prompt, not
  `--system-prompt-override`.** The override REPLACES Grok's own prompt, tool
  instructions included; ShipIt's is standing instructions alongside, not a
  replacement for the harness's operating manual.

And two probes that came back negative, each of which changed what shipped:

- **Workspace trust does not gate a headless run.** A never-seen git repo with a
  fresh config root ran a full turn with no trust prompt, so Grok needs no
  `LOCAL_WORKSPACE_TRUST` / `POST_PROVISION_CONFIG` entry (recipe step 5).
- **`supportsImages: false` is verified, not assumed** — the flag the reviewer
  flagged as the one worth probing. `--prompt-json` takes ACP content blocks and
  accepts an `image` block without complaint, so the syntactic surface exists.
  It does not carry vision: with the image data present ONLY inside the prompt
  (generated in memory, never written to disk), a randomized colour pair and an
  empty cwd, grok-4.6 answered `"unknown unknown"` in a single turn.

  **The first two attempts said the opposite, and were wrong.** Both answered
  the colours correctly — but a no-image **negative control** answered
  identically, which means the model had been reaching the answer off the
  filesystem (the probe image and its JSON were sitting in the cwd it was given)
  rather than seeing it. The lesson is the docs/272 one: a probe without a
  negative control proves the model got the right answer, not that it got it the
  way you think.

## Reasoning is a harness×mode fact, and neither existing axis holds it (req 14)

planning#435 verified that Grok's two billing modes disagree about
`--reasoning-effort`: the subscription honours it, the API key discards it
(negative control in requirements.md's receipt). Making the picker honest about
that turned out to need a shape neither the harness nor the model can express,
and the first two attempts both failed in ways worth recording — the second only
because a guard test had teeth.

**Attempt 1 — widen `AgentCapabilities.reasoning`.** Rejected immediately:
`reasoning.options` is per-harness, so one list must either offer levels that do
nothing under a key or hide levels that work under a subscription.

**Attempt 2 — narrow per catalogue row (`ModelDef.reasoningEfforts`).** This is
the shape that shipped as the *mechanism*, and it is genuinely the right
granularity for one thing: within the subscription, `grok-4.6` offers `xhigh`
and `grok-4.5` does not, so a mode-level list would have to be the intersection
and drop a level the user pays for.

But it is **not sufficient on its own**, and `reviewer-model.test.ts` is what
found it. A `ModelDef` is per *(service, mode, model)* — **not per harness**.
Grok can also run gateway rows (`x-ai/grok-4.6` at OpenRouter and Vercel, plus
DeepSeek and GLM via chat-completions), and those rows are *shared with Claude,
Codex and OpenCode*, which do honour levels there.

**Precisely when that bites is worth stating, because the obvious reading
overstates it** (caught in review). Today a shared row leaves `reasoningEfforts`
absent, every harness falls back to its own vocabulary, and every answer is
already correct — Grok's is `[]`, Claude's is Claude's. The per-model field is
not wrong; it is simply not the thing carrying that case. The insufficiency
appears the moment Grok's vocabulary becomes **non-empty**: a shared row then
has no value that is right for all four harnesses at once — `[]` strips levels
from the three that have them, and absent leaks Grok's four onto rows where the
flag is dropped.

That is the whole argument for why the vocabulary and the harness×mode axis have
to land in the *same* change, and why writing the four levels down now — with
the mechanism looking finished — would be the actual mistake.

**The axis that actually holds the fact is harness × billing mode**, because
that is where the real gate is — the CLI honours the flag when the *subscription
catalogue* authenticated it, whatever the model. So the composition is three
facts, not one:

| fact | lives on | example |
|---|---|---|
| the vocabulary and its labels | harness | grok: xhigh/high/medium/low |
| which billing modes honour it | harness × mode | grok: `sub` only |
| which of them a row offers | model row | grok-4.5 lacks `xhigh` |

**What shipped, and what deliberately did not.** `ModelDef.reasoningEfforts`
and `reasoningOptionsFor()` are in place and tested — the per-row narrowing, the
`[] ≠ absent` distinction, and the build-breaking invariant that a row may only
narrow its harness's vocabulary. Grok's `reasoning.options` stays **`[]`**,
which remains the honest answer while every selection it can run is key-billed,
and the vocabulary lands with the subscription mode and the harness×mode axis
together. Declaring the four levels first would have put dead controls on every
gateway row Grok shares.

`reviewer-model.test.ts`'s guard was rewritten in the same change to ask
`reasoningOptionsFor` across a harness's real catalogue rows rather than reading
`capabilities.reasoning.options`. It had been passing only because Grok's
vocabulary happened to be empty *too* — so the moment the vocabulary was written
down it stopped protecting anything, which is exactly what it did.

## Subscription mode, end to end (planning#435, reqs 10–18)

The launch integration was key-billed only because no ShipIt surface could sign
in. Three things had to land in ONE change, and the reason is a guard rather
than taste: `catalogue.test.ts` refuses a `LoginIntegrationId` no auth manager
implements, so declaring the mode without the manager would have offered a
subscription nothing could sign into, and giving the harness an `account` target
without the mode would have offered nothing at all.

### What the credential file actually is

Verified by reading a real one after a completed device-code login (2026-08-19).
Three details were each guessed wrong first, and every one of them fails
**silently**:

| guess | reality |
|---|---|
| a scope key one could name | `https://auth.x.ai::<client-uuid>` — unguessable, so the reader walks the top-level objects |
| `access_token` | **`key`**, a JWT, with `refresh_token` beside it |
| a numeric `expires_at` | an ISO-8601 **string**, `2026-08-19T19:37:53.982150334Z` |

The third is the dangerous one. A freshness reader that cannot parse the expiry
returns null, and **null does not fail safe here**: `syncAgentTokenIn` skips its
copy only when it can *prove* the session's token is at least as fresh, so an
unreadable expiry makes every sync copy unconditionally — and a session that had
just refreshed loses its live token to a stale source. The reader now takes ISO
first, then a numeric expiry, then the access token's own JWT `exp` claim (which
advances on every refresh and so is a real freshness signal, not a consolation
prize).

`create_time` → `expires_at` is exactly **six hours**, which is where req 13's
premise is measured rather than inherited.

### No plan, and that is a finding

xAI reports no plan name anywhere: not in the file (`principal_type: "User"`,
`auth_mode: "oidc"`) and not in the token, whose only tier-shaped claim is
`tier: 1` — an opaque integer with no published mapping. So the account row
shows the identity xAI does report (`email`, keyed on `user_id`) and says
nothing about the plan, and req 15 was reworded to match. Same rule as req 16's
missing usage API: an honest absence beats a plausible fabrication, and this row
is exactly where a fabrication would do damage, since its job is telling two
subscriptions apart.

### The scrub the routed path could not reach

An account-delivered credential carries **no `serviceRouting`** —
`serviceRoutingForSelection` returns nothing for one, because a login IS the
vendor's own and its token exchange is bound to the vendor's own endpoint. So
the adapter's existing scrub, gated on `params.serviceRouting`, never ran for a
subscription turn.

Meanwhile the worker is handed every stored service credential regardless of
which route the turn is pinned to (`collectServiceCredentialEnv`), and grok
prefers `XAI_API_KEY` over its on-disk login. On any install that had ever saved
an xAI key — which is every dogfood install, by design — every "subscription"
turn would have been billed to that key while ShipIt attributed it to the
account. A silent mis-billing, with nothing wrong on screen.

The gate is the auth **file**, not a scoped home. `resolveHome` is undefined
inside a container (the image symlinks `~/.grok` at the per-session credentials
mount instead), so Claude's scoped-home test would be false on the one path that
matters most. This is the Codex adapter's rule — delete the env key when file
auth wins — reached from the same direction.

### The harness×mode axis, and why the row field could not carry it

`ModelDef.reasoningEfforts` shipped earlier and is right for what it does; the
section above records why it is not sufficient. The composition is now three
facts, and `reasoningOptionsFor` is the single entry point:

| fact | lives on | grok |
|---|---|---|
| the vocabulary and its labels | harness `capabilities.reasoning.options` | xhigh/high/medium/low |
| which billing modes send it | harness `capabilities.reasoning.billingModes` | `["sub"]` |
| which of them a row offers | `ModelDef.reasoningEfforts` | 4.5 lacks `xhigh` |

Every consumer that validated or derived a level now asks the SELECTION:
`reviewer-model.ts`'s `defaultEffortFor`, `reviewer-settings.ts`'s pin
validator, `roles.ts`'s role validator, and both edges of docs/275's explicit
spawn target. The last needed one extra helper —
`harnessSendsReasoningEffort(harness, mode)` — because the parse edge has to say
whether `--effort` is part of a complete call before it knows there is a valid
model, and falling back to the vocabulary there would demand a level on a
key-billed grok call.

`REVIEWER_DEFAULT_EFFORT.grok` becomes `high` (a level both subscription rows
offer). It stops being `null`, which the previous guard test predicted would
happen and said it *should*.

### What was verified live, and what was not

Verified in the dogfood instance on 2026-08-19, with a real SuperGrok login:

- **Sign-in inside ShipIt** (req 11) — *Add a service → xAI* offers
  **Subscription · API key**; choosing Subscription renders the device-code
  challenge with URL, code and both models; approving it in the browser
  completed the flow (`✓ Signed in as …`, exit 0) and produced a connected
  account row labelled with the reported email.
- **The `carriers` restriction, both directions** — the support matrix reads
  "Grok Build runs xAI" while Codex and OpenCode read "API key only", and
  ChatGPT's subscription is still withheld from Grok ("API key only" on the
  OpenAI row). Without it the style join would have offered a ChatGPT
  subscription to the grok CLI.
- **The billing route** (the last docs/274 auth-mode gap) — one turn on
  `xai/sub` `grok-4.6`, attributed to `xai:sub` with `includedTurns: 1`,
  `meteredCostUsd: 0` and an `atApiRatesUsd` "would have cost" figure. The
  adapter logged `subscription login on disk — env credentials scrubbed`, with
  `XAI_API_KEY` present in the environment.
- **The level at the wire** (req 14) — the CLI's own session store for that turn
  records `reasoning_effort: "xhigh"`, alongside a non-zero `reasoningTokens`.

**Not** verified by that run, and worth stating rather than implying: the
per-turn token sync. The dogfood instance is `RUNTIME_MODE=local`, which points a
spawn's HOME straight at the account root and keeps **no per-session credential
copy** — the CLI wrote its session state into the account directory itself. So
req 13's machinery is covered by unit tests against the real file shape
(`session-credentials.test.ts`), not by that turn, and the container path is
where it first runs for real.

### What the independent review caught, and why it was the right question to ask

The brief for the out-of-family reviewer led with "did I miss a consumer of the
new axis?", because a missed one is invisible: it renders a control that does
nothing, or refuses a pin that is valid. It had found five, and four were real.

Every one was a place validating a level against the harness's **vocabulary**
rather than against the selection — harmless while grok's vocabulary was empty,
and live the moment it was written down:

- **`route-registry.ts`, three sites.** WS connect rehydrating a session's
  stored level; `set_model`'s self-heal when a model change crosses a harness;
  and the `set_reasoning` handler itself. The first is the worst of them, since
  it *persists* the reconciled value — a session would carry a level its every
  turn discarded, written back as a preference.
- **`model-switch.ts`'s `conformSelectionToAgent`.** A level carried across a
  harness switch onto a key-billed grok row survived AND reported
  `reasoningCleared: false`, so the move notice stayed silent about a setting
  that had stopped meaning anything.
- **`spawn-inventory.ts`** completed `--effort` from the vocabulary while
  `parseSubAgentSpawnTarget` refused the result — tab completion offering a flag
  the run rejects.

Two of the fixes needed a correction the first attempt got wrong, and the shape
is worth recording because it recurs: **asking `reasoningOptionsFor` INSTEAD of
the injected capabilities is not the same as asking it as well.** Both
`conformSelectionToAgent` and `listSpawnParameters` take an injected registry,
and replacing the vocabulary check with a catalogue lookup silently made the
caller's own declaration irrelevant — which two fixture-based tests caught. The
correct rule in both is the conjunction: the harness must declare the level AND
the landing row must send it.

The review also raised a real hole in the adapter's fallback path: when
`makeSpawnHome` cannot reach the shared config root, `spawnHomeHasAuth` stays
false, so the subscription scrub does not fire and an ambient `XAI_API_KEY`
would authenticate the turn while ShipIt attributed it to the account. It needs
two unlikely states at once (a broken credential root *and* a stored key), which
is exactly why it now logs explicitly rather than being left to be inferred from
the resume warning beside it.

### Deliberately not built: a proactive refresher

Claude and Codex each own an orchestrator-side OAuth refresher (docs/153,
docs/154) that keeps the SOURCE token fresh between turns and stops N sessions
stampeding one token endpoint. Grok gets no equivalent here, and the reason is
that the need is **not measurable yet** rather than that it was judged absent:
the token lives six hours, so whether the CLI's refresh rotates the refresh
token — the property that makes a stampede destructive — cannot be observed
without waiting for an expiry. The per-turn sync path is what req 13 asks for and
is complete on its own terms; the stampede hazard is a separate question, and
the honest answer today is that it is open. `grok models` is the obvious tier-1
probe if one is written, mirroring `codex login status`.

## The reviewer-default extension (req 8)

Grok is the first harness declaring **no** reasoning levels, and
`reviewer-model.test.ts` asserted that every harness offers some. Nik chose to
extend the mechanism rather than invent a level (receipt in requirements.md).
The extension, end to end:

- `REVIEWER_DEFAULT_EFFORT` becomes `Record<AgentId, string | null>`, where
  `null` means "this harness has no levels to choose from". **`null`, not an
  omitted key**, so the record stays exhaustive and the next harness added still
  gets a compile error instead of inheriting a default nobody chose.
- `reasoningEffort` becomes optional on `ReviewerPin`, `ReviewerResolved`,
  `ReviewerTarget`, `RolePinnedParams`, `RoleResolved`, `ResolvedSpawnTarget`
  and the consult card's `SubAgentRunTarget`. Absent means "this harness has no
  level", never "nobody chose one" — a type cannot say "required iff a sibling
  field's harness declares levels", so both halves are enforced in
  `reviewer-settings.ts` and `roles.ts`: naming a level on a levelless harness
  is still refused, and omitting one on a harness that has them is still an
  incomplete pin.
- The guard test splits accordingly: a harness with levels is checked exactly as
  before, and one without must say so with `null`.

Req 5's "a derived reviewer is COMPLETE" is intact — a levelless harness's
reviewer names everything there is to name, which is one field fewer. What req 5
forbids is leaving a real choice to the CLI's own default, and there is no
choice here to leave.

**One deliberate limitation — since lifted.** `SpawnTarget`'s `explicit` kind
required all five parameters including the level, so a fully-explicit
`shipit agent run` naming Grok could not be assembled; the Phase 10 run
(2026-08-18) recorded it as the structural blocker on "`shipit agent run` both
directions". docs/275-roleless-explicit-run (planning#441) made completeness
per-harness: the four identity flags are a complete Grok target, and `--effort`
on it is refused by name — the explicit path now mirrors the role rule req 8
established. If subscription mode turns out to have real levels (planning#435),
`--effort` becomes part of a complete Grok target with nothing further to
change.
