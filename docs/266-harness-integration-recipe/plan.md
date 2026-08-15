---
issue: planning#392
title: Harness integration recipe
description: The full recipe for integrating a new coding-harness CLI backend, with every touchpoint enumerated — supersedes docs/158.
---

# Harness integration recipe

Implements [requirements.md](./requirements.md). Candidate fact sheets for
Cursor CLI, Grok Build, and OpenCode live in [candidates.md](./candidates.md)
(req 5).

**This doc supersedes `docs/158-add-an-agent`**, which predates the docs/252
catalogue (`AGENT_DEFS` is now *derived* from `HARNESSES`), `SHIPIT_HARNESSES`
install selection, `installed-harnesses.ts`, `LoginIntegrationId`-keyed auth
managers, provider accounts, and roles/reviewers (docs/261, docs/264). Its "5
files outside the per-agent folder" claim is no longer achievable; the real
touchpoint count is ~35. Line numbers below were verified 2026-08-15 and will
drift — treat them as anchors for grep, not gospel.

## Orientation: what a harness is

A harness is an agent CLI plus the adapter that normalizes its event stream.
Every backend implements the same contract, and the orchestrator never knows
which CLI is running.

- **The adapter contract** is `AgentProcess`
  (`src/server/shared/types/agent-types.ts:1174`): an
  `EventEmitter<AgentProcessEvents>` with `agentId`, `capabilities`,
  `run()`, `writeStdin()`, `sendUserMessage()`, `interrupt()`, `kill()`,
  `isStreaming`, `writeMcpConfig()`, and optional `setPermissionMode()`,
  `compact()`, `setPermissionRequester()`, `resolvePermission()`
  (ProxyAgentProcess only), `setDeliveryId()`. It emits the normalized thirteen-member
  `AgentEvent` union (`agent-types.ts:919`): `agent_init`, `agent_assistant`,
  `agent_tool_result`, `agent_result`, `agent_rate_limits`,
  `agent_steer_rejected`, `agent_user_replay`, `agent_compaction_started`,
  `agent_compacted`, `agent_permission_request`, `agent_permission_resolved`,
  `agent_background_tasks`, `agent_self_wake`.
- **The registry has two layers.** The static catalogue row is `HarnessDef`
  (`src/server/shared/catalogue/types.ts:309`), declared in
  `catalogue/harnesses.ts` — id, display name, binary, `nativeService`,
  `styles` (a *set* of `ApiStyle`), `spawn` (credential targets, model
  delivery, endpoint override), and `capabilities`
  (`AgentCapabilities`, `agent-types.ts:419` — models excluded; those come
  from the service join). The runtime layer is `AgentRegistry`
  (`shared/agent-registry.ts`), which derives `AGENT_DEFS` and
  `KNOWN_AGENT_IDS` from `HARNESSES` and adds install detection, auth
  probing, and the eligible-model join.
- **Two proven adapter shapes.** Pick whichever matches the CLI's protocol:

| Axis | Claude-shaped (`session/agents/claude/`) | Codex-shaped (`session/agents/codex/`) |
|---|---|---|
| Wire format | NDJSON on stdout; prompt on stdin then EOF | JSON-RPC 2.0 over JSONL, bidirectional (`app-server`) |
| Process | one-shot per turn, or resident with `--replay-user-messages` | resident app-server, killed at `turn/completed` |
| Model delivery | `--model` flag | `turn/start` payload field |
| Endpoint override | `ANTHROPIC_BASE_URL` env | `-c model_providers.*` config block |
| MCP config | per-turn JSON file → `{mcpConfigPath, cleanup}` | managed block in `config.toml` → `{runtimeEnv}` |
| Permission gate | `--permission-prompt-tool` via the MCP bridge | native approval RPC via `setPermissionRequester()` |
| Event mapping | `switch` in `adapter.ts` (`mapEvent`) | separate `codex-event-handler.ts` module |

  Cursor CLI and Grok Build imitate Claude Code's flag surface and slot into
  the Claude shape; OpenCode's `serve` HTTP API suggests a third,
  attach-to-server shape (see candidates.md).
