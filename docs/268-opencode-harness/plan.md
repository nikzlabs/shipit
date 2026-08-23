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
  `supportsImages: true` (**since planning#458** — the deferred probe was run;
  see [Image attachments](#image-attachments-planning458) below. It was
  `false` at launch because an image turn had never been observed), `supportsSystemPrompt:
  true` (config `instructions`; verified live), `supportsPermissionModes:
  false` + `[]` (headless runs `--auto`), `reasoning` as found above,
  `supportsReview: false` — **now `true`** (planning#459 probed it live at
  depth 0: the harness ran `shipit agent run --role reviewer` itself and
  returned material findings; the flow needs `bash` + `task`, not MCP —
  docs/266 item 15), `supportsSteering: false` (one-shot argv prompt),
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
image-attachment turn (`supportsImages` stayed false until observed — that
probe has since been run, below).

## Rate limits, and the 429 that reports nothing (planning#453)

Probed 2026-08-23 against CLI **1.18.18** at a local HTTP recorder, one
variable — the status code — across `400 / 401 / 402 / 403 / 429 / 500 / 529`.
No quota was spent to obtain any of it.

### `agent_rate_limits`: the transport is fine; there is no window to send

The error event carries the provider's **complete `responseHeaders` map**,
verbatim, on stdout. The 401 control:

```jsonc
{"type":"error","timestamp":…,"sessionID":"ses_…","error":{"name":"APIError",
  "data":{"message":"invalid x-api-key","statusCode":401,"isRetryable":false,
    "responseHeaders":{"content-type":"application/json","date":"…",…},
    "responseBody":"{\"type\":\"error\",…}",
    "metadata":{"url":"http://127.0.0.1:8789/v1/messages"}}}}
```

`OpencodeEvent` in `shared/opencode-stream.ts` types only three of those
fields, and the adapter test's `ERROR_EVENT` fixture was trimmed to match —
which is why the header channel was not known to exist.

So OpenCode *could* emit `agent_rate_limits`. What stops it is the catalogue,
not the CLI. `agent_rate_limits` describes a **subscription** window, and every
route OpenCode can take is one of:

- a **metered key**, where no subscription window exists at all. An API's
  `x-ratelimit-*` headers are per-minute request/token buckets — a different
  quantity, and rendering them in the subscription pill would be a lie.
- **OpenCode Go**, the single subscription it carries (`carriers: ["opencode",
  "codex"]`), whose quota is declared-unread by a human decision: dollar caps,
  no per-key usage API (docs/272 req 6, `opencode-go-usage`).

OpenCode has **no `account` target**, so Anthropic's and xAI's OAuth windows
are unreachable by construction (`service-routing.ts` states the same axis from
the other side).

**State the conclusion at its actual strength**: no route ShipIt can currently
take needs this wired. That is *not* the same as "the channel is ready". The
401 that proved headers survive is a **non-retryable** error, and the statuses
that would actually carry quota information — 429 and the 5xx pair — emit
nothing at all (next section). Whichever change makes a subscription window
reachable will have to re-probe the response that would carry it, because the
one probe that matters has not been run and cannot be until that response
reports anything. Basis recorded in the adapter header per
docs/266 item 13.

### The defect the probe actually found: a 429 hangs the turn

Far more serious than the missing badge, and **not** repaired here.

| status | reports? | exit | wall clock |
|---|---|---|---|
| 400 / 401 / 402 / 403 | yes — a full `{"type":"error"}` event | 1 | ~3.5 s |
| **429**, **500**, **529** | **no — zero bytes on stdout** | **never exits** | **killed at the deadline** |

The split is **retryability**, not severity: the statuses the AI SDK considers
retryable are exactly the silent ones. On a 429 the CLI logs `AI_APICallError`
to its own `$HOME/.local/share/opencode/log/opencode.log`, writes **nothing**
to stdout, and then sits — a separate 15-minute run confirmed it is a hang and
not slowness. Two requests reach the recorder: the `build` stream fails
immediately without retrying, the `title` side-agent retries at 2 s and 4 s and
gives up. Then silence.

Note this **corrects the Phase 0 finding above** for CLI 1.18.18. That entry
(against 1.18.15) reads "on a fatal API error (401) the CLI emits … and then
hangs; the process never exits". At 1.18.18 a 401 emits and exits **1**,
promptly. What hangs is the retryable class — which Phase 0 also saw ("on a
retryable 5xx it retries with no stdout at all") without connecting it to a
missing exit. The adapter's kill-after-`error` machinery is therefore aimed at
a case that no longer occurs, and the case that does occur reaches none of it.

What that means in production: an OpenCode turn refused for quota never
produces `agent_result`, never reaches `detectHardExhaustion`, never benches
the account, and never ends. The adapter's inactivity watchdog only *warns*
(deliberately — a long bash tool call is legitimately silent for minutes), so
the turn hangs until the user interrupts it. Filed as **planning#476**; the
fix needs a design decision the rate-limits work does not own, because the two
candidate mitigations — killing on prolonged silence, or reading the CLI's own
log file — each cost something the current adapter contract protects.

### Corrected: the status code is not what hangs (planning#476)

The table above was re-probed at 1.18.18 on 2026-08-23 while fixing
planning#476, at a local recorder with the **response shape** as the variable
rather than only the status code. Two of its claims do not survive, and the
row for 429/500/529 above is superseded by this section.

- **A well-formed 429 does not hang.** The CLI retries the turn's own stream
  six times over ~72 s (backoff ≈ 2 s → 34 s), then emits a complete
  `{"type":"error"}` event — message, `statusCode: 429`, `isRetryable: true`,
  full `responseHeaders`, `responseBody` — and exits **1**. Measured
  identically for `anthropic-messages` and `openai-chat-completions`, and for
  a 429 with an empty body. So the adapter already fails such a turn honestly,
  `detectHardExhaustion` already sees it, and the req-14 failover already
  applies. It also means the header channel the *"Two Claude events this
  adapter never emits"* docstring calls unproven for retryable statuses is in
  fact present on a 429.
- **What hangs is a response the CLI never finishes reading** — headers sent
  and the body never ended, or a connection accepted and never answered. Then
  stdout, stderr **and the CLI's own log** are all empty (the log's last line
  is `llm runtime selected`) and the process never exits. That reproduces the
  reported "two requests then silence" signature exactly, and it is the shape
  the original probe most likely produced.
- **Consequence for the fix: option (b) is not merely unattractive, it is
  empty.** Reading the CLI's log for the retry state cannot end this hang,
  because in the case that hangs the log has no retry state — nothing is
  written to it at all.
- **`opencode run --format json` does not stream.** It accumulates the turn's
  events and writes the whole log at process **exit**. Verified by delaying
  step 2's model call by 60 s and watching step 1's events — generated at
  4.3 s by their own `timestamp` fields — arrive at 64.4 s with everything
  else, then re-verified under a PTY to rule out stdio buffering. This is why
  `_isStreaming` is false, and it is what made the old 60 s "no output"
  watchdog meaningless: silence is the normal state of every turn, so that
  warning fired on every turn longer than a minute.

**The fix.** A **stall deadline** in the adapter (`armWatchdog` /
`onStallDeadline`): 15 minutes with no output on any channel and no growth in
the CLI's log directory ends the turn with a synthesized failed
`agent_result`. Because no signal distinguishes "waiting on a model that will
answer" from "waiting on one that never will", a clock is the only instrument
available; the log directory is used as a **liveness heartbeat** — `mtime`
only, never parsed — so a turn that is stepping or running tools keeps
postponing the deadline indefinitely, and a missing or moved log degrades to
the bare deadline rather than to an early kill. 15 minutes sits beyond any
single model request, which providers cap well below it. Guard tests:
`adapter.test.ts` → "stall deadline".

## Image attachments (planning#458)

The deferred probe, run 2026-08-20 against CLI **1.18.18** on the dogfood inner
instance. It ends `supportsImages: false` and changes one line of spawn
shaping.

**What ShipIt delivers.** Not `-f`. Attachments take the harness-agnostic path
every backend gets: the orchestrator writes the file into the session's uploads
dir and names that path in an `<attached_images>` block
(`orchestrator/prompt-assembly.ts`), leaving the harness to open it with its own
tool.

**What was actually wrong.** OpenCode did open it. Its `read` tool resolved the
path, answered *"Image read successfully"*, and returned the image as a
`{type:"file"}` part — and the model still reported it could not see an image.
The drop is on ShipIt's side: OpenCode resolves a model's input modalities from
the config entry first and its models.dev entry second, and a synthetic
`shipit/<modelId>` has no models.dev entry, so a block that declares nothing
resolves to `image: false`. `opencodeProviderConfig` declared nothing. Adding
`attachment: true` alone did **not** fix it (tried; still blind); declaring
`modalities: { input: ["text", "image"], output: ["text"] }` did, first try. That
declaration is now `MODEL_MODALITIES` in `shared/opencode-spawn-shaping.ts`,
with a guard test.

**The probe, and its negative control.** The image was a 2×2 grid of four
randomly-chosen colours plus a bitmap digit strip — content existing ONLY in the
pixels, generated outside the session so nothing on disk named the answer. Before
the fix: two vision-capable models over two services (`claude-sonnet-5` via
Vercel, `gemini-3.7-flash` via OpenRouter), both blind. After: all four colours
in order AND the digits, verbatim. The negative control — the same file sitting
in the session's uploads dir with NO attachment on the message — answered
`unknown`, and it was re-run *after* the fix on purpose, because the fix is
exactly what lets `read` see an image at all (the trap docs/274 records, where
two apparent successes turned out to be filesystem reads). That control run is
not a model that sat still, either: it went hunting — `read /uploads`, `glob
**/*`, `glob /tmp/**/*` — and still could not answer.

**One seam, named.** The probe ran on the dogfood host, which is
`RUNTIME_MODE=local` and therefore has no `/uploads` bind mount
(`container-lifecycle.ts`), so the turn carried the attachment's host path
instead of its container path. Everything else — `validateImages`,
`saveImagesToUploadsDir`, the prompt block, the adapter, the spawn — is ShipIt's
own code unchanged.

**What the modality claim cost, and how it was paid off (planning#460).** It was
first declared for every routed model, because `ModelDef` carried no per-model
modality: attaching an image on a text-only route made the request malformed and
the service rejected it. A deliberate trade — declaring nothing lost the image
silently for *every* model — but only until the catalogue could say which models
see. It now can; see [Per-model image input](#per-model-image-input-planning460).

It remains a *harder* failure than Claude Code's harness-level `supportsImages:
true`, and the two should not be read as the same bet — Claude's delivery is a
text block naming a file, so image bytes reach the API only if the agent reads
it, while this declaration has the CLI hand the file part to the model directly.

## Per-model image input (planning#460)

The catalogue now carries a vision verdict per **canonical model**
(`shared/catalogue/model-vision.ts`), and `visionSupportFor(selection)` resolves
it.

**Why not a `ModelDef` field**, which is where `reasoningEfforts` lives: that
field is on the row because the fact it carries genuinely differs between two
rows of one model (subscription `grok-4.6` offers `xhigh`, the key-billed twin
offers nothing). Vision does not differ — it is a property of the weights — and
`canonicalModelKey` is the catalogue's existing home for a fact that is true of
the model rather than of the offering. `deepseek-v4-flash` is five rows across
four services; on the row its verdict would be authored five times. A per-row
override becomes right the day a gateway is *measured* to drop the image part
while its upstream sees fine, and not before.

**Where the verdicts came from.** Two independent public model endpoints, read
2026-08-23 — OpenRouter's `architecture.input_modalities` and Vercel AI
Gateway's `modalities.input`, the same two this catalogue's gateway prices were
authored from. They agree on every model both carry, which is the evidence for
treating the fact as service-invariant rather than an assumption that it must be.
models.dev, OpenCode's own source, is not resolvable from a session container.
Four models are text-only at both — DeepSeek V4 Flash and Pro, GLM-5.2 and 5.3 —
and they are the only rows that gate anything. One model has no verdict from
either source (`gpt-5.3-codex-spark`, ChatGPT-Pro-only with no API) and is marked
`"unverified"` rather than inferred from its siblings.

**Three states, not a boolean.** `"unverified"` behaves exactly as before this
change: the image is handed over, and a model that cannot see produces a visible
failure. Only a `"no"` changes anything. That asymmetry is the design — not
knowing must never resolve to a refusal, or an unrecognised pin would block
attachments on a guess.

**Consumers — one gate and two layers of telling the user.** Withholding the
modality alone was never enough: it would put the turn back where planning#458
found it, with `read` reporting *"Image read successfully"* into a model that
never receives the pixels. So the visible half is what most of this change is.

- `opencodeProviderConfig` declares `input: ["text"]` instead of `["text",
  "image"]` for a `"no"`, so the CLI never issues a malformed request.
- **Admission** — `imageAttachmentRefusal` (`orchestrator/validation.ts`) refuses
  the message outright at both admission points, the WS `send_message` handler
  and `dispatchAgentMessage`, naming the model. Best where it applies: no turn is
  spent and the user keeps their text. It covers `uploads` as well as `images`,
  because `uploads` — not `images` — is the shape the browser composer sends, and
  it asks about `msg.sessionId ?? activeAppSessionId`, the same target the
  handler resolves later, so a frame aimed at another session cannot be judged
  against this one's model.
- **Execution backstop** — the same function again in `runDispatchedTurn`, as a
  **notice** rather than a refusal: the image is dropped from the prompt and the
  user is told in the transcript. This is the only point EVERY dispatched ingress
  passes through, and it exists because admission is not enough twice over:

  1. **Quick Capture** reaches `runner.dispatch` straight from
     `createHeadlessSession` and never calls `dispatchAgentMessage` at all.
  2. Admission answers at **enqueue** time, and a session's model can change
     before its queue drains — so a queued image can execute on a model that was
     not the one it was admitted against.

  A notice and not a refusal because by that point the turn is committed and the
  prompt is worth running: throwing away a fire-and-forget capture from a hotkey
  overlay because one of its files is a PNG costs more than it saves. `uploadPaths`
  is left intact so the user's bubble still shows the chip.

**The one case nothing catches, stated as a trade rather than covered:** an image
already on disk that the agent opens by itself carries no attachment, so nothing
fires and the pixels are dropped where the blanket claim used to produce a
provider 400. Accepted deliberately — that 400 was not scoped to attachments, so
ANY `read` of ANY image killed the whole turn, and an agent glancing at a
screenshot in the repo could end a text-only session's work.

**Deliberately not done here:** the composer still offers an attach affordance
whatever the session is pinned to. That is not a per-model gap — no client or
server code reads `capabilities.supportsImages` at all, so grok's evidence-backed
harness-level `false` is unenforced too. One surface should answer both, so it is
scoped out to planning#474 rather than half-built here.

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

One residual it named was accepted and documented rather than fixed: a
DROPPED final `step_finish` combined with the MCP keep-alive means no
stop-kill is armed and the turn runs until the user interrupts (which
settles correctly as interrupted). The alternative — killing on stream
silence — would kill legitimate long silent tool calls (OpenCode emits tool
events only at completion), which is worse. A warn-only 60s watchdog
(Claude parity) narrated the state.

**Superseded by planning#476.** That warn-only watchdog is now a stall
deadline that ends the turn, and this residual is covered by it — see
[Corrected: the status code is not what hangs](#corrected-the-status-code-is-not-what-hangs-planning476)
for why the 60 s warning was not merely insufficient but meaningless (the CLI
writes its whole event log at exit, so *every* turn over a minute tripped it),
and for what makes killing on silence safe now that a liveness heartbeat
carries the signal the stream cannot.

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
