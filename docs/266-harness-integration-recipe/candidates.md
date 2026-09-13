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
| 5. Auth injectable | ⚠️ key env ✅ / subscription ❓ (path undocumented) | ✅ `~/.grok/auth.json`; device-auth *(third-party)* | ✅ plain file; ❌ no Anthropic subscription | ✅ key env reaches Google *(probed, invalid key)* / account: plain token file, read back by a fresh process on a copied home *(probed once)* |
| 6. Pinnable install | ❌ none documented — policy gate | ⚠️ pinned install script *(third-party)* | ✅ npm exact | ⚠️ exact acquisition ✅ (versioned GitHub release tarball); ❌ no npm; auto-updater spawns on every run, no disable found *(probed)* |
| 7. Instructions | ✅ AGENTS.md/CLAUDE.md | ✅ AGENTS.md | ✅ AGENTS.md | ✅ AGENTS.md/GEMINI.md + plugin `rules/`; ❌ no flag |
| 8. MCP | ✅ `mcp.json` | ✅ `config.toml` | ✅ `opencode.json` | ✅ `~/.gemini/config/mcp_config.json` *(probed)* |
| 9. Skills disclosure | ❓ empirical, untested | ❓ empirical, untested | ❓ empirical, untested | ❓ `.agents/skills/` + `skills.json` paths, untested |
| 10. Token telemetry | ❌ none in result event | ❓ claimed in stream, schema unverified | ✅ per-step tokens + cost (verify overlap) | ✅ `usage` in `result` *(probed)* |
| 11. API style to redirected endpoint | ❓ (service-fused; likely none) | ❓ | ❓ (many claimed) | ❌ no ShipIt `ApiStyle` for Gemini `generateContent`; endpoint override `GOOGLE_GEMINI_BASE_URL` per vendor docs, unprobed |
| 12. Reasoning control | ❓ | ❓ | ⚠️ `reasoningEffort` config *(per docs/252 survey)* | ✅ `--effort low\|medium\|high` |
| 13. Remaining capability flags | ❓ empirical | ❓ empirical | ❓ empirical | ❓ empirical; compaction ❓ resumed `/compact` unprobed |

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
2.0, I/O 2026), positioned as the successor of the open-source Gemini CLI
for consumer users. **Closed source**, proprietary, free during preview.
Assessed 2026-09-13 on release 1.2.2 in a session container: headless runs
with an invalid `GEMINI_API_KEY`, then one real Google sign-in. Every
*(probed)* item is observed output of that binary, observed once.

- **Binary / install**: `antigravity` (installed as `agy`), a ~213 MB Go
  binary. The vendor's `install.sh` reads a *latest-only* manifest, but
  every GitHub release carries per-platform assets
  (`releases/download/<version>/agy_cli_linux_{x64,arm64}.tar.gz`), so
  acquisition is exact-pinnable outside the npm pipeline (plan.md Phase 3's
  Cursor case). Daily 1.x releases. **Auto-updater**: every run spawns a
  background update process (`auto_updater.go` in the CLI log,
  `updater/update.lock`) *(probed)*; `--help`, `update --help` and the
  settings keys compiled into the binary expose no switch. Phase 0.6
  requires it disabled for a curl-installed binary, so item 6's runtime
  half is open; a read-only, root-owned install path is the obvious
  mitigation, unverified.
- **Headless**: `agy -p "prompt" --output-format stream-json
  --dangerously-skip-permissions`; `--model <id>`, `--effort
  low|medium|high`, `--mode accept-edits|plan`, `--json-schema`,
  `--print-timeout` (default 5 m), `--add-dir`, `--sandbox`,
  `--disable-slash-commands` (they expand in print mode). `-p` takes the
  prompt as its value, so a resident driver spawns `--print=''
  --input-format stream-json --output-format stream-json` and writes
  `{"event":"user","message":{"content":"…"}}` lines to stdin — one turn
  per line, one process, one conversation *(probed)*.
- **Streaming**: documented NDJSON, three events *(probed)*: `init`
  (`conversation_id`, `cwd`, `tools[]`, `permission_mode` — default
  `request-review`), `step_update` (`step_index`, `step_type`:
  `user_input`, `agent_response`, `system_message`, `error_message`, tool
  steps; `state` ACTIVE/DONE; `text_delta`; `tool_info`; per-step `usage`),
  terminal `result` (`status` SUCCESS/ERROR/CANCELED/…, `response`,
  `error`, `num_turns`, `usage.{input,output,thinking,cache_read,total}
  _tokens`). Errors mirror to stderr. Exit 0 success, 1 agent error, 2
  malformed input.
- **Sessions**: `--conversation <id>` resumes; an unknown id warns and
  starts a new one *(probed)*. Store: `~/.gemini/antigravity-cli/
  conversations/<id>.db` + `brain/<id>/` transcripts. A print run wrote
  nothing into cwd *(probed)*. No env var relocates the config home; the
  scoped-home mechanism must set `HOME`, as the Claude/Codex adapters do.
- **Auth — metered key**: `GEMINI_API_KEY` + `{"modelProvider":"gemini"}`
  in `~/.gemini/antigravity-cli/settings.json`; the request reached
  `generativelanguage.googleapis.com` and returned `API_KEY_INVALID`
  *(probed)* — key injection shown, not a completed inference. Upstream
  #78/#223 ("key auth unsupported") predate 1.1.13. `GOOGLE_GEMINI_BASE_URL`
  overrides the endpoint per the vendor's install page (unprobed);
  `AGY_ADC_AUTH` exists in the binary (unverified). Models offered:
  `gemini-3.8-flash-{high,medium,low}` … `gemini-3.1-pro-{high,low}`
  *(probed)*.
