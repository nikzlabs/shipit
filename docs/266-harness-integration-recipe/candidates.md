# Candidate assessment: Cursor CLI, Grok Build, OpenCode, Antigravity CLI

Assessed 2026-08-15 against the Phase 0 checklist in [plan.md](./plan.md)
(req 5); the Antigravity CLI column was added 2026-09-13 from a live probe
of the 1.2.2 binary (see its section). This updates the older survey rows in
`docs/252-custom-models/catalogue.md` (notably: Cursor's binary is now
`agent`, not `cursor-agent`, and Grok Build now exists). All vendors
ship fast; re-verify against `--help` output when integration starts. Items
marked *(third-party)* come from community references, not vendor docs;
items marked *(probed)* were observed on the named binary in a session
container.

## Assessment matrix

Explicit outcome per Phase 0 item: ✅ documented by the vendor, ⚠️ partial
or caveated, ❌ absent, ❓ unknown — an unknown is an open research item,
and on items 2, 5, 6, and 12 it is a start-blocker per plan.md's blocker
semantics, not a shrug.

| Phase 0 item | Cursor CLI | Grok Build | OpenCode | Antigravity CLI |
|---|---|---|---|---|
| 1. Headless mode | ✅ `-p` | ✅ `-p` | ✅ `run` | ✅ `-p` *(probed)* |
| 2. Streaming schema | ✅ documented NDJSON | ❓ undocumented — capture + conformance test required | ⚠️ documented but coarse; loss bugs (see verdict) | ✅ documented NDJSON, 3 event types *(probed)* |
| 3. Session resume | ✅ | ✅ | ✅ | ✅ `--conversation <id>`, id in `init` *(probed)* |
| 4. Full-auto permissions | ✅ `--force` + allow/deny | ✅ `--always-approve` + modes | ✅ `--auto` + config | ✅ `--dangerously-skip-permissions` + allow list *(probed)* |
| 5. Auth injectable | ⚠️ key env ✅ / subscription ❓ (path undocumented) | ✅ `~/.grok/auth.json`; device-auth *(third-party)* | ✅ plain file; ❌ no Anthropic subscription | ⚠️ key env ✅ *(probed)* / account ❓ keyring-only; file fallback broken upstream (see verdict) |
| 6. Pinnable install | ❌ none documented — policy gate | ⚠️ pinned install script *(third-party)* | ✅ npm exact | ✅ versioned GitHub release tarball; ❌ no npm |
| 7. Instructions | ✅ AGENTS.md/CLAUDE.md | ✅ AGENTS.md | ✅ AGENTS.md | ✅ AGENTS.md/GEMINI.md + plugin `rules/`; ❌ no flag |
| 8. MCP | ✅ `mcp.json` | ✅ `config.toml` | ✅ `opencode.json` | ✅ `~/.gemini/config/mcp_config.json` *(probed)* |
| 9. Skills disclosure | ❓ empirical, untested | ❓ empirical, untested | ❓ empirical, untested | ❓ `.agents/skills/` + `skills.json` paths, untested |
| 10. Token telemetry | ❌ none in result event | ❓ claimed in stream, schema unverified | ✅ per-step tokens + cost (verify overlap) | ✅ `usage` in `result` *(probed)* |
| 11. API style to redirected endpoint | ❓ (service-fused; likely none) | ❓ | ❓ (many claimed) | ❌ Gemini `generateContent` — no `ApiStyle` for it yet |
| 12. Reasoning control | ❓ | ❓ | ⚠️ `reasoningEffort` config *(per docs/252 survey)* | ✅ `--effort low\|medium\|high` |
| 13. Remaining capability flags | ❓ empirical | ❓ empirical | ❓ empirical | ❓ empirical; compaction ❌ structural |

Row 12 matters more than it looks: a harness that turns out to have *no*
reasoning levels hits the `reviewer-model.test.ts` constraint (plan.md
Phase 0.12) and needs a reviewer-default design decision before any recipe
step. Rows 9 and 13 are empirical-by-design for every candidate — they are
Phase 10 verification work, not desk research.

## Cursor CLI

- **Binary / install**: `agent` (renamed from `cursor-agent`);
  `curl https://cursor.com/install -fsS | bash` into `~/.local/bin`. No npm
  package. Auto-updates by default (`--disable-auto-update` exists); **no
  documented way to pin a version** — the weakest fit with the exact-pin
  dependency policy. Image strategy: bake the binary, disable auto-update.
