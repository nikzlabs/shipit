---
issue: planning#718
title: OpenCode on a Claude subscription — design
description: Route the Anthropic subscription login to the OpenCode 2 harness through its built-in Claude Code bridge.
---

# OpenCode on a Claude subscription — design

Implements [requirements.md](./requirements.md).

## Upstream facts (probed 2026-11-09)

OpenCode 2 does not talk to Anthropic with the subscription token itself. It
runs the user's installed `claude` CLI through Anthropic's Claude Agent SDK, and
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

**OpenCode 1 has no route of its own.** Neither the version ShipIt installs
(1.19.0), the newest release (1.19.5) nor the nightly build carries the
provider, the SDK or `OPENCODE_CLAUDE_PATH`. The only way was the archived
community plugin `@openchamber/opencode-claude@0.14.0`; it worked when probed,
but reported about 79k input tokens for a one-line turn where OpenCode 2
reported 6 plus cache reads. On 2026-11-09 the user took OpenCode 1 out of
scope (req 2), so ShipIt ships no plugin.

## Terms

ShipIt already runs the unmodified Claude Code CLI on the user's own
subscription. On this route it still does — OpenCode 2 drives it through the
Agent SDK, and neither OpenCode nor ShipIt sends the token anywhere. Anthropic's
Agent SDK overview says third-party products need prior approval to offer
claude.ai login; whether this route needs that is the operator's call, not a
technical gate. The user asked for the route on 2026-11-09.

## Design

**Catalogue (reqs 1, 2).** OpenCode 2 lists `anthropic-messages` in
`spawn.credential.account.styles` (`shared/catalogue/harnesses.ts`), so the
eligibility join admits the Anthropic `sub` mode's `anthropic-oauth` login;
OpenCode 1's account target stays ChatGPT-only. The pasted
`ANTHROPIC_AUTH_TOKEN` keeps `carriers: ["claude"]`: OpenCode 2 takes the
login, never a pasted token. That makes Anthropic `sub` the one mode whose
credentials disagree per harness, so the add-service "one answer per mode
cell" test names it as the exception.

**Routing.** `serviceRoutingForSelection` (`orchestrator/service-routing.ts`)
returns an `AnthropicAccountRouting` — `credentialTarget: { kind:
"anthropic-oauth", accountId }` — for an OpenCode harness on Anthropic `sub`
with an account route whose style resolves, which the catalogue allows for
OpenCode 2 only. Claude Code still takes no routing for it.

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

**Adapter.** The OpenCode 2 adapter gains a third account branch beside ChatGPT
and strings (`isOpenCodeClaudeRouting`, `opencode2ClaudeConfig`,
`prepareOpenCodeClaudeEnv` in `shared/opencode-spawn-shaping.ts`); OpenCode 1's
adapter is unchanged:

- the config makes the Claude provider the only enabled one
  (`enabled_providers`, `model`, `small_model`), so a credential another route
  left in OpenCode's store serves nothing, title generation included;
- the config declares the catalogue model under `claude-agent` with `id:
  claudeModelArg(model)` — the vendor id and `[1m]` Claude Code would be given
  — and one variant per Claude effort; `none`/`minimal` are dropped;
- the model flag is `claude-agent/<model>#<effort>`; compaction uses the same
  provider id;
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`,
  `OPENCODE_CONFIG_CONTENT` (an inline config loads after ShipIt's file),
  `OPENCODE_CLAUDE_PATH` (it would pick another `claude`) and
  `SHIPIT_CREDENTIAL_*` are removed, on top of the existing harness scrub of
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so `HOME/.claude` is the only
  login `claude` can find;
- a home with no `.claude/.credentials.json` asks for sign-in before anything
  is spawned, and a 401 does too.

**Install.** `install-agent-clis.sh` adds `claude` to the required CLIs
whenever OpenCode 2 is selected (the same shape as the Codex dependency for
ChatGPT). `docker/agent-cli/package.json` pins `@opencode/cli` 2.2.5, which
bundles its SDK; nothing else is added.

**Automatic harness choice (req 4).** Nothing new decides it. The reviewer
puts the implementer's harness last (`harnessesPreferring`), so for a Claude
Code session whose only credential is a Claude subscription it now lands on an
OpenCode 2 when it is installed, which req 4 allows. Background work takes the first eligible
harness in catalogue order with nothing to avoid (`backgroundWorkHarnessFor`),
and Claude Code is first, so it stays on Claude Code whenever that harness is
installed; `non-turn-model.test.ts` pins both cases.

## Verification

Through ShipIt's real `Opencode2Adapter` and the real 2.2.5 binary, on a home
holding only `.claude/.credentials.json`: a tool turn (`write` + `shell`,
normalized to Write and Bash), usage on `agent_result`, and a resumed second
turn that recalled the first. It was re-run after the review fixes, with an
inherited `OPENCODE_CONFIG_CONTENT` that named another model.

Req 3 on the 2.2.5 binary: the API-key route against a local mock reached
`<base>/v1/messages` with the key in `x-api-key` and turned the 401 into an
error result; the ChatGPT credential ShipIt builds
(`openCode2CredentialImport`, fake token) went through `auth import`, `auth
switch` and `auth logout` on a turn-style server. A real ChatGPT turn needs a
ChatGPT login this session does not have.

Not run: a dogfood turn through the orchestrator, a container built from the new
lockfile, an expired-token refresh mid-turn, and a real ChatGPT turn.

Reviewed by ShipIt's configured reviewer in four rounds while OpenCode 1 was
still in scope; every finding was applied, and the last round found nothing
blocking. The OpenCode 1 removal was reviewed separately.

## Known limits

- OpenCode 1 cannot use a Claude subscription (req 2).
- In a home where the `claude` CLI has never run, the second turn misses the
  cache once: the CLI's own system prompt changes after its first request
  (docs/333 plan, "Verify first" 1c). Idle compaction covers this route with
  the CLI's one-hour cache.
