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

1. If the session already has a pinned provider account and it is still usable,
   keep using it.
2. Otherwise prefer the provider's primary account.
3. Skip accounts known to be exhausted until their reset time.
4. Prefer accounts with the most remaining weekly quota; use short-window quota
   as the tiebreaker.
5. If all accounts are exhausted, show a chat-visible system message with reset
   times and leave the turn queued/not-started.

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

### Agent startup

`AgentRunParams` should not carry raw credentials. The orchestrator selects the
account before runner start and provisions files into the session credential
subtree. The worker/adapter continues to see normal CLI paths:

- Claude: `/root/.claude` and `/root/.claude.json`.
- Codex: `/root/.codex`.

The adapter emits an `agent_init` extension:

```ts
providerAccountId?: string;
providerAccountLabel?: string;
```

This gives chat history and diagnostics an audit trail without exposing secrets.

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

Existing sessions without `provider_account_id` use the provider primary account
on their next turn. If their per-session credential subtree already exists, the
turn-level sync-in refreshes it from the selected account before start.

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
- `src/server/orchestrator/services/child-sessions.ts` — agent-spawned sessions
  bypass `runAgentWithMessage` and directly provision credentials before
  `sendSystemMessage`; they must select or inherit a provider account, persist
  `provider_account_id`, and provision account-qualified credentials before
  setting `agent_pinned`.
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
- Integration: Codex unknown-quota accounts are selectable but do not outrank
  equivalent accounts with fresh known quota; `OPENAI_API_KEY` fallback is not
  rendered or ranked as a subscription account.
- Client: Settings renders multiple provider accounts and can make one primary.
- Client: subscription limits render multiple accounts per provider without
  layout overlap.