- **Headless**: `agent -p "prompt" --output-format stream-json --force`.
  Without `--force` print mode only *proposes* edits, so `--force` (or an
  allow-list) is mandatory. `--workspace`, `--trust`, `--mode plan|ask`.
- **Streaming**: NDJSON with documented events — `system/init` (carries
  `session_id`, `model`, `permissionMode`), `user`, `assistant`, `tool_call`
  (`started`/`completed` subtypes), terminal `result`
  (`is_error`, `duration_ms`, `result`, `session_id`).
  `--stream-partial-output` adds text deltas. **No token-usage field in the
  result event** — usage display would need Cursor's dashboard/API.
- **Sessions**: `--resume [chatId]`, `--continue`, `agent create-chat`
  (pre-allocates an id).
- **Auth**: browser OAuth (`agent login`; `NO_OPEN_BROWSER=1` prints the
  URL) or `CURSOR_API_KEY`. **Credential file path undocumented** —
  subscription injection into a container is a reverse-engineering exercise;
  the env key works trivially but is metered. Cursor is service-fused (its
  own backend; no endpoint override) — the `(harness, service)` fused-pair
  question docs/252 left open.
- **Instructions / MCP / permissions**: reads `AGENTS.md` and `CLAUDE.md` +
  `.cursor/rules/`; editor-compatible `mcp.json` (`--approve-mcps` for
  headless); `permissions.allow/deny` over `Shell()`/`Read()`/`Write()`/
  `WebFetch()`/`Mcp()` tokens in `cli-config.json`, deny wins; own
  `--sandbox` flags.
- **Verdict**: protocol-wise the easiest — the surface closely parallels
  Claude Code (Claude-shaped adapter). But on the recipe's own blocker
  semantics, **integration is blocked until the pinning question is
  settled**: baking the binary into the image freezes one build, it does
  not make *acquisition* exact or reproducible, so starting requires either
  a pin-capable distribution path from Cursor or an explicitly signed-off
  exception to the dependency policy. Subscription credential storage being
  undocumented is the second start-blocker (item 5) unless metered API-key
  auth is accepted for launch, and the unknown reasoning control (row 12)
  is a third — it gates the reviewer wiring (plan.md Phase 0.12).

## Grok Build (xAI)

"Grok Build" is the real product name — announced 2026-05-25, early beta,
gated to SuperGrok / X Premium Plus subscribers. Older community "grok-cli"
projects are unrelated.

- **Binary / install**: `grok`; `curl -fsSL https://x.ai/cli/install.sh |
  bash`; the script accepts a pinned version *(third-party)*. 0.x cadence —
  expect churn.
- **Headless**: `grok -p "prompt" --output-format streaming-json
  --always-approve`; `-m` model, `--cwd`, `--json-schema` for a constrained
  final answer.
- **Streaming**: `plain | json | streaming-json`. **The streaming-json event
  schema is not publicly documented** (docs show only an ACP-style
  `session/update` example; ACP is offered as an alternative interface).
  Schema capture + a conformance test are a mandatory part of the
  integration (plan.md Phase 0.2, step 10).
- **Sessions**: under `~/.grok/sessions/`, keyed by working directory;
  `-s/--session-id`, `-r/--resume <id>`, `-c/--continue`; official pattern
  is to read the session id from JSON output.
- **Auth**: OAuth 2.1 + PKCE (`grok login`), **`--device-auth` for
  containers** *(third-party)*; tokens in `~/.grok/auth.json` (0600) —
  injectable, known path. API key via `XAI_API_KEY`. Beta-gated
  subscription.
- **Instructions / MCP / permissions**: reads `AGENTS.md` natively;
  MCP in `~/.grok/config.toml` / project `.grok/config.toml`
  (`[mcp_servers]`, stdio + HTTP); Claude-Code-style `--permission-mode`
  and `--allow`/`--deny` rules plus `--always-approve`.
- **Verdict**: deliberately Claude-flag-compatible (Claude-shaped adapter),
  but the matrix shows four unknowns — stream schema, token telemetry,
  reasoning control, API style — of which the stream schema (item 2, until
  captured and conformance-tested) and reasoning control (row 12, gating
  the reviewer wiring) are start-blockers. Add the
  third-party sourcing of most flag detail, beta subscription gating, and
  0.x churn: the fact sheet is promising but not yet integration-ready
  evidence.

