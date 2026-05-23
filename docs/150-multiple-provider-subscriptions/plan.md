---
status: planned
priority: high
description: Allow multiple subscription accounts for the same agent provider and automatically fail over when the active subscription is exhausted.
---

# 150 — Multiple provider subscriptions and quota failover

## Problem

ShipIt currently assumes **one subscription credential per agent provider**:

- Claude Code auth is stored once under the root credentials source and copied
  into a pinned Claude session.
- Codex subscription auth is stored once under `.codex/auth.json`.
- The subscription-limits badge is keyed by agent id (`claude`, `codex`), not by
  account.
- `AgentRegistry.authConfigured` is boolean per agent, so the UI only knows
  "Claude is configured" or "Codex is configured."

That breaks down for heavy users who have multiple legitimate subscriptions for
the same provider. Example: a user exhausts their Claude Max subscription during
a long work session and wants ShipIt to continue by automatically switching to a
second Anthropic account/subscription, without making the user leave ShipIt,
manually sign out, sign into another browser profile, restart containers, or
copy credentials around.

The product shape should be:

1. User connects multiple accounts for the same provider in ShipIt Settings.
2. ShipIt shows each account's quota state inline.
3. When a session starts, ShipIt chooses the best available account.
4. If the current account hits a hard limit during a turn, ShipIt retries on the
   next eligible account when the operation is safe to retry.
5. Sessions record which provider account was used so credential isolation and
   auditability stay intact.

This doc uses "provider account" to mean one authenticated subscription identity
for one agent provider. For Claude, that is one Anthropic/Claude Code account.
For Codex, that is one ChatGPT/Codex account.

## Goals

- Support **multiple authenticated accounts per provider** (`claude`, `codex`)
  while keeping the existing single-account path as a compatible default.
- Automatically select a non-exhausted account for new turns, preferring the
  user's chosen primary account until it is near or at quota.
- Automatically fail over after a hard quota/auth exhaustion signal when retrying
  will not duplicate side effects.
- Render provider-account state inline: account label, provider, plan, quota
  windows, active/in-use sessions, errors, and reset time.
- Preserve per-agent credential isolation from doc 138 and token copy-back from
  doc 142, extended from "agent" to "agent provider account."
- Avoid external operational loops. Provider login/billing pages remain allowed
  escape hatches; quota inspection, switching, and retry decisions happen inside
  ShipIt.

## Non-goals

- Circumventing provider terms, shared-account controls, or anti-abuse systems.
  ShipIt only uses accounts the user explicitly authenticates.
- Pooling subscriptions across different ShipIt users.
- Splitting a single agent turn across accounts. One turn runs with one provider
  account; failover means retrying a turn or starting a future turn.
- Switching from Claude to Codex because Claude is exhausted. Cross-provider
  model substitution changes behavior too much and stays a separate explicit
  user choice.
- Shell-shaped quick actions such as "run this with account B" buttons. The user
  expresses intent in chat or Settings; ShipIt performs the account routing.
- Guaranteeing retry safety after arbitrary tool execution. Some turns cannot be
  safely retried automatically; those become visible recoverable states.

## Product behavior

### Settings

Settings gets an **Agent accounts** section grouped by provider:

- Claude
  - Primary Anthropic account
  - Work Anthropic account
- Codex
  - Personal ChatGPT account
  - Team ChatGPT account

Each row shows:

- Human label editable by the user.
- Provider and plan/tier, when known.
- Status: ready, authenticating, exhausted, auth failed, unavailable.
- Short-window and weekly usage, reusing the subscription-limits visual language.
- Reset time for exhausted windows.
- Overflow actions: rename, make primary, disconnect, open billing/account page.

Adding an account launches the provider's normal auth flow. OAuth/account/billing
pages are allowed external tabs under the product principles; everything after
auth returns to ShipIt and is rendered inline.

### Session startup

For a new turn, the router chooses a provider account before credential
provisioning:

1. Filter to accounts that are eligible for the selected model, permission mode,
   and requested provider features.
2. If the session already has a pinned provider account and it is still usable,
   keep using it.
3. Otherwise prefer the provider's primary account.
4. Skip accounts known to be exhausted until their reset time.
5. Prefer accounts with the most remaining weekly quota; use short-window quota
   as the tiebreaker.
