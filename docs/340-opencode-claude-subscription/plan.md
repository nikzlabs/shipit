---
issue: planning#718
title: OpenCode on a Claude subscription — design
description: Route the Anthropic subscription login to both OpenCode harnesses through OpenCode's own Claude Code bridge.
---

# OpenCode on a Claude subscription — design

Implements [requirements.md](./requirements.md).

## Upstream facts (probed 2026-11-09)

Neither OpenCode talks to Anthropic with the subscription token itself. Both
run the user's installed `claude` CLI through Anthropic's Claude Agent SDK, and
Claude Code does the model calls. OpenCode keeps its own tools: Claude Code's
built-in tools are switched off and OpenCode's are bridged in as MCP tools, so
ShipIt's tool normalizers see the usual OpenCode tool events.

Probed in scratch folders under `/persist` with a copy of this container's
Claude login (the access token was valid, so no refresh ran; the token
fingerprints were unchanged afterwards):

**OpenCode 2 — built-in `claude-agent` provider, from 2.2.3** (`@opencode/cli`;
2.2.5 probed, the newest release past the 7-day cooldown).

- The SDK is bundled in the binary. It finds the CLI through
  `OPENCODE_CLAUDE_PATH`, else `claude` on `PATH`, and inherits the server's
  environment, so `HOME` decides which `.claude` login it reads.
- No `auth login claude-agent` step is needed. A fresh data root, a turn sent
  right after `serve` came up, and `GET /api/integration/claude-agent` still
  listing `connections: []` ran a turn.
- The provider's own model list is Claude Code's aliases (`opus`, `sonnet`,
  `haiku`, `fable`) plus whatever the CLI reports, filled in by a background
  probe. A catalogue id such as `claude-opus-5-5` is unavailable until the
  config declares it under `provider["claude-agent"].models`; a declared model
  needs its `variants` (`{ effort: <level> }`) or `#<level>` is refused with
  `provider.no-route`.
- Probed: a text turn (`--format json`, `#low`), a turn with OpenCode's
  `write` and `shell` tools, and usage on `step_finish`.
- 2.2.3's two breaking changes (TUI plugin peer versions, managed-policy
  `integration.use`) touch nothing ShipIt uses.

**OpenCode 1 — the community plugin `@openchamber/opencode-claude@0.14.0`**
(MIT; 0.14.x is the line for OpenCode 1.x, the repository is archived since
OpenCode 2.2.3 made it unnecessary there). No built-in route exists on 1.x.

- Loaded by absolute `file://` path in `plugin`, it still loads with
  `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`.
- The provider id is `claude-code`. Like OpenCode 2, a catalogue id has to be
  declared under `provider["claude-code"].models`.
- It runs a loopback OpenAI-compatible proxy in-process and calls the SDK's
  `query()` with `pathToClaudeCodeExecutable` set to `claude` found on `PATH`,
  so the SDK's own 327 MB platform binary
  (`@anthropic-ai/claude-agent-sdk-<platform>`) is never used.
- Its child environment drops `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN` and keeps `HOME`, so the login comes from the
  `.claude` under `HOME`.
- Probed with ShipIt's v1 flags: `--format json`, `--variant low`, a
  declared `claude-opus-5-5`, and the `write` + `shell` tools.

## Terms

ShipIt already runs the unmodified Claude Code CLI on the user's own
subscription. On this route it still does — OpenCode drives it through the
Agent SDK, and neither OpenCode nor ShipIt sends the token anywhere. Anthropic's
Agent SDK overview says third-party products need prior approval to offer
claude.ai login; whether this route needs that is the operator's call, not a
technical gate. The user asked for the route on 2026-11-09.

## Design

**Catalogue (reqs 1, 2).** Both OpenCode harnesses list `anthropic-messages`
in `spawn.credential.account.styles` (`shared/catalogue/harnesses.ts`), so the
eligibility join admits the Anthropic `sub` mode's `anthropic-oauth` login. Its
pasted `ANTHROPIC_AUTH_TOKEN` keeps `carriers: ["claude"]`: OpenCode takes the
login, never a pasted token. That makes Anthropic `sub` the one mode whose
credentials disagree per harness, so the add-service "one answer per mode
cell" test names it as the exception.

**Routing.** `serviceRoutingForSelection` (`orchestrator/service-routing.ts`)
returns an `AnthropicAccountRouting` — `credentialTarget: { kind:
"anthropic-oauth", accountId }` — for an OpenCode harness on Anthropic `sub`
with an account route. Claude Code still takes no routing for it.

**Credentials: OpenCode borrows Claude's layout.** The `claude` CLI that
OpenCode runs reads `~/.claude`, so the session must hold exactly what a Claude
Code session holds. `accountCredentialHarness(harness, serviceId)`
(`orchestrator/provider-account-manager.ts`) answers `claude` for an OpenCode
harness on an Anthropic account and the harness itself otherwise, and every
account-keyed step takes that answer:

- turn preparation (`session-agent-env.ts`): `ensureSessionAccountCredentials`,
  `ensureAgentTokenFresh`, `syncProviderAccountTokenIn`,
  `startTokenWriteBackWatch`, and `markAccountUsed` on the route's own
  service; the ChatGPT projection is revoked for such a turn;
- turn end (`finalizeSessionAgentEnvironment`) and the 401 re-push
  (`repushSessionAgentToken`);
- `shipit agent run` and background work (`services/sub-agent.ts`,
  `services/non-turn-work.ts`): the spawn home is provisioned as Claude's,
  with Claude's provenance.

