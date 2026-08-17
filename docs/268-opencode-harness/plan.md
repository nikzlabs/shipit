---
issue: planning#406
title: OpenCode harness
description: OpenCode (`opencode` CLI 1.18.15, npm `opencode-ai`) as the third harness — spawn-per-turn adapter, key-mode services only, synthesized terminal result.
---

# OpenCode harness

Implements [requirements.md](./requirements.md), by following
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md)
(req 6). This doc holds only what is OpenCode-specific: the Phase 0 findings,
the catalogue row decisions, and the adapter design. The step-by-step is
[checklist.md](./checklist.md), copied from the recipe template.

## Phase 0 findings (all verified against CLI 1.18.15, 2026-08-16, in-container)

Everything below was observed live — a real `opencode run` turn against
DeepSeek (the container's `DEEPSEEK_API_KEY`), plus a local HTTP recorder as a
redirected endpoint. Nothing is recalled from docs.

- **Pinned version: `opencode-ai@1.18.15`** (published 2026-08-07, ≥7 days;
  1.18.16+ are younger). The package is a postinstall shim: platform binaries
  arrive as `optionalDependencies` (`opencode-linux-x64` …) and
  `postinstall.mjs` copies the right one to `bin/opencode.exe` — so under the
  installer's blanket `--ignore-scripts` the CLI errors at startup until
  **`npm rebuild opencode-ai`** runs. Same exception shape as Claude Code
  (recipe step 3).
- **Stream** (`--format json`, JSONL on stdout): `step_start` → (`text` |
  `tool_use`)* → `step_finish` per assistant step; `error` on fatal failure.
  Every event carries `sessionID` (the resume id) and a `part` payload.
  `tool_use` is a single *completed* event (`part.state`:
  `{status:"completed", input, output, metadata, title, time}`) — there is no
  tool-started event. `step_finish` carries `part.reason`
  (`"tool-calls"`/`"stop"`), `part.cost` (USD) and `part.tokens`.
  **There is no terminal result event** — the last `step_finish` then process
  exit (code 0) is the turn's end.
- **Token semantics are disjoint** — no Codex-style normalizer needed.
  Verified arithmetically on every captured step:
  `tokens.total = input + output + reasoning + cache.read + cache.write`
  (e.g. 41+72+0+7296+0 = 7409), i.e. `input` excludes cached tokens.
- **Failure behavior (the req 4 material).** On a fatal API error (401), the
  CLI emits `{"type":"error","error":{"name":"APIError","data":{message,
  statusCode, isRetryable, …}}}` — and then **hangs; the process never
  exits**. On a retryable 5xx it retries with no stdout at all. stdout is
  block-buffered (Bun), so a killed process can lose already-emitted events —
  the upstream "dropped `text`/`step_finish`" bugs. Consequences: the adapter
  must (a) treat `error` as terminal and kill the process itself, (b)
  synthesize `agent_result` from process exit whenever no final `step_finish`
  arrived, and (c) never trust the buffer to flush on kill.
- **Reasoning (req 7 / recipe row 12): `--variant <level>`**, per-model named
  variants sourced from models.dev (`opencode models --verbose` shows each
  model's map). Observed vocabulary across Anthropic/OpenAI/DeepSeek entries:
  `none | minimal | low | medium | high | xhigh | max`; `high` exists on
  essentially every reasoning-capable model → `REVIEWER_DEFAULT_EFFORT:
  "high"`. **An unknown variant is silently ignored** (exit 0, no warning), so
  ShipIt's catalogue owns validation. For custom-provider models both delivery
  mechanisms were wire-verified: a per-model `variants` map in the provider
  block honored by `--variant`, and per-model `options.reasoningEffort` —
  both produced `reasoning_effort` in the request body.
- **Wire styles, verified at a recorder:**
  - `npm: "@ai-sdk/openai-compatible"` + `options.baseURL` →
    `POST <base>/chat/completions`, `Authorization: Bearer <key>` —
    **openai-chat-completions**. Base URL carries its own `/v1`.
  - `npm: "@ai-sdk/anthropic"` + `options.baseURL` → `POST <base>/messages`,
    `x-api-key` + `anthropic-version` headers — **anthropic-messages**. The
    base URL must carry its own `/v1` — **opposite of Claude Code's
    convention** (Claude appends `/v1/messages`; OpenCode appends only
    `/messages`). The catalogue's A_MSG endpoints are written Claude-style, so
    the adapter appends `/v1` when building OpenCode provider blocks.
- **Config surface:** global `~/.config/opencode/opencode.json(c)` + project
  `opencode.json` merge; `OPENCODE_CONFIG` points at an extra file and
  `OPENCODE_CONFIG_CONTENT` inlines one. Data root (auth.json, opencode.db
  session store) is `~/.local/share/opencode` (XDG-derived);
  `OPENCODE_AUTH_CONTENT` can inline auth. Other load-bearing env, extracted
  from the binary and used by the adapter: `OPENCODE_DISABLE_AUTOUPDATE`,
  `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_SHARE`,
  `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_MODELS_FETCH`.
- **Instructions & skills (docs/209 probe, live):** `AGENTS.md` is read and
  obeyed. Skills are auto-disclosed from **both** `.opencode/skills/` and
  `.claude/skills/` (both probe markers surfaced) — **no symlink needed**;
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is the upstream kill switch to leave
  unset. `skillsDirName: ".opencode"`.
- **Tools:** `bash, edit, glob, grep, read, skill, task, todowrite, webfetch,
  write` (model-reported; Phase 10 re-verifies from a captured request's
  `tools` array).
- **Resume:** `-s <sessionID>` verified (recall across processes).
- **Per-turn side traffic:** each run issues an extra small "title generator"
  LLM call on the same provider. Cost noise, not a correctness issue; disable
  if config offers a switch, otherwise accept.

## Catalogue row (recipe step 2)

- `id: "opencode"`, `name: "OpenCode"`, `binary: "opencode"`. No
  `nativeService` at launch: OpenCode's own gateway (OpenCode Zen) is a real
  service with its own pricing and would need honest `ServiceDef` rows —
  follow-up, not this PR.
- `styles: ["openai-chat-completions", "anthropic-messages"]` — order is
  preference; chat-completions first (OpenCode's dominant native path, and the
  style whose reasoning delivery is fully verified). **OpenCode is the first
  harness to consume the catalogue's `openai-chat-completions` endpoints** —
  those rows were researched but never driven by a harness until now, so
  Phase 10 live-verifies at least DeepSeek's.
- `spawn.credential`: **string only** (`{ kind: "env", name:
  "OPENCODE_PROVIDER_API_KEY" }` — a ShipIt-chosen variable the adapter's
  provider block references as `{env:…}`). **Deliberately no `account`
  target** (req 5): the eligibility join then structurally excludes every
  `via: "account"` mode — Anthropic OAuth, ChatGPT — which is exactly the
  launch auth scope. GLM's coding plan (`sub` delivered via a string) still
  joins; its Bearer-vs-x-api-key header question is a Phase 10 check.
- `spawn.model`: `{ kind: "flag", flag: "--model" }` (value
  `shipit/<modelId>`, see below). `spawn.endpoint`: config-file — the adapter
  writes a provider block; there is no env override.
- Capabilities (each empirically grounded above): `supportsResume: true`,
  `supportsImages: false` (the `-f` flag exists but an image turn was never
  observed — honest false until probed; review finding), `supportsSystemPrompt:
  true` (config `instructions`; verified live), `supportsPermissionModes:
  false` + `[]` (headless runs `--auto`), `reasoning` as found above,
  `supportsReview: false`, `supportsSteering: false` (one-shot argv prompt),
  `startsOwnTurns: false` (process exits at turn end), `supportsCompaction:
  false` (autocompact exists but there is no on-demand trigger in run mode),
  `skillsDirName: ".opencode"`, `skillInvocationPrefix: "/"`.

## The `serviceId → provider/model` mapping (settled here, per the brief)

The adapter **never uses OpenCode's built-in provider registry for routing**.
Every spawn writes one custom provider block named `shipit` into a per-turn
config file (delivered via `OPENCODE_CONFIG`), built from the resolved
`ModelSelection`:

- `npm`: `@ai-sdk/openai-compatible` or `@ai-sdk/anthropic`, from the resolved
  `ApiStyle`;
- `options.baseURL`: the catalogue endpoint for that style (A_MSG endpoints
  get `/v1` appended, per the convention difference above);
- `options.apiKey`: `{env:OPENCODE_PROVIDER_API_KEY}` — the key itself only
  ever in the process env;
- `models.<modelId>`: with a `variants` map covering ShipIt's declared levels,
  style-appropriate payloads (`reasoningEffort` for chat-completions;
  `effort`/`thinking` for anthropic-messages, mirroring models.dev's own
  entries per family).

The turn then runs `-m shipit/<modelId> --variant <effort>`. One namespace,
fully explicit, independent of models.dev churn; `OPENCODE_DISABLE_MODELS_FETCH`
can be set because nothing routes through the fetched registry.

## Adapter design (`session/agents/opencode/`, Claude-shaped)

- Spawn per turn: `opencode run <prompt> --format json --auto -m
  shipit/<modelId> [--variant <effort>] [-s <resumeSessionId>]`, cwd =
  workspace, prompt as argv (spawn array, no shell). Env: `resolveAgentHome()`
  → `scrubEnvAuthForScopedHome` → `applyServiceRouting` (order per
  `claude/process.ts`), plus the `OPENCODE_DISABLE_*` set and
  `OPENCODE_CONFIG` pointing at the per-turn file.
- Event mapping (`mapEvent` switch): first event → `agent_init` (sessionID);
  `text` → `agent_assistant`; `tool_use` → assistant tool_use +
  `agent_tool_result` (preserving the message-group boundary contract);
  `step_finish` → accumulate tokens/cost into the pending result.
- **Terminal synthesis (req 4):** `agent_result` is emitted from **process
  exit**, never from a stream event: exit 0 → success with accumulated
  text/tokens; nonzero → error result. An `error` event marks the turn failed
  AND triggers `killChild()` (the CLI hangs after fatal errors — see
  findings). The conformance test replays a captured real stream *truncated
  before its final `step_finish`* and asserts a correct synthesized result.
- `writeMcpConfig(ctx)`: merged into the same per-turn config file (`mcp`
  key: playwright + shipit bridge + user servers, `$secret:` resolved) →
  returns `{runtimeEnv: {OPENCODE_CONFIG: path}, cleanup}`. The MCP tool
  subset for the shipit bridge is the adapter's own list (recipe: hardcoded
  per adapter).
- System prompt: config `instructions` array pointing at the rendered
  system-prompt file (byte-stable per prompt-architecture rules).
- No steering, no compaction trigger, no permission broker (`--auto` inside
  the container sandbox — same trust envelope as Claude's bypass mode).

## Auth scope (req 5)

Launch = key-billed modes only, enforced structurally by the missing `account`
credential target (see catalogue row). `AGENT_CREDENTIAL_PATHS` still lists
`.local/share/opencode/` so per-agent credential isolation and sub-agent
provisioning have a defined home, and a future login integration
(ChatGPT/Copilot OAuth → `auth.json` / `OPENCODE_AUTH_CONTENT`) is follow-up
work with its own `LoginIntegrationId`. No OpenCode auth manager, limits
provider, or quota integration ships in this PR.

### The credential home is a symlink, and creating it is not a `mkdir -p`

Found in production on the first real OpenCode session: the agent process died
at startup, before reading an argument, with

    EEXIST: file already exists, mkdir '/home/shipit/.local/share/opencode'

Two facts combine into it, and each is invisible on its own.

1. **The path is a symlink into `/credentials`**, in every image
   (`Dockerfile.prod`, `Dockerfile.session-worker.*`), so a login survives a
   container restart. Unlike the single-segment `.claude` / `.codex` targets,
   nothing materializes a three-deep `.local/share/opencode`, so on a fresh
   credentials volume the link **dangles**. OpenCode's key-mode auth (req 5)
   guarantees this is the normal state: there are no credential files to copy,
   so `copyCredentialPath` returns early and never creates it.
2. **`mkdir(2)` returns EEXIST on a dangling symlink.** The link is a directory
   entry, so the name is taken — this is a namespace collision, not a permission
   check, and no capability or privilege level changes it. Node's
   `{recursive: true}` masks it as ENOENT and still refuses; OpenCode's Bun
   runtime surfaces the raw errno and exits 1.

So "just `mkdir -p` the path" is precisely the thing that fails — and where the
home is the credentials root, creating the target is the wrong repair anyway.
Three places, three different answers:

- **`docker/session-worker/entrypoint.sh`** — prepares it at boot, and must run
  **as the worker via gosu**. The first version ran as root on the stated
  premise that "/credentials was just handed off by the loop"; the loop does no
  such thing. The orchestrator seals the per-session credentials subtree `0700`
  to the session's own uid *before* the container starts (docs/270,
  `chownSessionCredentialsTree` → `sealDirMode`), and the container drops
  `DAC_OVERRIDE` (docs/150 §10) — the only capability that bypasses a
  directory's write bit. The mount loop skips `/credentials` for the same reason
  (its `[ -w ]` probe reads 0700 as unwritable), so the root form failed at its
  first command on every production boot. Invisibly: best-effort `2>/dev/null`,
  with the warning going to container stderr while the user saw only the agent's
  EEXIST. Root does retain enough to *seize* the directory (`CAP_CHOWN` it to
  itself, then write) — a repair we specifically do not want, since it would
  undo the docs/270 seal to create an empty directory.
- **`shared/opencode-data-dir.ts`, called from the adapter's spawn** — covers
  local/dogfood mode, which has no container and therefore no entrypoint, while
  the orchestrator image carries the same symlink at `/root`. The pinned agent's
  own local turn was already fine (`clearAgentHomeCredentialLinks` unlinks the
  baked link for reserved routes), but sub-agent and PR-description spawns
  bypass that. In a container the call is an idempotent directory read.
- **`session-namer.ts` — a scratch `XDG_DATA_HOME`, not the home's dir at all.**
  Unscoped naming's HOME is the *flat credentials root*, so materializing
  `.local/share/opencode` there would flip `copyCredentialPath`'s "no source"
  early-return and start copying the orchestrator-wide OpenCode session store
  into every session's credential subtree — defeating docs/138 isolation, with
  no cleanup path (`SUBTREE_STATE_SUBPATHS` has no row for it). Key-mode auth
  means naming needs nothing from the home, so it gets a per-run temp XDG root,
  torn down beside the config file. Revisit if OpenCode login integration lands.

The guard tests pin the creator's **identity**, the **symlink hop**, and that
naming **leaves the home untouched** — never that a mkdir happened. An
"it exists" assertion passes on every broken version, including the one that
caused this.

## Phase 10 findings (live, through the real adapter)

Three defects were caught only by driving the actual adapter against DeepSeek
in-container — none were visible to unit tests or desk research:

- **`$PWD` beats the spawn cwd.** The CLI resolves its project directory from
  the inherited `PWD` env var, not its real working directory (Bun semantics),
  so a turn's writes landed in the *worker's* directory. The adapter pins
  `PWD` to the spawn cwd.
- **With MCP servers configured, the process NEVER exits after the turn** —
  the MCP children keep the Bun event loop alive (without MCP it exits
  promptly). Every production turn has MCP servers (playwright + the shipit
  bridge), so the adapter arms a 5s kill after the final `step_finish`
  (reason ≠ `tool-calls`), cancels it if a new `step_start` proves the guess
  wrong, and treats a self-killed completed turn as success regardless of the
  signal exit code. Locked by adapter tests.
- **The eligibility join would have offered Anthropic-subscription models on
  OpenCode** through the sub mode's env-OAuth string credential
  (`ANTHROPIC_AUTH_TOKEN`) — every such turn would 401, and it violates req 5.
  Fixed at the catalogue level: `ModeCredential.carriers` restricts a string
  credential to the harnesses that can actually authenticate with it, and the
  *Add a service* support cell became tri-state (`harnessServiceSupport`:
  all/some/none) because with three harnesses one service's modes genuinely
  disagree per harness — exactly the moment `catalogue.test.ts` said the
  per-service collapse must stop.

Also verified live through the adapter: provider-block routing + billing route
(the `OPENCODE_PROVIDER_API_KEY` delivery), `--variant high`, system-prompt
injection via config `instructions` (marker echoed back), session resume,
MCP end-to-end (a real stdio server's tool called and answered, config in
OpenCode's `{type:"local", command:[...], environment}` shape), the
synthesized-result paths, and BOTH styles' reasoning payloads at the recorder
(`reasoning_effort` on chat-completions; `output_config: {effort}` on
Messages). Deferred to the dogfood pass, stated rather than skipped silently:
a `shipit agent run` cross-agent spawn in a real install and an
image-attachment turn (`supportsImages` stays false until observed).

## Independent review outcomes (docs/268, same-day)

The reviewer (ShipIt's configured reviewer role) confirmed the requirements
met and surfaced five substantive defects, all fixed and test-locked:

1. A signal-killed turn synthesized as *success* — the close handler ignored
   the `signal` argument, so a user interrupt settled as a completed empty
   turn instead of interrupted. Now: signal death without a completed turn
   emits NO result (Claude's contract); the adapter's own deliberate kills
   (post-error, post-final-step) still resolve as error/success.
2. The interrupt escalation timer read `this.proc` inside its callback and
   survived `close`, so it could SIGTERM the NEXT turn's process. Now
   captured-at-entry, held, and cleared with the turn.
3. GLM's coding plan (sub-via-string, bearer token) was still offered on
   OpenCode — same class as the Anthropic env-OAuth hole; `carriers:
   ["claude"]` closes it, with the zai×opencode tri-state pinned.
4. The session-namer ran `opencode` without `--auto` (a tool call would hit
   an interactive gate with no TTY) and without the `$PWD` pin. Both added.
5. Exit-0-with-no-events read as a clean empty success, and a held stdin
   failure was only logged. Both now follow Claude's contract (no result /
   fail the run).

One residual it named is accepted and documented rather than fixed: a
DROPPED final `step_finish` combined with the MCP keep-alive means no
stop-kill is armed and the turn runs until the user interrupts (which now
settles correctly as interrupted). The alternative — killing on stream
silence — would kill legitimate long silent tool calls (OpenCode emits tool
events only at completion), which is worse. A warn-only 60s watchdog
(Claude parity) narrates the state.

## Known risks / review checklist

- The two pre-existing defects docs/266 names as worsened by a third harness
  (`reviewer-settings.ts:28` harness derivation; `child-sessions.ts:367`
  first-harness-wins for shared models — DeepSeek/GLM now resolve on more
  harnesses). The reviewer one became OBSERVABLE for sessions with no model
  selection (the derived reviewer could land same-family on OpenCode) and is
  FIXED per planning#408: on a harness-only tie, `selectReviewer` now prefers
  the candidate whose family provably differs from the implementer harness's
  native service's family — a weak prior that decides ties only and never runs
  when the implementer's identity is known (`reviewer-model.ts`, header's
  "harness-only tie-break" section). Known-model ranking is unchanged.
- Fast upstream churn (releases every few days): version bumps are routine
  deliberate edits; `OPENCODE_DISABLE_AUTOUPDATE` stays set so the pinned
  binary never self-replaces.
- **OpenCode 2.0 is in beta** — full fact sheet, the load-bearing run-mode
  unknown, and the adoption shape now live in
  [docs/269-opencode-v2](../269-opencode-v2/plan.md) (tracked as
  planning#411); the summary below is kept for this doc's own review trail.
  (Checked 2026-08-16: `opencode.ai/v2/docs`.)
  It is NOT a routine bump on this integration's line: it ships as a
  different npm package (`@opencode-ai/cli@beta`, currently version
  `0.0.0-next-*` with multiple builds per day) installing a SEPARATE
  `opencode2` binary that coexists with v1, and upstream states its APIs,
  configuration and plugin surface may still change. Its declared breaking
  changes (new plugin API, new server API/clients, TUI config move) do not
  touch this adapter's `run`-mode surface, and the v1 stable line
  (`opencode-ai`, `latest` = 1.18.x) remains the released product — so this
  integration stays on v1. When 2.0 stabilizes: adopting it means a new
  catalogue binary + installer package (a deliberate migration, not a
  Renovate bump), and its new server API is the natural target for the
  attach-to-server adapter shape docs/266 deferred as its own design task.
- The post-error hang and stdout buffering (findings above) are upstream bugs
  worked around, not fixed; re-test on every version bump.