6. If all eligible accounts are exhausted, put the prompt into a delayed
   recoverable state with a wake-up time, show a chat-visible system message
   with reset times, and do not start the agent.

Eligibility is checked before quota ranking. A fallback account that cannot run
the selected model, requested permission mode, image support, MCP/review
capability, or other provider-gated feature is not a valid substitute for the
turn. This matters because two accounts for the same provider can have different
plans, enterprise policy, regional access, beta flags, or model availability.
Failover must not silently downgrade behavior. If no account can satisfy the
current turn's feature requirements, ShipIt surfaces that as an account/model
availability problem instead of trying a lower-capability subscription.

An exhausted turn cannot use the existing in-memory message queue by itself.
Today queued messages drain from agent completion paths; if no agent starts,
there is no completion event to wake the queue after a quota reset. Delayed
quota waits therefore need their own persisted/scheduled state:

- persist the full turn request in a delayed-turn table or session field:
  user text, validated file refs, upload refs, image refs, permission mode,
  review-file authorization, selected model, selected agent, target provider,
  and the assembled prompt/context snapshot needed to restart deterministically,
- schedule an orchestrator timer for the earliest eligible reset,
- re-check account eligibility/quota at wake time before starting,
- revalidate that referenced files/uploads still exist and surface a recoverable
  error instead of starting with silently missing context,
- broadcast the delayed state so reconnecting clients show why the prompt is not
  running,
- allow the user to cancel or replace the delayed prompt from chat.

If the process restarts before the reset, startup tasks reload delayed turns and
re-arm their timers.

### Mid-turn failover

Automatic retry is conservative:

- **Safe retry:** the agent failed before any side-effecting tool call, or the
  failure happened during initial provider/model request before tool execution.
  ShipIt switches to the next eligible provider account and retries once.
- **Needs user intent:** the turn already wrote files, ran commands, modified git,
  called MCP tools, or created external side effects. ShipIt stops, records the
  exhausted account, surfaces the next eligible account, and asks the user in chat
  whether to continue from the current workspace state.
- **No retry:** all accounts are exhausted or unauthenticated.

This mirrors the existing product stance: the agent is the actor, but ShipIt does
not silently duplicate side effects.

Safe retry is a same-turn retry, not a new user message. The implementation must
avoid duplicating chat history:

- persist the user's prompt once for the turn,
- clear or replace failed in-progress assistant output before the retry,
- record the account failover as a system event attached to the same turn,
- restart the agent with the same assembled prompt and updated account metadata,
- skip the normal `persistUserMessage` path on the retry attempt.

This matters because `runAgentWithMessage` currently persists the user message
around the `agent_init` path and may already have in-progress assistant rows.
Failover retry needs explicit attempt state (`turnAttempt`, `isRetry`,
`originalMessageId` or equivalent) so it updates the existing turn instead of
creating a second copy of the same prompt.

### Existing pinned sessions

Sessions need two persisted fields:

- `agent_id` — existing provider/agent (`claude`, `codex`).
- `provider_account_id` — new selected account for that provider.

`agent_pinned` remains the first-turn boundary. On first turn, ShipIt pins both
the agent and the provider account. The agent itself does not change.

Provider-account switching after pinning is **not** a credential-only operation.
The existing runtime has account-bound process and thread state:

- Live steering reuses an existing worker-side process via
  `existingAgent.sendUserMessage(...)` rather than calling `/agent/start`.
- `agentSessionId` is persisted on the ShipIt session and passed back to adapters
  for provider-side resume/thread continuation.
- The mounted per-session credential subtree contains files for the previously
  selected account.

So an account switch for an already-pinned session must be a full runtime
transition:

1. Stop the persistent agent process, if one exists, before switching accounts.
   Reusing the old process would keep sending requests with account A.
2. Clear the stored `agentSessionId` unless the provider explicitly supports
   cross-account conversation migration. Claude and Codex should be treated as
   **not** supporting it: account B cannot resume account A's Claude session or
   Codex thread.
3. Replace the provider credential subtree in the session credential directory
   with account B's subtree before the next `/agent/start`.
4. Start a new provider-side conversation and reconstruct context from ShipIt's
   local chat history / current workspace state, not from provider resume.