- **What needs no changes:** `ProxyAgentProcess`
  (`orchestrator/proxy-agent-process.ts`) and the whole orchestrator↔worker
  HTTP/SSE plumbing are agent-agnostic. Never read its hardcoded
  `capabilities` stub for a real decision — resolve through `AgentRegistry`.
  The worker wire contract (`worker-wire-contract.test.ts` deliberately
  types `agentId` as `string`) is likewise untouched. The
  `shipit`/`shipit-agent` shims parse generically, but 🚩 their *help text*
  hardcodes `--agent claude|codex` (`session/agent-shim/shipit.ts:118,270`).

## Phase 0 — assess the candidate before writing code (req 4)

A candidate CLI must answer all of these. Blocker semantics: a "no" on 1–4
blocks integration outright; a "no" on 5 (no injectable auth path) or 6 (no
pinnable install) blocks until an explicit design/policy decision is signed
off — neither is improvisable; a "no" or "unknown" on 12 blocks the
*reviewer* wiring specifically (see step 4); everything else is a capability
flag honestly set to `false`.

1. **Headless mode**: accepts a prompt non-interactively (no TTY) and runs a
   full agentic turn to completion in a Docker container.
2. **Machine-readable streaming output**: NDJSON/JSONL events distinguishable
   into assistant text, tool calls, tool results, and a terminal result. If
   the schema is undocumented, capture real transcripts and write a
   conformance test before trusting it (Codex precedent:
   `docs/034-multi-agent-cli/codex-adapter-design.md`).
3. **Session resume**: a session/thread id ShipIt can store and pass back for
   the next turn (`supportsResume`).
4. **Full-auto permission configuration**: a flag or config file that
   approves tool use unattended inside the sandbox — or a blocking approval
   channel ShipIt can broker (the two shapes in the table above).
5. **Auth**: subscription OAuth (where do tokens live on disk? can the file
   be injected into a container?) and/or an API-key env var. Fill
   `spawn.credential`, `AUTH_ENV_KEYS`, `AGENT_CREDENTIAL_PATHS`,
   `HARNESS_CREDENTIAL_VARS`. A CLI with its own OAuth flow and quota API
   also needs new `LoginIntegrationId` / `QuotaIntegrationId` members.
6. **Pinnable install**: an exact-version install path (npm preferred — the
   installer pipeline is npm-lockfile-based; a curl-installed binary needs
   image-baking and its auto-updater disabled) per the dependency policy.
7. **Instructions**: reads `AGENTS.md` (or an injectable system prompt —
   `supportsSystemPrompt`).
8. **MCP**: config format and whether servers get a controlled env
   (Codex-style `env_vars` allow-listing).
9. **Skills disclosure** (empirical, per docs/209): does it read
   `AGENTS.md`→`CLAUDE.md`; does it auto-disclose `.claude/skills/`, or only
   its own `<skillsDirName>/skills` (then commit a symlink)?
10. **Token/usage telemetry**: does the result event carry token counts, and
    are cache figures overlapping (Codex-style — needs its own
    `<id>-token-usage.ts` normalizer) or disjoint? Dollar telemetry?
11. **API style** it speaks to a *redirected* endpoint — research, not
    recall; ShipIt only proves how it drives the local CLI
    (`docs/252-custom-models/catalogue.md`, "verified negatives").