The session account marker therefore reads `claude: <accountId>`, which is the
key the Claude refresher's harvest and `syncProviderAccountTokenBack` already
filter on — so token rotation, harvest and write-back need no change of their
own. The route's service comes from the credential store
(`getCredentialRoute(id).serviceId`), where accounts live.

Where a step is keyed by harness rather than by the session's files, it now
asks the account instead:

- the refresher lookup and the auth-required nudge (`bootstrap-managers.ts`,
  `refresherHarnessFor`) take the failing account id, so a 401 on the Claude
  route forces Claude's refresher, not Codex's (`turn-executor.ts`
  `recoverAuth`, `agent-auth-handler.ts`);
- the scheduled re-push after a refresh (`oauth-account-repush.ts`) also
  reaches any session whose marker holds the account, whatever its harness;
- account status (`markProviderAccount{Un,Re}authenticated`,
  `app-lifecycle.ts`) and the diagnostics label (`api-routes-container.ts`)
  read the account's own service;
- session naming (`services/graduate-session.ts`): a background-model target
  on OpenCode with a Claude account names on Claude Code instead — same model,
  same account — because the orchestrator's namer drives OpenCode on ChatGPT
  only, and its Claude Code path already runs in a private copy of the login.
  An OpenCode-only install carries `claude` without offering its harness, so
  the namer checks `isHarnessCliPresent` (`shared/installed-harnesses.ts`, a
  table mirroring the installer's `required_clis`) instead of the offered set.

**Local mode** has no write-back and no refresher, so a copy's rotation would be
lost. There the session's `.claude` and `.claude.json` are linked to the
account's own files (`linkAgentHomeToCredentials` with the session folder as
home) — the same thing a local Claude Code turn does through `HOME`.

A failed Claude login on OpenCode is vendor-owned recovery
(`credential-failure-policy.ts`), as on the ChatGPT route.

**Adapters.** Both adapters gain a third account branch beside ChatGPT and
strings (`isOpenCodeClaudeRouting`, `opencodeClaudeConfig`,
`prepareOpenCodeClaudeEnv` in `shared/opencode-spawn-shaping.ts`):

- the config makes the Claude provider the only enabled one
  (`enabled_providers`, `model`, `small_model`), so a credential another route
  left in OpenCode's store serves nothing, title generation included;
- the config declares the catalogue model under `claude-agent` (OpenCode 2) or
  `claude-code` (OpenCode 1, plus `plugin: ["file://<plugin>"]`) with `id:
  claudeModelArg(model)` — the vendor id and `[1m]` Claude Code would be given
  — and one variant per Claude effort; `none`/`minimal` are dropped;
- the model flag is `claude-agent/<model>#<effort>` or `claude-code/<model>`
  with `--variant`; compaction uses the same provider id;
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`,
  `OPENCODE_CONFIG_CONTENT` (an inline config loads after ShipIt's file),
  `OPENCODE_CLAUDE_PATH` (it would pick another `claude`) and
  `SHIPIT_CREDENTIAL_*` are removed, on top of the existing harness scrub of
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so `HOME/.claude` is the only
  login `claude` can find;
- a home with no `.claude/.credentials.json` asks for sign-in before anything
  is spawned, and a 401 does too; a missing OpenCode 1 plugin is an error, since
  reconnecting the account cannot fix it.

**Install.** `install-agent-clis.sh` adds `claude` to the required CLIs
whenever an OpenCode harness is selected (the same shape as the Codex
dependency for ChatGPT), deletes the SDK's platform CLI packages
(`@anthropic-ai/claude-agent-sdk-*`), and deletes the plugin when OpenCode 1 is
not selected. `docker/agent-cli/package.json` pins `@opencode/cli` 2.2.5 and
`@openchamber/opencode-claude` 0.14.0, and overrides three transitive packages:
the SDK to 0.3.312 (its range resolved to a release published that day), and
`toml` 5.0.1 under `effect` and `zod` 4.6.7 under `@opencode-ai/plugin`, which
clear the five `high` advisories the plugin's tree brought in.

## Verification

Through ShipIt's real adapters (`Opencode2Adapter`, `OpencodeAdapter`) and real
binaries, on a home holding only `.claude/.credentials.json`: a tool turn
(`write` + `shell`, normalized to Write and Bash), usage on `agent_result`, and
a resumed second turn that recalled the first. OpenCode 1's plugin was loaded
from a scratch install because `/opt/agent-cli` is read-only in the session; the
test swapped only that path in the written config. Both were re-run after the
review fixes, with an inherited `OPENCODE_CONFIG_CONTENT` that named another
model.

Req 3 on the 2.2.5 binary: the API-key route against a local mock reached
`<base>/v1/messages` with the key in `x-api-key` and turned the 401 into an
error result; the ChatGPT credential ShipIt builds
(`openCode2CredentialImport`, fake token) went through `auth import`, `auth
switch` and `auth logout` on a turn-style server. A real ChatGPT turn needs a
ChatGPT login this session does not have.

Not run: a dogfood turn through the orchestrator, a container built from the new
lockfile, an expired-token refresh mid-turn, and a real ChatGPT turn.

Reviewed by ShipIt's configured reviewer in four rounds; every finding was
applied, and the last round found nothing blocking.

## Known limits

- OpenCode 1 reported about 79k input tokens for a one-line turn where OpenCode
  2 reported 6 plus cache reads; the plugin documents that it replays the
  conversation into Claude Code, so it spends more of the plan per turn.
- The OpenCode 1 plugin's repository is archived; 0.14.x is its last line for
  OpenCode 1.x.
- Idle compaction still skips both (OpenCode 1 assumes a 5-minute cache for a
  Claude model; OpenCode 2 is unprobed), which is the safe default.