5. Record a chat-visible system event that the session moved from account A to
   account B and provider-side resume was reset.

Automatic account switching is therefore allowed only at a turn boundary or in a
safe pre-tool retry path. If a persistent process is alive, the router first
terminates it and restarts from local context. Token sync-in alone is never
sufficient for account switching.

## Data model

Add a provider-account registry to `CredentialStore`:

```ts
interface ProviderAccount {
  id: string;
  provider: AgentId; // "claude" | "codex"
  label: string;
  isPrimary: boolean;
  status: "ready" | "authenticating" | "exhausted" | "auth_failed" | "unavailable";
  plan?: string | null;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  quota?: SubscriptionLimits;
  createdAt: number;
  updatedAt: number;
}
```

Credential files move from provider-singleton paths to account-qualified paths:

```text
/credentials/provider-accounts/
  claude/
    acct_<id>/
      .claude/
      .claude.json
  codex/
    acct_<id>/
      .codex/
```

The existing root `.claude` and `.codex` paths become the migrated default
accounts:

- `claude-default` if a root Claude credential exists.
- `codex-default` if a root Codex credential exists.

For backward compatibility, singleton helper methods continue to resolve the
primary account until all call sites are migrated.

### Agent availability gates

`AgentRegistry.authConfigured` remains a coarse agent-level signal for existing
UI and server gates, but its meaning changes:

- `claude.authConfigured = true` when at least one authenticated Claude provider
  account exists, even if every account is currently quota-exhausted, or a
  supported non-subscription Claude auth fallback exists.
- `codex.authConfigured = true` when at least one authenticated Codex
  subscription account exists, even if exhausted, or `OPENAI_API_KEY` is
  configured.
- `AgentRegistry.available()` answers only "can this provider be attempted at
  all?" It does not choose an account and does not guarantee the selected model
  can run.

Per-turn validation moves to `ProviderAccountManager`. Existing call sites that
currently stop at `agentRegistry.get(id)?.authConfigured` must either:

1. keep using it only for broad UI availability, or
2. call `ProviderAccountManager.selectAccountForTurn(...)` before starting work.

Auth refresh events update both layers: the provider-account row is refreshed
first, then `AgentRegistry.refreshAuth(provider)` recomputes the coarse boolean
from provider-account state plus fallback env auth.

Quota exhaustion is not authentication failure. An exhausted account remains
authenticated and should not make Settings or model pickers show "not signed in."
`ProviderAccountManager.selectAccountForTurn(...)` returns structured failures
such as `all_exhausted`, `no_model_eligible_account`, or `auth_required`; only
the last one changes auth UI state.

## Server architecture

### New `ProviderAccountManager`

Responsibilities:

- CRUD for account metadata in `CredentialStore`.
- Start/cancel auth flows for a specific provider account.
- Resolve the credential source directory for `{ provider, accountId }`.
- Mark accounts exhausted/auth-failed based on runtime signals.
- Select the best account for a turn.
- Emit SSE events when account status or quota changes.

The manager is app-scoped and injected through `buildApp()` alongside
`AuthManager`, `CodexAuthManager`, and `CredentialStore`.

### Auth managers become account-scoped

Current managers assume one root credential location. Extend them to accept an
account credential root:

```ts
startAuthFlow({ accountId, credentialDir })
checkCredentials({ accountId, credentialDir })
signOut({ accountId, credentialDir })
getAccessToken({ accountId, credentialDir })
```

This requires more than changing read paths. The current `AuthManager` and
`CodexAuthManager` spawn provider CLIs that write to hardcoded default locations
inside the orchestrator container (`/root/.claude`, `/root/.claude.json`,
`/root/.codex/auth.json`). The account-scoped implementation must explicitly
force each auth subprocess to write to the target account directory.

Implementation options, in preferred order:

1. **Per-flow temporary HOME/config root.** Spawn the provider CLI with a
   temporary `HOME` whose `.claude` / `.codex` paths are symlinks to
   `provider-accounts/<provider>/<accountId>/...`. This avoids mutating the
   orchestrator's real root symlinks and permits concurrent auth flows for
   different accounts.
2. **Provider config env vars, if stable.** If a provider CLI exposes a supported
   config-dir override, use it instead of `HOME`.