12. **Reasoning-effort control**: flag, config key, or none
    (`capabilities.reasoning`). A harness with *no* reasoning levels
    currently fails `reviewer-model.test.ts:192` ("names a level every
    harness actually offers" asserts a non-empty option list per harness) —
    verified at source; integrating such a CLI requires first extending the
    reviewer-default mechanism, a design decision, not a recipe step.
13. **The remaining `AgentCapabilities` declarations**, answered honestly
    up front: image input (`supportsImages`), mid-turn steering
    (`supportsSteering`), resident-process turn behavior (`startsOwnTurns`),
    native compaction (`supportsCompaction`), review usability
    (`supportsReview`), and the skill invocation prefix — each shapes UI and
    turn plumbing, and a wrong guess here surfaces as runtime behavior, not
    a type error.

## The recipe

Ordered so the compiler finds as much of the tail as possible. Steps marked 🚩
are **silent**: no compile error and no existing test fails if you miss them.

### 1. Types and the lint guard — one commit

- Widen `AgentId` (`shared/types/agent-types.ts:10`). This cascades compile
  errors into every required `Record<AgentId, …>` table (step 4).
- 🚩 Widen the ESLint leak-guard regex in the same commit:
  `eslint.config.js:46` and `:50` hardcode `/^(claude|codex)$/`, so
  `agentId === "newid"` branches are otherwise unflagged forever. Add
  `src/server/session/agents/<id>/**` and
  `src/server/orchestrator/agents/<id>/**` to the exemption list (~`:270`).
- If the harness has its own OAuth login or quota API: extend
  `LoginIntegrationId` / `QuotaIntegrationId` (`catalogue/types.ts:57,64`).
- Per-harness permission-mode constant beside `CLAUDE_PERMISSION_MODES`
  (`agent-types.ts:18`) if its mode set differs.

### 2. Catalogue row

- Add the `HarnessDef` row in `catalogue/harnesses.ts` (and update its "What
  is NOT here" header note). Every capability flag must be *honest* —
  `supportsReview`, `supportsSteering`, `startsOwnTurns`,
  `supportsCompaction`, `skillsDirName`, `skillInvocationPrefix`.
- Add `<X>_TOOL_NAMES` in `shared/agent-tool-names.ts`; re-export from
  `agent-registry.ts`.
- New vendor → new `ServiceDef` in `catalogue/services.ts` (real prices and
  context windows; `catalogue.test.ts` rejects sentinels). New wire format →
  new `ApiStyle` member (`catalogue/types.ts:28`).
- `catalogue.test.ts` harness invariants (≥1 style, ≥1 credential target,
  native service exists, every joined model resolves style + endpoint) must
  pass.

### 3. Install pipeline and images

- `docker/agent-cli/install-agent-clis.sh`: `KNOWN_HARNESSES`,
  `harness_pkg_prefix()`, `harness_bin()` (must echo the catalogue binary).
- `docker/agent-cli/package.json` + lockfile: the pinned npm package
  (exact version, ≥7 days old). A non-npm CLI (Cursor) breaks this pipeline —
  that's a design decision to surface, not to improvise.
- The five CLI images' `ARG SHIPIT_HARNESSES=claude,codex` default, if the
  default set changes — `agent-cli-install.test.ts` asserts the literal and
  enumerates the Dockerfiles.
- 🚩 Credential symlinks are hand-written per backend in
  `Dockerfile.session-worker.prod` (~`:271`), `.dev` (~`:175`) — both
  `ln -s /credentials/<dotfiles>` + `chown -h` — and `Dockerfile.prod`
  (~`:101`, root, symlinks only). Miss this and credentials never reach the
  CLI.
- `deployment/vps/setup.sh`: `SUPPORTED_HARNESSES` (~`:294`) — guard-tested —
  plus 🚩 the interactive prompt's hardcoded `[claude,codex]` copy (~`:319`),
  which is not.
- `docker/local/prod/compose.yml` `SHIPIT_HARNESSES` defaults (×2) and 🚩
  `deployment/vps/docker-compose.yml:26,167` (same default, un-guard-tested).
- Note: `agent-cli-install.test.ts:189` uses `cursor` as its *bogus-id*
  fixture — repick if you're adding Cursor.

### 4. Required `Record<AgentId, …>` tables — the compiler finds these

One entry each: `AGENT_CREDENTIAL_PATHS`
(`orchestrator/session-credentials-scaffold.ts:47` — the CLI's dotfiles;
per-agent credential isolation and sub-agent provisioning both iterate it),
`HARNESS_CREDENTIAL_VARS` (`shared/spawn-routing.ts:28` — env keys to scrub
for scoped-home spawns; a miss silently bills the wrong route),
`AGENT_TOOL_MAPS` (`session/agents/tool-map.ts:42`), `AUTH_ERROR`
(`services/agent-auth-gate.ts:5`), `AGENT_LIMIT_LABELS`
(`ws-handlers/agent-rate-limits.ts:13`), `PROVIDER_LABEL` ×2
(`provider-account-manager.ts:48`, `provider-route-preflight.ts:34`),
`LEGACY_CREDENTIAL_PATHS` / `LEGACY_CREDENTIAL_MARKERS`
(`provider-account-manager.ts:59,84`), `REVIEWER_DEFAULT_EFFORT`
(`reviewer-model.ts:93` — must be a level the harness actually offers;
guard-tested), client `harnessNames`
(`Settings/ProviderAccountRows.tsx:91`).

Also compiler-forced: the `switch` in `buildLocalAgentFactory`
(`orchestrator/app-di.ts:702` — exhaustive `never` default).

🚩 **Not** compiler-forced, despite looking like it: the four runtime tables
in `orchestrator/agents/index.ts` (`buildAgentRuntime`) are ordinary `Map`s
— widening `AgentId` does not error on a missing entry. `authManagers` is
keyed by `LoginIntegrationId` (self-keyed from each manager's `loginId`, so
it can't disagree with what it holds); `limitsProviders`, `runParamsPreps`,
and `parallelSessionsSections` are `Map<AgentId, …>` appended by hand — the
file header states the rule (one new folder + one entry per map), but only
review enforces it. Separately, `agent-instructions.ts:41` has its **own**
local `PARALLEL_SESSIONS_SECTIONS` map, deliberately *not* derived from
`buildAgentRuntime`'s (static module constants; also used by the Settings
baseline path with no app-DI context) — missing it silently gives the new
backend no parallel-sessions prompt fragment, and `PRECOMPUTED_INSTRUCTIONS`
grows from *this* map's keys, not the runtime one's.

### 5. 🚩 The silent sites — nothing forces these; work the list

String-literal validators that **drop or reject a new id**:

- `agent-registry.ts:490` `probedCredentialsFor` — hardcoded
  `claude`/`codex` ternary; a new backend's legacy auth probe returns
  `false`.
- `agent-registry.ts:522` `deriveHasRunnableModels` — same, in the
  no-credential-source fallback (workers, unit tests).
- `agent-registry.ts:226` `AUTH_ENV_KEYS` if the CLI has a key env var.
- `orchestrator/session-agent-credentials.ts:92,149` — persisted
  resident-route JSON parsing; a new id is silently dropped on read.
- `orchestrator/sessions.ts:356` — DB-row `agent_id` validator; same
  failure on SQLite read-back.
- `orchestrator/services/settings.ts:1242` `requireAccountService` — the
  provider-account HTTP surface throws 400 for any new id.
- `orchestrator/api-routes-files.ts:290,298` and
  `api-routes-marketplace.ts:41` — query-param validators, plus the
  Codex-only built-in-skills branch (the disable comment names the fix: an
  optional `getBuiltinSkills?()` method).
- `client/utils/local-storage.ts:122,182` — saved-agent and parked-harness
  validators; an unknown saved agent falls back to `"claude"`, an unknown
  parked harness is dropped (`undefined`).
- Defaults: `app-di.ts:611` (default agent), `keep-preview-running.ts:27`,
  `services/session-fork-merge.ts:113` — `?? "claude"` fallbacks; audit
  whether each should learn the new id.
- `orchestrator/provider-account-identity.ts:68` — reads account
  email/plan out of the credential root per backend; a new backend shows no
  identity on its account row until extended.
- `turn-executor.ts:620,903` — Claude-only `--resume`-invalid auto-recovery;
  decide whether the new CLI needs an equivalent.
- `token-sync-manager.ts:126,921,990,1017` — per-agent token freshness
  readers and stale-resume recovery; a new OAuth backend needs its own
  parser, and gets **no** stale-resume recovery until written.
- `orchestrator/session-agent-env.ts:1164` — Codex-style first-run home
  init (`ensureCodexHomeInitialized`); copy the shape if the CLI needs a
  seeded config root.
- MCP tool subsets are hardcoded **inside each adapter**
  (`claude/adapter.ts:578`, `codex/adapter.ts:597`) — the new adapter picks
  its own `SHIPIT_MCP_TOOLS` list; nothing centralizes it.
- `orchestrator/session-agent-credentials.ts:333,373` —
  `POST_PROVISION_CONFIG` / `LOCAL_WORKSPACE_TRUST`, optional
  (`Partial<Record<…>>`) per-agent hooks for post-provision config seeding
  and workspace-trust suppression. Claude-only today; the extension point
  for a CLI with onboarding or workspace-trust prompts (Cursor's `--trust`).
- `session/agent-shim/shipit.ts:118,270` — the shim help text's
  `--agent claude|codex` copy.
- `client/components/MessageList/cards/SubAgentCards.tsx:14` —
  `SUB_AGENT_DISPLAY_NAMES`; a missing entry shows the raw id on
  consult/spawn cards.

### 6. The session adapter — `src/server/session/agents/<id>/`

Mirror `claude/` or `codex/` per the shape table: `adapter.ts` implementing
`AgentProcess`, `tool-map.ts`, tests. Specifics that bite:

- `writeMcpConfig(ctx)` bundles Playwright + the `shipit` bridge + user
  servers in the CLI's own wire format, returning
  `{mcpConfigPath?, runtimeEnv?, cleanup?}`. `mcpServers` arrive with
  unresolved `$secret:` placeholders — the adapter resolves them.
- Env discipline at spawn: `resolveAgentHome()` → `scrubEnvAuthForScopedHome`
  → `applyServiceRouting` — the order is load-bearing
  (`claude/process.ts:527`). Add an `<x>Home()` helper in
  `shared/agent-home.ts` (resolve at call time, never module load) if the
  CLI has a config root.
- Permission gate: MCP-bridge prompt tool (Claude-shaped) or
  `setPermissionRequester()` + broker (Codex-shaped).
- Token usage: fill `AgentResultEvent.tokens/contextTokens/contextWindow`;
  overlapping cache figures need an `<id>-token-usage.ts` normalizer
  (`shared/codex-token-usage.ts` is the template — it is imported directly,
  not dispatched, so `session-namer.ts` needs the import too).
- Register in `session/agents/index.ts` (barrel), `tool-map.ts`
  `AGENT_TOOL_MAPS`, and `createWorkerAgent`
  (`session/session-worker.ts:807`) — **the one factory where a miss
  silently runs the wrong CLI**; extend
  `session-worker-agent-factory.test.ts` in the same commit.

### 7. The orchestrator folder — `src/server/orchestrator/agents/<id>/`

`index.ts`, `auth-manager.ts` (if subscription login), `limits-provider.ts`
(if quota display), `run-params-prep.ts`, `system-prompt.md` + `.ts` — then
one entry per table in `agents/index.ts`, and the local-mode factory switch
in `app-di.ts`.

- 🚩 The *existing* backends' system prompts name the other CLIs by name
  ("Do NOT invoke the raw `codex` CLI directly…" — `claude/system-prompt.md`,
  `codex/system-prompt.md`): a third backend means editing both, plus its own.
- Prompt fragments are module constants rendered once at load
  (`agent-instructions.ts` `PRECOMPUTED_INSTRUCTIONS` — the cartesian
  product grows from the map keys automatically, but the fragment must never
  be composed per-turn). Load the `prompt-architecture` skill before touching
  this.
- Agent-facing platform docs enumerate both CLIs by name:
  `src/server/shipit-docs/skills.md`, `environment.md`, `agent.md`, and
  `orchestrator/voice/cleanup-prompt.md`'s dictation vocabulary.

### 8. Client

- 🚩 Themes: two CSS files (`client/themes/<id>.css`, `<id>-light.css`) plus
  four edits in `client/index.css` (imports, `@custom-variant dark`
  selector, two shared rule blocks) and the hardcoded list in
  `hooks/useTheme.ts:13`.
- Auth card: `Settings/ServicesPanel.tsx` branches sign-in UX per provider
  (`paste` vs device-`code` shape, ~`:1216,1589`) — this is where the new
  backend's login flow plugs in. Also `ProviderAccountRows.tsx` (label
  table + Claude-only auth-output branch at `:609`),
  🚩 `SubscriptionLimitsBadge.tsx:29` first-party pill order (degrades
  gracefully), `Settings/roles/RoleEditor.tsx:167` cast.
- Picker/model plumbing (`agent-types.ts`, `harness-seed.ts`,
  `model-rows.ts`, `PermissionModeSelector.tsx`) is server-driven and mostly
  follows the catalogue ✅ — read `harness-seed.ts` for the "a harness pick
  must move the model seed" rule.

### 9. Tests to extend

Build-breaking by design (good — they *are* the checklist):
`agent-cli-install.test.ts` (catalogue↔installer↔Dockerfile parity),
`catalogue.test.ts`, `session-worker-agent-factory.test.ts`,
`session/agents/agent-registry.test.ts` (asserts exactly 2 agents and their
order — will fail), `tool-map.test.ts`.

Want a new case or sibling file: `shared/agent-registry.test.ts` +
`agent-registry-signout.test.ts` (or refactor them to iterate
`KNOWN_AGENT_IDS`), integration tests `agent-registry`, `http-mutations`,
`http-bootstrap` (`/api/agents` payload per id), a sibling of
`codex-auth.test.ts` / `codex-agent.test.ts` for the new backend,
`reviewer-model.test.ts`, and the client fixtures
(`useServerEvents.test.ts`, `harness-seed.test.ts`,
`ProviderAccountRows.test.tsx`, `ServicesPanel.test.tsx`, …). The shared
fake agent (`integration_tests/test-helpers.ts:722`) hardcodes
`agentId = "claude"`.

### 10. Empirical verification before calling it done

- Run the docs/209 skill-disclosure probe against the real CLI.
- Capture a real turn's event stream in a container and lock it with a
  conformance test (mandatory when the schema is undocumented — Grok).
- One dogfood turn per auth mode (subscription file-injection AND api-key
  env), verifying the billing route via the scrub/shaping path — a
  `HARNESS_CREDENTIAL_VARS` miss is invisible except on the bill.
- Verify `shipit agent run` cross-agent spawning works both directions
  (per-agent credential isolation provisions the sub-agent's
  `AGENT_CREDENTIAL_PATHS` into the parent's session dir).

## Known pre-existing defects a third harness worsens

- `services/reviewer-settings.ts:28` derives a reviewer pin's harness via
  `harnessesForSelection(...)[0]`; `roles.ts`'s header flags that a
  reasoning level validated against one harness can be carried onto another
  — more reachable with three harnesses.
- `services/child-sessions.ts:367` `agentIdForModel` picks the *first*
  harness offering a shared model id — adding a harness can silently change
  which one wins for gateway/shared models (DeepSeek, GLM).

Both belong to the integration PR's review checklist, not necessarily its
diff.