## OpenCode

> **Shipped** — integrated as ShipIt's third harness via this recipe; see
> [docs/268-opencode-harness](../268-opencode-harness/plan.md) for the
> live-verified findings that supersede this desk research. All matrix
> unknowns resolved there: reasoning control exists (`--variant`, `high` as
> the reviewer default — row 12 never blocked), token figures are disjoint
> (no normalizer needed), both API styles wire-verified, and the stream's
> real failure mode is *error-then-hang* plus buffered-stdout loss — the
> synthesized-terminal-result criterion held, with an added rule that the
> adapter kills the process on a fatal `error` event.

- **Binary / install**: `opencode`; **npm `opencode-ai`**, exact-pinnable —
  the best fit with the existing npm-lockfile install pipeline. Open source
  (repo now `anomalyco/opencode`). Extremely fast release cadence
  (every few days) — frequent deliberate bumps.
- **Headless**: `opencode run "prompt" -m provider/model --format json
  --auto`; or **`opencode serve`** + `run --attach <url>` — a long-lived
  server with a full HTTP API and SDK, avoiding MCP cold-boot per turn.
  This rewards a third adapter shape (attach-to-server) that fits ShipIt's
  HTTP-only orchestrator↔container pattern — but per plan.md, the *first*
  integration takes the proven spawn-per-turn shape; attach-to-server is a
  separate design task, not a recipe variant.
- **Streaming**: JSONL — `step_start` → (`tool_use` | `text`)* →
  `step_finish` (+ `error`), `sessionID` on every event. Coarser than
  Claude/Cursor: **no tool-started events**, whole-block text (no deltas).
  `step_finish` carries `part.cost` and full disjoint-looking
  `part.tokens.{input,output,reasoning,cache.read,cache.write}` — verify
  overlap semantics before skipping a normalizer. Known container-specific
  event-loss bugs upstream (dropped `text`/`step_finish`; exit before final
  `step_finish`) — the adapter must tolerate a missing terminal event.
- **Sessions**: `-c/--continue`, `-s/--session <id>`; fully addressable over
  the `serve` HTTP API.
- **Auth**: `opencode auth login`; plain-file store at
  `~/.local/share/opencode/auth.json` — trivially injectable. Per-provider
  API keys via config `{env:...}` references; ChatGPT Plus/Pro OAuth and
  Copilot device-code supported. **Anthropic subscription login was removed
  upstream (v1.3.0; Anthropic prohibits it)** — Anthropic models are
  API-key/metered only, so ShipIt's subscription-first default only applies
  to its ChatGPT/Copilot-backed models. `-m provider/model` raises the
  docs/252 open question of how a `serviceId` maps to OpenCode's provider
  namespace — settle it in the catalogue row, not the adapter.
- **Instructions / MCP / permissions**: `AGENTS.md` (walking up) with
  `CLAUDE.md` fallback; `instructions` array in `opencode.json`; MCP under
  the `mcp` key (local + remote with OAuth); `permission` allow/ask/deny per
  tool with glob bash rules, and `run --auto` for full-auto.
- **Verdict**: easiest overall — pinnable, open source, plain-file auth,
  documented permissions, and the serve API option. Costs: coarse event
  stream with known loss bugs, fast-churn version bumps, and no Anthropic
  subscription path. The loss bugs don't fail Phase 0 item 2, but only
  under an explicit conformance criterion the adapter must meet: **treat
  process exit as the synthesized terminal result** (exit code + last
  captured state) whenever the final `step_finish` never arrives, and lock
  that behavior with a test — the same "every terminal path commits" shape
  ShipIt already applies to crashed agents.

## Antigravity CLI (Google)

`agy`, Google's terminal harness for the Antigravity platform (Antigravity
2.0, I/O 2026); positioned as the successor of the open-source Gemini CLI
for consumer users. **Closed source**, proprietary, free during preview.
Assessed 2026-09-13 by downloading release 1.2.2 into a session container
and running it headless with an invalid `GEMINI_API_KEY`; every *(probed)*
item below is observed output of that binary.