3. **Serialized symlink rebinding.** Temporarily repoint `/root/.claude` or
   `/root/.codex` at the account directory while the login process runs. This is
   a fallback only because it must be globally serialized per provider and is
   risky while other code reads root paths.

Each auth flow's pending state becomes keyed by `{ provider, accountId }`:

- in-flight process handle,
- last pending URL/code event,
- timeout,
- output buffer,
- completion/failure state.

Starting auth for account A must not block or overwrite the pending event for
account B, except where a provider-specific global CLI constraint forces
serialization. Existing singleton events (`auth_url`, `codex_auth_pending`,
`auth_complete`) become account-qualified SSE payloads so the Settings row for
the correct account updates.

### Credential provisioning

Extend `session-credentials.ts` from:

```ts
provisionAgentCredentials(root, sessionId, agentId)
```

to:

```ts
provisionProviderAccountCredentials(root, sessionId, {
  provider: agentId,
  accountId,
})
```

The per-session credential subtree receives only the chosen provider account's
credential files. A Claude session using account A never receives Claude account
B, Codex credentials, or root `shipit-credentials.json`.

Token sync-in/sync-back from doc 142 becomes account-scoped:

- Sync in from `provider-accounts/<provider>/<accountId>/...`.
- Sync back only to the same provider account source.
- Expiry/freshness guards remain provider-specific.
- Re-auth re-push from doc 142 A3 becomes account-scoped too. On auth completion
  for account X, force-copy the fresh source token only into sessions pinned to
  `{ provider, accountId: X }`; do not re-push to every session pinned to the
  provider. Auth completion events must therefore include `accountId`.

### Agent startup

`AgentRunParams` should not carry raw credentials. The orchestrator selects the
account before runner start and provisions files into the session credential
subtree. The worker/adapter continues to see normal CLI paths:

- Claude: `/root/.claude` and `/root/.claude.json`.
- Codex: `/root/.codex`.

Provider-account metadata is orchestrator-owned. The adapters and worker do not
know which account the orchestrator selected; they only see normal CLI paths
after credentials are provisioned. Therefore account fields must be added either
by:

1. passing non-secret metadata in `AgentRunParams` (`providerAccountId`,
   `providerAccountLabel`) so `ProxyAgentProcess`/local adapters can echo it, or
2. decorating `agent_init` in `wireAgentListeners` / `runSystemTurn` before
   emitting or persisting it.

Prefer decoration at the orchestrator boundary so the worker remains credential
agnostic. The emitted `agent_init` extension is:

```ts
providerAccountId?: string;
providerAccountLabel?: string;
```

This gives chat history and diagnostics an audit trail without exposing secrets.

### Runtime modes

Multi-account routing must work in both full container mode and local/dogfood
mode.

In full container mode, account selection is implemented by writing the selected
account's credential subtree into the session's mounted `/credentials/sessions`
directory before worker `/agent/start`.

In local/dogfood mode, there is no per-session credentials mount and direct
`SessionRunner` processes currently read singleton `/root/.claude` /
`/root/.codex`. The implementation must therefore spawn direct agents with an
account-scoped credential environment, using the same preferred strategy as auth
flows:

- temporary `HOME` / config root whose `.claude` or `.codex` points at the
  selected provider account, or
- a stable provider config-dir override if one exists.

Do not implement multi-account routing by rebinding the global `/root/.claude`
or `/root/.codex` for local turns; concurrent local sessions would race. If a
provider CLI cannot be safely pointed at an account-specific config root in
local mode, multi-account failover for that provider must be disabled there with
an explicit inline diagnostic rather than silently using the singleton account.

### Shared turn preflight

Account routing, credential provisioning, token sync-in, and failover prechecks
must live in a shared server-side turn preflight, not only in the WebSocket
`runAgentWithMessage` path. Several production paths start turns without a
viewer-attached WS:

- `SessionRunner.sendSystemMessage` / `ContainerSessionRunner.sendSystemMessage`
  call `runSystemTurn`.
- Agent-spawned child sessions call `sendSystemMessage` for the initial prompt
  and for follow-up messages from `shipit session send`.
