# Candidate assessment: Cursor CLI, Grok Build, OpenCode

Assessed 2026-08-15 against the Phase 0 checklist in [plan.md](./plan.md)
(req 5). This updates the older survey rows in
`docs/252-custom-models/catalogue.md` (notably: Cursor's binary is now
`agent`, not `cursor-agent`, and Grok Build now exists). All three vendors
ship fast; re-verify against `--help` output when integration starts. Items
marked *(third-party)* come from community references, not vendor docs.

## Assessment matrix

Explicit outcome per Phase 0 item: ✅ documented by the vendor, ⚠️ partial
or caveated, ❌ absent, ❓ unknown — an unknown is an open research item,
and on items 2, 5, 6, and 12 it is a start-blocker per plan.md's blocker
semantics, not a shrug.

| Phase 0 item | Cursor CLI | Grok Build | OpenCode |
|---|---|---|---|
| 1. Headless mode | ✅ `-p` | ✅ `-p` | ✅ `run` |
| 2. Streaming schema | ✅ documented NDJSON | ❓ undocumented — capture + conformance test required | ⚠️ documented but coarse; loss bugs (see verdict) |
| 3. Session resume | ✅ | ✅ | ✅ |
| 4. Full-auto permissions | ✅ `--force` + allow/deny | ✅ `--always-approve` + modes | ✅ `--auto` + config |
| 5. Auth injectable | ⚠️ key env ✅ / subscription ❓ (path undocumented) | ✅ `~/.grok/auth.json`; device-auth *(third-party)* | ✅ plain file; ❌ no Anthropic subscription |
| 6. Pinnable install | ❌ none documented — policy gate | ⚠️ pinned install script *(third-party)* | ✅ npm exact |
| 7. Instructions | ✅ AGENTS.md/CLAUDE.md | ✅ AGENTS.md | ✅ AGENTS.md |
| 8. MCP | ✅ `mcp.json` | ✅ `config.toml` | ✅ `opencode.json` |
| 9. Skills disclosure | ❓ empirical, untested | ❓ empirical, untested | ❓ empirical, untested |
| 10. Token telemetry | ❌ none in result event | ❓ claimed in stream, schema unverified | ✅ per-step tokens + cost (verify overlap) |
| 11. API style to redirected endpoint | ❓ (service-fused; likely none) | ❓ | ❓ (many claimed) |
| 12. Reasoning control | ❓ | ❓ | ⚠️ `reasoningEffort` config *(per docs/252 survey)* |
| 13. Remaining capability flags | ❓ empirical | ❓ empirical | ❓ empirical |

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

## Cross-cutting

- Cursor and Grok imitate Claude Code's flag surface → Claude-shaped
  spawn-per-turn adapters. OpenCode is the outlier rewarding attach-to-server.
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