- **Auth — account**: Google OAuth into the OS keyring where one exists,
  else `~/.gemini/antigravity-cli/antigravity-oauth-token`. Upstream #479
  (reported on 1.0.10) says that file is write-only; **not on 1.2.2**
  *(probed, no D-Bus, no keyring daemon)*: print mode runs the sign-in
  itself (URL on stderr, code read from stdin, 60 s window), writes the
  token file (0600; keys `access_token`, `refresh_token`, `id_token`,
  `expiry`, `auth_method`, `token_type`), and a fresh `-p` process with
  stdin closed answered from that file — also on a **byte-copy of the
  home**, the shape of a scoped-home mount. So the credential is a plain
  file like Grok's `auth.json`; the recipe's "link the credential root as
  a directory, never the token file" rule applies (refresh rewrite not
  observed within the token's one-hour lifetime). Account auth adds
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`
  *(probed)*; third-party models fall under §8 of the terms.
- **Eligibility gate**: after the OAuth exchange the CLI asks Google an
  account-eligibility question and can refuse (observed: *"Eligibility
  check failed: Your current account is not eligible for Antigravity. To
  use Antigravity you must be 18 years old or older. If you think you are
  receiving this message in error, please ensure you have verified your
  age and try to log in again."*) — an `error:` stderr line, non-zero
  exit, token file still written. **User requirement (Nik, 2026-09-13):
  the adapter relays such text verbatim.** Today's path
  (`textIndicatesAuthFailure` in `session/agents/claude/process.ts` →
  `orchestrator/services/agent-auth-gate.ts`) pattern-matches stderr and
  substitutes generic copy that would hide the sentence naming the fix.
- **Terms**: Additional Terms of Service §6: *"Using third party software,
  tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach of this Agreement"*, and *"using the
  Service in connection with products not provided by us"* is listed as
  abuse. The user's reading (Nik, 2026-09-13): the example is a
  third-party **client** using the OAuth token directly (OpenClaw, the
  `opencode-antigravity-auth` plugin), whereas ShipIt would spawn Google's
  own `agy` as the only client — the shape of ShipIt's Claude Code
  subscription use; the "in connection with" phrase read literally covers
  a CI runner too. The section grants nothing expressly. Recorded here,
  decided by the user.
- **Instructions / MCP / permissions / hooks**: no system-prompt flag.
  Rules load from `GEMINI.md`/`AGENTS.md` walking up from cwd, and from
  `rules/AGENTS.md` inside a plugin at `~/.gemini/antigravity-cli/plugins/
  <name>/` (`plugin.json` marker; may also carry `mcp_config.json`,
  `hooks.json`, `skills/`; skills also from `.agents/skills/` and
  `skills.json` path entries). A ShipIt-written plugin in the scoped home
  is the vendor-documented *candidate* path for prompt + MCP + skills
  without touching the repo — loading unprobed. Global MCP config
  `~/.gemini/config/mcp_config.json` (`mcpServers`, stdio + `serverUrl`)
  is listed by `agy mcp list` *(probed)*; MCP tools do **not** appear in
  `init.tools`, they go through one `call_mcp_tool` wrapper (affects
  tool-activity mapping). Permissions: `toolPermission` request-review |
  proceed-in-sandbox | strict | always-proceed, plus `permissions.allow`
  patterns (`command(git)`, `write_file(src/)`); in print mode a tool
  needing approval is *soft-denied* and the run continues; no
  permission-prompt MCP tool. The documented `PreToolUse` hook returns
  `allow`/`deny`/`ask` synchronously (30 s default) — the candidate for
  guarded mode, unprobed. Built-in tools include a browser suite,
  `search_web`, subagents and `run_command`.
- **Compaction / review / ACP**: the binary carries an automatic
  context-summary hook and the reference lists no `/compact`, but Phase
  0.14 forbids concluding from that — item 14 stays unknown until
  `/compact` on a resumed headless session is measured. Review primitives
  (shell + subagent) exist; item 15 needs the depth-0 probe. Native ACP is
  requested upstream (#31); community `agy-acp` bridges exist.
- **Verdict**: the closest match to the Claude-shaped recipe of any
  candidate — documented stream, id-addressed resume, full-auto flag,
  effort levels, token usage, exact-version release asset, and an account
  credential that is a plain file. Unresolved before a recipe step:
  1. **Item 6, runtime half**: no auto-updater off-switch found; needs a
     verified mitigation (read-only install path) or a sign-off.
  2. **A new vendor row**: Gemini's `generateContent` wire format is not an
     `ApiStyle` (docs/272-opencode-inference notes Gemini models are
     unrepresentable without one); catalogue row before harness row.
  3. **Terms**: the user's reading above, recorded, not decided here.
  Carried requirement: account-level refusals surface verbatim. Unprobed,
  for Phase 10: `/compact` on a resumed session, plugin-based
  prompt/MCP/skills loading, skills disclosure, PreToolUse as guarded
  mode, `call_mcp_tool`'s effect on tool-activity labels.

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