- GitHub CI auto-fix sends a system prompt through `sendSystemMessage`.
- `handleAnswerQuestion` can resume a blocked question flow by directly calling
  `agent.run(...)`.
- Rebase/conflict recovery services can start agent turns outside the chat WS
  path.

Create one orchestrator helper, for example `prepareProviderAccountTurn(...)`,
that every turn entrypoint must call before `agent.run()` or
`existingAgent.sendUserMessage(...)`. It is responsible for:

- resolving or pinning `provider_account_id`,
- deciding whether an existing process can be reused,
- killing/restarting a persistent process when account switch is required,
- clearing provider resume state on account switch,
- provisioning account-qualified credentials,
- syncing the account token in before start,
- returning metadata used to decorate `agent_init`,
- recording enough state to sync the token back after completion.

`runAgentWithMessage`, `handleAnswerQuestion`, `runSystemTurn`,
child-session send/spawn paths, CI-fix paths, rebase/conflict recovery, and any
future server-initiated turns all use that helper. This keeps failover behavior
identical whether the turn was started by chat, by an answer to a blocked tool
question, by the agent via `shipit session create`, or by a server automation.

### Quota and exhaustion detection

Doc 135's limits map changes from agent-keyed to account-keyed:

```ts
type SubscriptionLimitsMap = Record<
  AgentId,
  Record<string, SubscriptionLimits>
>;
```

Claude can poll quota per account using that account's OAuth token. Codex remains
event-fed where possible; its rate-limit event must be associated with the
account used by the current runner.

Codex needs an explicit unknown-quota state because the current implementation
has no reliable out-of-band usage fetch. A Codex account may be authenticated and
ready while `quota` is still unknown until a turn emits
`account/rateLimits/updated`.

Selection policy with unknown quota:

1. Never treat unknown quota as exhausted.
2. Prefer a ready account with fresh known quota over unknown quota when both are
   otherwise equivalent.
3. Prefer the user's primary account over a non-primary unknown account.
4. If every eligible Codex subscription account has unknown quota, choose the
   primary account and record that the first turn will hydrate its quota.
5. Once a Codex snapshot arrives, update only the account used by that runner.

The `OPENAI_API_KEY` fallback from doc 119 is **not** a subscription account and
does not participate in subscription quota ranking. Model it separately as a
provider auth fallback:

- It may make `codex` runnable when no ChatGPT subscription account exists.
- It does not render a subscription-limits pill.
- It is never selected for "switch to another subscription" failover.
- If both a Codex subscription account and `OPENAI_API_KEY` exist, subscription
  credentials remain preferred so Platform API billing is not used silently.

Hard exhaustion signals:

- Claude: quota endpoint reports 100% with reset in the future; runtime 429 or
  provider-specific "usage limit reached" error; existing 401 path remains auth
  failure, not quota.
- Codex: `account/rateLimits/updated` reports 100%; app-server turn failure
  reports subscription/rate-limit exhaustion.

When an account becomes exhausted, `ProviderAccountManager` records
`exhaustedUntil` and emits updated status. The account is skipped until reset.

## Client architecture

### Stores

Add `provider-account-store.ts` or extend settings state with:

- `accountsByProvider`
- `connectAccount(provider)`
- `disconnectAccount(accountId)`
- `renameAccount(accountId, label)`
- `makePrimary(accountId)`
- `setAccountStatus(...)`

Bootstrap includes provider accounts so the header/settings render immediately.
Global SSE updates keep account status fresh, similar to subscription limits and
GitHub rate-limit state.

### UI surfaces

- Settings owns account management.
- Header subscription-limits badge shows multiple pills or a compact grouped
  pill when a provider has more than one account.
- Session diagnostics shows the active provider account for the current session.
- Chat system messages report failover decisions:
  - `Claude: Primary exhausted until 14:30; retrying with Work account.`
  - `Claude: Primary exhausted after file edits; Work account is available. Say continue to retry from the current workspace state.`

Do not open provider dashboards for normal quota/status inspection. Billing and
account-management links live in overflow menus.

## Retry safety model

Track per-turn side effects using existing agent event observations:

- Before first tool call: safe to retry.
- After read-only tools only: safe to retry.
- After write/edit/bash/MCP/external side-effect tools: require user intent.

Implementation can start coarse:

- Maintain `runner.turnHadSideEffects`.
- Mark true for `Write`, `Edit`, `Bash`, shell/file-write equivalents, git/gh
  shim writes, MCP tools except known read-only allowlist.
- If unknown, treat as side-effecting.

This intentionally favors correctness over seamless failover.

## Migration

1. On startup, if root `.claude` exists and no Claude provider account exists,
   create `claude-default` and move/copy credentials into the new account path.
2. Same for root `.codex`.
3. Keep root singleton paths as compatibility aliases for one release:
   singleton call sites resolve the primary account.
4. Once all call sites use `ProviderAccountManager`, remove direct root-path
   reads except migration.

Existing sessions without `provider_account_id` are split by pin state:

- **Unpinned sessions:** use the provider primary account on their next turn.
- **Pinned sessions with an existing per-session credential subtree:** do not
  treat `/credentials/sessions/<id>` as an account source of truth. That
  subtree is a derived runtime copy and is removed by archive/reset/janitor
  paths. Instead, if its token can be matched to a root/default provider account,
  set `provider_account_id` to that account and keep using the existing
  provider-side `agentSessionId`. If it cannot be matched, copy the token into a
  new account-qualified source under `/credentials/provider-accounts/...` only
  after validating it as a usable provider credential; otherwise require re-auth.
  The per-session subtree remains only a consumer of account credentials.
- **Pinned sessions whose credential source cannot be identified:** mark the
  session as needing re-auth/account selection before the next turn. The recovery
  path must kill any persistent process, clear `agentSessionId`, provision the
  chosen account, and restart from local context.

## Touchpoints

- `src/server/orchestrator/credential-store.ts` — persist provider-account
  metadata.
- `src/server/orchestrator/auth.ts` — make Claude auth file access
  account-scoped.
- `src/server/orchestrator/codex-auth.ts` — make Codex device auth
  account-scoped.
- `src/server/orchestrator/provider-account-manager.ts` — new account routing,
  status, selection, and auth orchestration.
- `src/server/orchestrator/session-credentials.ts` — provision and sync token
  files by `{ provider, accountId }`.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — select account,
  pin account, detect safe retry, and perform failover.
- `src/server/orchestrator/ws-handlers/send-message.ts` — route
  `handleAnswerQuestion` direct `agent.run(...)` resumes through the same
  provider-account preflight and metadata decoration.
- `src/server/orchestrator/session-runner.ts` and
  `src/server/orchestrator/container-session-runner.ts` — route
  `sendSystemMessage` / `runSystemTurn` through the same provider-account
  preflight used by WebSocket turns.
- `src/server/orchestrator/runner-registry-factory.ts` — inject the
  provider-account preflight/sync dependencies into `SystemTurnDeps`.
- `src/server/orchestrator/services/child-sessions.ts` — agent-spawned sessions
  bypass `runAgentWithMessage` and directly provision credentials before
  `sendSystemMessage`; they must select or inherit a provider account, persist
  `provider_account_id`, and provision account-qualified credentials before
  setting `agent_pinned`.
- `src/server/orchestrator/services/github-ci-fix.ts` and other services that
  call `sendSystemMessage` — rely on the shared system-turn preflight rather
  than assuming WS setup has already provisioned credentials.
- `src/server/orchestrator/services/rebase-driver.ts` — route rebase/conflict
  recovery direct `agent.run(...)` calls through provider-account preflight,
  sync, and metadata decoration.
- `src/server/orchestrator/app-lifecycle.ts` — account-qualify auth-complete
  handling and token re-push so re-auth for account X updates only sessions
  pinned to account X.
- `src/server/orchestrator/limits/*` and `limits-poller.ts` — move from
  agent-keyed snapshots to provider-account snapshots.
- `src/server/shared/types/agent-types.ts` — add optional provider-account
  fields to init/result events if needed.
- `src/server/shared/types/usage-limits-types.ts` — account-keyed limits map.
- `src/server/shared/types/domain-types.ts` / `sessions.ts` — persist
  `provider_account_id`.
- `src/client/stores/*` — provider account state and SSE handling.
- `src/client/components/Settings.tsx` — Agent accounts management UI.
- `src/client/components/SubscriptionLimitsBadge.tsx` — grouped multi-account
  rendering.
