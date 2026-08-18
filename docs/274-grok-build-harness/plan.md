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
  exact-pinnable, and its shape is exactly OpenCode's: platform binaries as
  `optionalDependencies` (`@xai-official/grok-linux-x64`, …) with a
  `postinstall` shim (`node bin/postinstall.js`), so under the installer's
  blanket `--ignore-scripts` it needs a targeted **`npm rebuild
  @xai-official/grok`** — the already-solved exception shape (recipe step 3).
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

### Still pending (the Phase 0 remainder)

5. **Session resume, `-s` pre-assignment, `--max-turns`, images, AGENTS.md
   reading, skills disclosure probe** — live behavior.
6. **Auth.json injection**: verify a pasted/injected `auth.json` (or
   `GROK_AUTH_PATH`) authenticates a headless turn in a fresh container, and
   what identity/plan surfaces for `provider-account-identity.ts`.

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

## Catalogue row, install design, adapter design

Deferred until the pending items above are captured — written here before
any implementation code, per the recipe order.
