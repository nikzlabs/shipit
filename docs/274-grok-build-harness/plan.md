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

### Still pending — requires a credential (the Phase 0 remainder)

1. **Stream schema capture** (req 5): real turns under `--output-format
   streaming-json` AND `streaming-messages-json`, tool-tour prompt, kept
   raw with provenance → pick the adapter's format and lock with a
   conformance test.
2. **Token/usage telemetry**: whether the terminal event carries token
   counts, and whether cache figures overlap (normalizer or not).
3. **Reasoning-effort vocabulary**: the authenticated catalog's
   `reasoning_efforts` per model → `capabilities.reasoning` +
   `REVIEWER_DEFAULT_EFFORT`.
4. **API style at a redirected endpoint**: point `GROK_XAI_API_BASE_URL` at
   a local recorder and observe the wire shape.
5. **Session resume, `-s` pre-assignment, `--max-turns`, images, AGENTS.md
   reading, skills disclosure probe** — live behavior.
6. **Auth.json injection**: verify a pasted/injected `auth.json` (or
   `GROK_AUTH_PATH`) authenticates a headless turn in a fresh container, and
   what identity/plan surfaces for `provider-account-identity.ts`.

## Catalogue row, install design, adapter design

Deferred until the pending items above are captured — written here before
any implementation code, per the recipe order.