- `src/client/components/SessionDiagnosticsPanel.tsx` — active account display.

## Phasing

### Phase 1 — Account registry and manual routing

- Add account-scoped credential storage.
- Migrate existing singleton credentials to default accounts.
- Let users add multiple accounts per provider.
- Let users choose the primary account per provider.
- New turns use the primary account.
- No automatic failover yet.

### Phase 2 — Inline quota per account

- Poll or receive limits per provider account.
- Render multi-account quota state inline.
- Skip known-exhausted accounts for new turns.

### Phase 3 — Automatic failover

- Detect hard exhaustion during startup or turn execution.
- Retry automatically when no side effects occurred.
- Ask for chat confirmation when side effects already happened.
- Record failover events in chat history and diagnostics.

### Phase 4 — Policy controls

- Optional per-session account preference.
- Optional "do not auto-failover for this provider" setting.
- Optional account labels sourced from provider profile where stable.

## Open questions

- **Claude account identity:** confirm which stable user/account identifier can be
  read from the credentials/profile endpoint so ShipIt can prevent duplicate
  account rows.
- **Codex account identity:** confirm whether the access token or app-server
  status exposes a stable account id without calling an unavailable ChatGPT
  endpoint.
- **Provider terms:** verify whether automatic failover among user-owned
  subscriptions is acceptable for each provider before defaulting it on.
- **Concurrent turns on one account:** decide whether ShipIt should avoid routing
  multiple simultaneous heavy turns to the same provider account when another
  account has more remaining quota.
- **Warm pool timing:** confirm account selection happens before credential
  provisioning for every runner path, including claimed warm sessions.
- **Child-session inheritance policy:** decide whether spawned sessions inherit
  the parent's provider account by default or run the same account router used by
  normal new sessions. Inheritance is more predictable; routing is better for
  quota spreading.

## Test plan

- Unit: `ProviderAccountManager` selection prefers primary, skips exhausted
  accounts, respects reset times, and falls back deterministically.
- Unit: credential migration creates default accounts and preserves existing
  single-account behavior.
- Unit: `session-credentials` provisions only the selected provider account and
  syncs token files back to the same account path.
- Integration: first Claude turn pins `{ agent_id: "claude", provider_account_id
  }` and starts with that account's credentials.
- Integration: exhausted primary account causes a new turn to start on secondary.
- Integration: mid-turn exhaustion before side effects retries on secondary once.
- Integration: mid-turn exhaustion after side effects emits a confirmation prompt
  and does not auto-retry.
- Integration: switching a pinned session from account A to account B kills any
  persistent agent, clears provider resume state, reprovisions account B's
  credentials, and starts from local context.
- Integration: agent-spawned child sessions persist `provider_account_id` and
  provision account-qualified credentials before their first `sendSystemMessage`
  turn.
- Integration: child follow-up messages and GitHub CI auto-fix system turns use
  the shared provider-account preflight instead of bypassing credential
  selection/sync.
- Integration: answer-question resumes and rebase/conflict recovery direct
  `agent.run(...)` paths use the shared provider-account preflight, token sync,
  and `agent_init` account metadata decoration.
- Integration: auth-complete for account X re-pushes the refreshed token only to
  sessions pinned to account X.
- Integration: `agent_init` events emitted through WS and system-turn paths carry
  the orchestrator-selected provider account metadata without requiring adapters
  to inspect credentials.
- Integration: Codex unknown-quota accounts are selectable but do not outrank
  equivalent accounts with fresh known quota; `OPENAI_API_KEY` fallback is not
  rendered or ranked as a subscription account.
- Integration: delayed quota turns persist and restore the full turn request,
  including files, uploads/images, permission mode, review authorization, model,
  and assembled prompt context.
- Integration: exhausted-but-authenticated accounts keep
  `AgentRegistry.authConfigured` true; account selection reports `all_exhausted`
  separately from `auth_required`.
- Integration: local/dogfood direct runner starts the agent with an
  account-scoped config root, or reports an explicit unsupported diagnostic for
  providers where that is not possible.
- Client: Settings renders multiple provider accounts and can make one primary.
- Client: subscription limits render multiple accounts per provider without
  layout overlap.