- **Binary / install**: `antigravity` (installed as `agy`), a ~213 MB Go
  binary. `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  fetches a *latest-only* manifest; but every GitHub release carries
  per-platform assets
  (`releases/download/<version>/agy_cli_linux_x64.tar.gz`, `_arm64` too),
  so the install is exact-pinnable — outside the npm pipeline, like the
  Cursor decision docs/266 plan.md Phase 3 anticipates. Daily 1.x releases.
  Runs an update check (`updater/update.lock`, `last_check.timestamp`); no
  disable flag in `--help`, an `AutoUpdate` settings key exists in the
  binary, unverified.
- **Headless**: `agy -p "prompt" --output-format stream-json
  --dangerously-skip-permissions`; `--model <id>`, `--effort
  low|medium|high`, `--mode accept-edits|plan`, `--json-schema`,
  `--print-timeout` (default 5 m), `--add-dir`, `--sandbox`. `-p` takes
  the prompt as its value, so a resident driver spawns
  `--print='' --input-format stream-json --output-format stream-json` and
  writes `{"event":"user","message":{"content":"…"}}` lines to stdin — one
  turn per line, one process, one conversation *(probed)*. Slash commands
  expand in print mode unless `--disable-slash-commands`.
- **Streaming**: documented NDJSON, three events *(probed)*: `init`
  (`conversation_id`, `cwd`, `tools[]`, `permission_mode`), `step_update`
  (`step_index`, `step_type` — `user_input`, `error_message`,
  `system_message`, tool steps —, `state` ACTIVE/DONE, `text_delta`,
  `tool_info`), terminal `result` (`status` SUCCESS/ERROR/CANCELED/…,
  `response`, `error`, `num_turns`, `usage.{input,output,thinking,
  cache_read,total}_tokens`). Errors are mirrored to stderr. Exit 0 on
  success, 1 on an agent error, 2 on malformed input.
- **Sessions**: `--conversation <id>` resumes; an unknown id warns and
  starts a new one *(probed)*. Store is `~/.gemini/antigravity-cli/
  conversations/<id>.db` plus a `brain/<id>/` transcript tree. Nothing was
  written into the workspace during a print run *(probed)*.
- **Auth**: two paths; the account path is unproven in a container.
  - *Metered key*: `GEMINI_API_KEY` + `{"modelProvider":"gemini"}` in
    `~/.gemini/antigravity-cli/settings.json`. Verified live: the request
    reached `generativelanguage.googleapis.com` and came back
    `API_KEY_INVALID` *(probed)*. The older upstream issues #78/#223 saying
    key auth is unsupported predate 1.1.13 and are stale.
    `GOOGLE_GEMINI_BASE_URL` overrides the endpoint. An `AGY_ADC_AUTH`
    (Application Default Credentials) mode also exists in the binary,
    unverified.
  - *Account*: Google OAuth into the **OS keyring** (Secret Service /
    D-Bus). The file fallback `~/.gemini/antigravity-cli/
    antigravity-oauth-token` is write-only in containers per upstream
    #479 (open, reported on 1.0.10; not re-verified on 1.2.2 — needs a real
    login). Settling it takes either a fixed fallback in a newer release or
    a Secret Service daemon inside the session container.
  - *Terms*: the Antigravity Additional Terms of Service §6 state *"Using
    third party software, tools, or services to access the Service (e.g.
    using OpenClaw with Antigravity OAuth) is a breach of this Agreement"*.
    The example is a third-party **client** that takes the OAuth token and
    calls the backend itself (OpenClaw; the `opencode-antigravity-auth`
    plugin). ShipIt spawns Google's own `agy`, which stays the only client
    of the Service — the same shape as ShipIt's Claude Code subscription
    use, and Google documents headless mode for scripts and CI. The same
    section also lists *"using the Service in connection with products not
    provided by us"*, which read literally would cover a CI runner too; how
    far that reaches is a reading for the user, not the agent.
  - No env var relocates the config home; the scoped-home mechanism must
    set `HOME`, which the Claude/Codex adapters already do.
- **Instructions / MCP / permissions / hooks**: no system-prompt flag.
  Rules load from `GEMINI.md`/`AGENTS.md` walking up from cwd, and from
  `rules/AGENTS.md` inside a plugin at `~/.gemini/antigravity-cli/plugins/
  <name>/` (`plugin.json` marker; may also carry `mcp_config.json`,
  `hooks.json`, `skills/`). A ShipIt-written plugin in the scoped home is
  the injection path for prompt + MCP + skills without touching the repo.
  Global MCP config `~/.gemini/config/mcp_config.json` (`mcpServers`,
  stdio + `serverUrl`) is picked up by `agy mcp list` *(probed)*; MCP tools
  do **not** appear in `init.tools` — they are reached through one
  `call_mcp_tool` wrapper, which changes the tool-activity mapping.
  Permission modes: `toolPermission` request-review | proceed-in-sandbox |
  strict | always-proceed, plus `permissions.allow` patterns
  (`command(git)`, `write_file(src/)`). In print mode a tool needing
  approval is *soft-denied* and the run continues; there is no
  permission-prompt MCP tool. The documented `PreToolUse` hook returns
  `allow`/`deny`/`ask` synchronously (30 s default timeout), which is the
  candidate mechanism for ShipIt's guarded mode. Built-in tools include a
  browser suite, `search_web`, `generate_image`, subagents
  (`define_subagent`/`invoke_subagent`) and `run_command`.
- **Models / compaction / review**: `agy models` lists
  `gemini-3.8-flash-{high,medium,low}` … `gemini-3.1-pro-{high,low}` for
  the key provider *(probed)*; Claude and GPT-OSS backends are
  account-only per vendor docs. Compaction is automatic
  (`NewContextSummaryHook` in the binary) with no user command — item 14
  is structural ❌. Review primitives (shell + subagent) exist; item 15
  needs the depth-0 probe. Native ACP is requested upstream (#31, open);
  community `agy-acp` bridges exist.
- **Verdict**: technically the closest match to the Claude-shaped recipe of
  any candidate — documented stream, id-addressed resume, full-auto flag,
  effort levels, token usage, pinnable release asset, and a plugin
  mechanism that carries prompt, MCP and skills from the scoped home. Two
  things stand in front of any recipe step:
  1. **Account auth is unproven in a container** — keyring-only storage
     and a file fallback reported write-only (#479). Until a real login on
     a current release proves the token survives a fresh process (or a
     Secret Service daemon is added to the session image), integration
     would be **metered `GEMINI_API_KEY` only**, which inverts ShipIt's
     subscription-first default and needs a sign-off. The terms are not
     the blocker: ShipIt runs Google's own CLI, which is the client the
     §6 example permits; only the broad "in connection with" phrase is
     left to the user's reading.
  2. **A new vendor row**: Gemini's `generateContent` wire format is not an
     `ApiStyle`, and docs/272-opencode-inference already notes Gemini
     models are unrepresentable without one — so a Google service +
     fourth style lands in the catalogue before the harness row.
  Lesser costs: a non-npm binary in the image, a `call_mcp_tool` wrapper
  that hides MCP tool names from the stream, and PreToolUse hooks as the
  only guarded-mode mechanism (unprobed against a live model).

## Cross-cutting

- Cursor, Grok and Antigravity imitate Claude Code's flag surface →
  Claude-shaped spawn-per-turn adapters. OpenCode is the outlier rewarding
  attach-to-server.
- The facts most likely to force design decisions: Cursor's unpinnable
  auto-updating install, Grok's undocumented stream schema, and — for both
  of those two — the unanswered reasoning-control row (12), which gates
  the reviewer wiring.
- Suggested order by integration risk (lowest first): OpenCode, then
  Cursor and Grok — each of which carries a start-blocker to clear first
  (Cursor: the pinning policy decision; Grok: stream-schema capture).

## Sources

Cursor: cursor.com/docs/cli — installation, headless, reference/parameters,
reference/output-format, reference/authentication, reference/permissions,
mcp, changelog. Grok: x.ai/news/grok-build-cli, docs.x.ai/build/cli/
headless-scripting, docs.x.ai/build/features/sessions; *(third-party)*
grok-wiki.com, aiidelist.com cheatsheet, codersera.com and mer.vin guides.
OpenCode: opencode.ai/docs — cli, rules, permissions, mcp-servers,
providers; npmjs.com/package/opencode-ai; takopi.dev stream-json cheatsheet;
github.com/anomalyco/opencode issues #31435, #26855.
Antigravity: antigravity.google/docs/cli — headless, install, reference,
features; antigravity.google/terms (Additional Terms of Service §6);
github.com/google-antigravity/antigravity-cli releases and issues #7, #31,
#78, #223, #479; the binary's own `builtin/skills/agy-customizations/docs/`
(rules, skills, plugins, mcp_servers, hooks, json_configs) as shipped in
1.2.2; `agy --help`, `agy models`, `agy mcp list` output on 1.2.2.
