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

Reserved auth routes are represented separately from provider-account rows but
still need route ids for session pinning/audit:

- `codex-api-key` — run with `OPENAI_API_KEY` / OpenAI Platform API billing.
- `claude-api-key` — run with `ANTHROPIC_API_KEY` / Anthropic Platform API
  billing.
- `claude-env-oauth` — run with `ANTHROPIC_AUTH_TOKEN`, used by dogfood/local
  OAuth-style env auth.

The reserved ids are not all the same kind of fallback:

- `codex-api-key` and `claude-api-key` are pay-as-you-go fallbacks. They are
  eligible only when no subscription account is selected or when the user
  explicitly chooses that billing/auth path. They do not render subscription
  quota, do not appear in subscription quota ranking, and are never selected for
  "switch to another subscription" failover.
- `claude-env-oauth` is an OAuth-style subscription route backed by
  `ANTHROPIC_AUTH_TOKEN`. The id is new terminology for this doc; doc 135
  describes the env-token quota behavior but does not coin a route name. It has Claude subscription quota
  visibility and keeps the existing subscription-limits badge behavior. It is
  not a provider-account row, so it does not participate in multi-account
  ranking between stored account rows; however, when it is the selected Claude
  route, quota polling, hard exhaustion detection, delayed-turn handling, and
  same-route reset-time display behave like a Claude subscription account.

## Goals

- Support **multiple authenticated accounts per provider** (`claude`, `codex`)
  while keeping the existing single-account path as a compatible default.
- Automatically select a non-exhausted account for new turns, preferring the
  user's chosen primary account until it crosses a defined quota threshold.
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

The transitional symlink chain applies **only inside the orchestrator
container**: `/root/.claude` → `/credentials/.claude`, then a new inner
symlink `/credentials/.claude` → `/credentials/provider-accounts/claude/acct_<default>/.claude`.
Session containers mount `<credentialsDir>/sessions/<sid>` at `/credentials`,
so their `/credentials/.claude` is the per-session subtree populated by
`provisionAgentCredentials` and is not part of the chain. Creating the inner
symlink inside a session container would break doc 138's credential
isolation — do not do it. The migration must have a defined owner. The image-built outer symlink stays in place;
the inner symlink is created by the credential migration step on
orchestrator startup (see Migration §1–2). If the inner symlink target is
missing or broken (fresh machine, corrupted volume), `app-lifecycle`'s
startup hook recreates it pointing at the primary account's directory
(creating that directory empty if needed).

`AuthManager.ensureOnboardingComplete` uses `readlinkSync` then
`mkdirSync(target, { recursive: true })`. `readlinkSync` returns only the
immediate symlink target, not the chain's terminus, so a two-link chain
would resolve to the intermediate (`/credentials/.claude`) and `mkdirSync`
on that would either no-op (if the intermediate exists as a symlink to a
present dir) or throw (broken target). Switch the resolution to
`realpathSync` with an `existsSync`-on-failure fallback so the dance follows
the full chain. Audit all other callers of `readlinkSync(CLAUDE_CONFIG_DIR)`
in `auth.ts` for the same problem before the inner symlink lands. On a
fresh credentials volume with no authenticated accounts, the inner symlink
is not created and OAuth login provisions the account directory before the
symlink is established.

Beyond `signOut()`, every legacy-path *write* site must be audited before
the inner symlink ships, because `rmSync(force: true)` and other write
operations follow symlinks and would delete or rewrite the account source,
not the legacy alias. Concretely: `/root/.claude.json` writes from
`ensureOnboardingComplete`, the wizard's `/root/.claude` directory writes,
and any future code path that reads/writes the legacy path. The audit list
must be enumerated in the migration PR; any unaudited writer becomes a
silent cross-account corruption hazard.

Today `AuthManager.signOut()` and `CodexAuthManager.signOut()` delete files
under the legacy root credential paths only. With the transitional symlink
option, "Sign out of default" must be redirected through
`ProviderAccountManager.disconnectAccount(defaultAccountId)` so the
multi-account disconnect flow below runs; otherwise sign-out would silently
bypass session re-auth handling for sessions pinned to the default account.

Disconnect is blocked while the account is pinned to a running session unless
the user chooses a replacement account. The step order matters because
sync-back runs on the streaming-tail `agent_result` event and can race the
disconnect (today's `syncAgentTokenBack` fires from the WS handler tail and
runs after the runner stop signal); a slow disconnect must not let a
straggling sync-back resurrect a freshly-deleted source file. Disconnect
must also fence concurrent `selectAccountForTurn` calls on **other**
sessions — a session picking up a turn at the moment we delete the source
must not slip past selection and reach sync-in afterward. To fence:
`ProviderAccountManager` maintains a `disconnectingAccounts: Set<string>`
that `selectAccountForTurn` consults; an account in that set is treated as
`unavailable` for selection until the disconnect commits or rolls back.
Selection acquires a read lock against the set; disconnect acquires the
write lock, runs steps 2–6, then removes from the set and releases.

On disconnect:

1. Find every session pinned to that provider account.
2. Disable token sync-in/sync-back for the deleted account immediately and
   await any in-flight sync operation for those sessions before proceeding.
3. Kill any live persistent agent process for those sessions.
4. Remove the account's source credentials from
   `/credentials/provider-accounts/...`.
5. Purge or replace the account credential subtree in each affected per-session
   credentials directory.
6. Clear `agentSessionId` for affected sessions because provider-side resume is
   no longer valid.
7. Mark sessions as requiring account selection/re-auth, or transition them to a
   user-selected replacement account using the full account-switch replay path.

This prevents a deleted source account from continuing to run through a stale
per-session credential copy.

### Session startup

For a new turn, the router chooses a provider account before credential
provisioning:

1. Filter to accounts that are eligible for the selected model, permission mode,
   and requested provider features.
2. If the session already has a pinned provider account and it is still usable,
   keep using it.
3. Otherwise prefer the provider's primary account.
4. Skip accounts known to be exhausted until their reset time.
5. Treat accounts as **quota-low** when either known short-window usage is at or
   above 90% or known weekly usage is at or above 95%. If the primary account is
   quota-low and another eligible account is not quota-low, choose the healthier
   account instead of primary.
6. Prefer accounts with the most remaining weekly quota; use short-window quota
   as the tiebreaker.
7. If all eligible accounts are exhausted, put the prompt into a delayed
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

Per-account capability facts live on `ProviderAccount` as a cached
`capabilities` snapshot. The shape extends `Partial<AgentCapabilities>`
(exported from `src/server/shared/types/agent-types.ts`; the registry
consumes it, it is not defined on `AgentRegistry`)
so every per-turn capability check (including
`agentInfo.capabilities.supportsSteering` in `agent-execution.ts`) reads
from the merged view rather than the registry alone:

```ts
interface ProviderAccountCapabilities extends Partial<AgentCapabilities> {
  /** Tri-state — guarded mode is observed at runtime, not declared. */
  guardedModeState?: "unknown" | "available" | "unavailable";
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}
// `AgentCapabilities` is exported from src/server/shared/types/agent-types.ts.
```

Undefined fields inherit the provider-wide value; set fields shadow it.
`ProviderAccountManager` exposes a `getMergedCapabilities(accountId)` that
every capability-aware call site uses; the registry's per-agent capabilities
must not be read directly once an account is in scope.

Sources:

- Provider profile/auth metadata seeds plan/tier-derived defaults when stable.
- The agent registry supplies provider-wide defaults as a conservative fallback.
- Runtime `agent_init` updates the account that actually ran the turn. Guarded
  mode remains `unknown` until observed; a failed guarded engagement marks that
  account unavailable for guarded turns until policy/account metadata changes.

Selection treats unknown capability conservatively for automatic failover:

- If the current/primary account has unknown-but-unproven capability, it may be
  attempted because that matches today's behavior.
- A fallback account with unknown capability is not used for automatic failover
  when the current turn requires that capability; ShipIt asks for user intent or
  reports `no_model_eligible_account` / `capability_unknown` instead.

An exhausted turn cannot use the existing in-memory message queue by itself.
Today queued messages drain from agent completion paths; if no agent starts,
there is no completion event to wake the queue after a quota reset. Delayed
quota waits therefore need their own persisted/scheduled state:

- persist the full turn request in a delayed-turn table or session field:
  user text, validated file refs, upload refs, image refs (including any
  inline base64 payloads that today live only in the WS message and would
  otherwise be lost — these must be written to a stable on-disk location
  outside the per-session `/credentials/sessions/<id>` subtree and outside
  the session workspace, both of which are wiped by archive/reset/disk-janitor
  paths; a dedicated `/credentials/delayed-turns/<sessionId>/<turnId>/` tree
  that the disk-janitor and archive flows explicitly preserve until the
  delayed turn resolves), permission mode, review-file authorization,
  selected model, selected agent, target provider, and the assembled
  prompt/context snapshot needed to restart deterministically,
- schedule an orchestrator timer for the earliest eligible reset,
- re-check account eligibility/quota at wake time before starting,
- revalidate that referenced files/uploads still exist and surface a recoverable
  error instead of starting with silently missing context,
- broadcast the delayed state so reconnecting clients show why the prompt is not
  running,
- allow the user to cancel or replace the delayed prompt from chat.

`SessionRunner.messageQueue` is in-memory only today. The delayed-turn
persistence solves the *blocked* turn itself, but messages queued behind it
during an orchestrator restart would be lost. Queued items also carry inline
`ImageAttachment` base64 payloads.

The "lose everything queued behind the delayed head" option is unacceptable
once the UI surfaces `message_queued` confirmations — those are
user-committed messages. Persist the **full queue** (head plus tail) into
the same off-workspace `/credentials/delayed-turns/<sessionId>/<turnId>/`
tree the delayed head uses. Each queued item gets its own subdirectory with
its inline image blobs, and the wake path replays them in order. The
on-disk queue is subject to the same `SessionRunner.MAX_QUEUE_SIZE` cap as
the in-memory queue; enqueue attempts at the cap return the existing "queue
full" error to the WS client whether the runner is delayed or not. On wake,
if persisted entries exceed the cap (e.g., a cap reduction between runs),
the head N are restored and the remainder dropped with a chat-system
message naming the dropped count. The implementation cost is one
persist-on-enqueue + load-on-wake helper, which is in scope for this work;
the alternative ("warn the user that queued messages may disappear") is a
worse product outcome than the engineering cost.

If the process restarts before the reset, startup tasks reload delayed turns and
re-arm their timers.

A delayed turn cannot rely on the runner still being alive at wake time.
Idle disposal (60s viewer-detach grace, `idle-enforcer.ts`) and
memory-pressure eviction (which bypasses the grace period entirely and
drops effective `maxIdle` toward 0) both target unattached runners; a
delayed turn parked for an hour will be reaped under either path. The
shipped behavior is therefore **wake = fresh `runSystemTurn`**: the wake
path recreates the runner from persisted `SessionInfo`, runs the shared
preflight, applies the same account-switch replay package mechanism from
"Existing pinned sessions" (since `agentSessionId` may have been cleared
during disposal), and starts the agent. Suppressing idle disposal for
delayed turns is rejected because it conflicts with pressure eviction's
"pressure beats stickiness" invariant.

### Mid-turn failover

Automatic retry is conservative:

- **Safe retry:** the agent failed before any side-effecting tool call, or the
  failure happened during initial provider/model request before tool execution.
  ShipIt switches to the next eligible provider account and retries once.
- **Needs user intent:** the turn already wrote files, ran commands, modified git,
  called side-effecting MCP tools, or created external side effects. ShipIt
  stops, records the exhausted account, surfaces the next eligible account, and
  asks the user in chat whether to continue from the current workspace state.
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

Call shape: the retry goes through `runAgentWithMessage` itself (not a
separate code path) so the existing listener/sync wiring is reused. A new
optional parameter `retry?: { originalMessageId: string; attempt: number; previousAccountId: string }`
is added; when set, the function skips `persistUserMessage`, clears any
in-progress assistant rows for `originalMessageId`, and records a
system-event message group referencing the failover. Existing
mid-turn state flags (`wasInterrupted`, `postTurnDrainFired`,
`streamingPostTurnFired`) must be reset before the retry; a user interrupt
during the retry is treated as a side effect (per the retry safety model)
and aborts further automatic retries for that turn.

### Existing pinned sessions

Sessions need two persisted fields:

- `agent_id` — existing provider/agent (`claude`, `codex`). Already on
  `SessionInfo` as `agentId?: AgentId` (doc 138); the outdated comments in
  `services/child-sessions.ts:314-319` (spawn path — currently drives
  `defaultAgentId` inheritance) and `:527-528` (send path) both claim agent
  id is not persisted and must be corrected as part of this work. **Behavior
  change:** child inheritance switches from `defaultAgentId` to the parent
  session's persisted `agentId`. A Claude-pinned parent that spawns a child
  on a Codex-default orchestrator will now spawn a Claude child (today: a
  Codex child). This is a deliberate visible delta — call it out in release
  notes and add a dedicated integration test for "spawned child inherits
  parent's pinned agent."
- `provider_account_id` — new selected account for that provider. For
  reserved auth routes, this is a route id such as `codex-api-key`,
  `claude-api-key`, or `claude-env-oauth`, not a provider-account row.
  `claude-env-oauth` is still subscription-style OAuth for quota purposes even
  though it is not stored as a provider-account row.

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
4. Build an explicit replay package from ShipIt's persisted chat history and
   current workspace state before starting account B. This package includes the
   user/assistant transcript since the last checkpoint or bounded summary, any
   still-relevant file references, active thread/checkpoint metadata, current git
   diff summary, and a note that provider-side resume was reset because the
   account changed. Today `SessionManager.consumeConversationReplay()` is a
   one-shot read-and-clear used after a rollback; this work either reuses it by
   calling `setConversationReplay()` before the account-switch turn (so the next
   `runAgentWithMessage` consumes the package exactly once) or adds an explicit
   account-switch replay channel with the same one-shot semantics. Do not
   silently mutate `consumeConversationReplay` into a multi-write API — other
   callers depend on the clear-on-read invariant.
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
  capabilities?: ProviderAccountCapabilities;
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

Migration must preserve a single writable OAuth token source per account. Do not
leave independent writable copies in both the legacy root path and
`provider-accounts/...`; that would recreate the rotating-refresh-token split
from doc 142. Compatibility is provided by helper resolution or symlinks:

- Preferred: all code resolves credentials through `ProviderAccountManager`, and
  legacy root paths are read only during migration.
- Acceptable transitional path: root `.claude` / `.codex` symlinks point at the
  selected default account source, so CLI refreshes still update one file.
- Not allowed: copying token files into root and account paths where both can be
  refreshed independently.

For backward compatibility, singleton helper methods continue to resolve the
primary account until all call sites are migrated; they must resolve to the same
writable file, not a copy.

`capabilities` persists the account-specific snapshot described in session
startup. It is an account-level **override layer** on top of
`AgentRegistry.AgentCapabilities`: fields left undefined inherit the
provider-wide value, fields set on the account shadow it. Selection always
reads the merged view, never the registry alone. Migration initializes it
from provider-wide `AgentRegistry` capabilities with
`source: "manual_default"` and `guardedModeState: "unknown"`. Auth/profile
refreshes and runtime `agent_init` observations update it in
`CredentialStore`, so fallback eligibility survives orchestrator restarts.

### Agent availability gates

`AgentRegistry.authConfigured` remains a coarse agent-level signal for existing
UI and server gates, but its meaning changes. This also redefines
`AgentRegistry.available()` (`installed && authConfigured`), which today
reads as "can this provider be started right now?" but under the new
semantic reads as "is this provider authenticated at all?" — exhausted-only
states would still pass `available()`. Every consumer that uses
`available()` or `authConfigured` as a *start* gate must shift to
`ProviderAccountManager.selectAccountForTurn(...)`. The known call sites
are `ws-handlers/send-message.ts:ensureActiveAgentAuthenticated` (covered
below), the agent-picker UI (`Settings.tsx`), and
`services/child-sessions.ts`'s `defaultAgentId` fallback; the migration PR
must enumerate them and update each one, otherwise users would hit the
provider's quota wall via an unhelpful CLI error instead of ShipIt's
delayed-turn state.

- `claude.authConfigured = true` when at least one authenticated Claude provider
  account exists, even if every account is currently quota-exhausted, or a
  supported reserved Claude auth route exists (`claude-api-key` or
  `claude-env-oauth`).
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
from provider-account state plus reserved-route auth.

Quota exhaustion is not authentication failure. An exhausted account remains
authenticated and should not make Settings or model pickers show "not signed in."
`ProviderAccountManager.selectAccountForTurn(...)` returns structured failures
such as `all_exhausted`, `no_model_eligible_account`, or `auth_required`; only
the last one changes auth UI state.

`ensureActiveAgentAuthenticated` in `ws-handlers/send-message.ts` currently
reads the singleton `ctx.authManager.authenticated` getter and falls back to
`startOAuthFlow()`. That singleton getter has no defined semantic once
multiple accounts can be authenticated independently. It must be replaced
with a call to `ProviderAccountManager.selectAccountForTurn(...)` whose
structured result drives the routing:

- `auth_required` → the existing OAuth-prompt path.
- `all_exhausted` → the delayed-turn / chat-system-message path (not a
  re-auth prompt).
- `no_model_eligible_account` → a user-facing capability error.

Conflating these (today's behavior) would silently launch an OAuth flow
when the user is merely rate-limited.

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
the correct account updates. The auth managers themselves stay single-instance
per provider but their event payloads gain `accountId`; subscribers (including
`app-lifecycle`'s post-auth token re-push) must read it to know which account
to act on. Reserved routes (`claude-env-oauth`, `claude-api-key`,
`codex-api-key`) are not provider-account rows and do not emit account-keyed
auth events.

`AuthManager.ensureOnboardingComplete()` currently writes
`/root/.claude.json` in-process before each `claude /login` spawn. With
concurrent auth flows for different Claude accounts, this in-process write
must also target the account-specific config root (the same HOME/symlink
used by the spawned CLI), not the orchestrator's real `/root/.claude.json`,
or two parallel flows will fight over the singleton file.

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
- Today `syncAgentTokenIn` / `syncAgentTokenBack` are wired only inside
  `runAgentWithMessage`; `runSystemTurn`, `handleAnswerQuestion`, and
  `rebase-driver`'s direct `agent.run(...)` paths skip them. Doc 142's gap
  must be closed as a prerequisite to this work, otherwise account-scoping
  these calls just moves the leak: account-A turns started by CI auto-fix or
  rebase recovery would silently use whatever per-session token files exist,
  bypassing account selection entirely.
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
The `AgentInitEvent` interface in `src/server/shared/types/agent-types.ts`
gains these optional fields and the client-side discriminated union must be
updated alongside the server emitter.

Decoration site: `runSystemTurn` does **not** route through
`wireAgentListeners`; it wires a minimal inline listener block. Rather than
duplicating decoration in two places, the orchestrator-selected metadata is
attached at `runSystemTurn`'s start (via `SystemTurnDeps`) and inside
`wireAgentListeners` for WS-driven turns, both reading from the same
`prepareProviderAccountTurn` result so the decorated payload is identical.

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

This requires explicit plumbing: add non-secret credential-root metadata to the
server-side run path (for example `AgentRunParams.providerCredentialHome` or a
local-only adapter option), update the local `agentFactory` to pass it, and teach
Claude/Codex adapters to spawn with that account-scoped environment. Claude's
current spawn path hardcodes `HOME: "/root"`, so it must be changed to accept the
selected HOME/config root for local direct runs.

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
`existingAgent.sendUserMessage(...)`. The helper is a **free function** —
not embedded inside `runSystemTurn` or `runAgentWithMessage` — so it can be
called from any agent-start site. The major host sites are:

- `runAgentWithMessage` (WS chat entrypoint).
- `runSystemTurn` (system-turn host for child sessions, GitHub CI auto-fix,
  and most non-WS server-initiated turns).
- `rebase-driver.ts` (which deliberately bypasses `runSystemTurn` because
  the system-turn host auto-commits and auto-pushes, both of which corrupt
  an in-progress rebase). The rebase driver gets its own explicit call to
  the helper before its inline `agent.run(...)`.
- `handleAnswerQuestion` (the resume-after-blocked-question path).

`SystemTurnDeps` (injected at `runner-registry-factory.ts`) gains the
`ProviderAccountManager` and credential-sync dependencies the preflight
needs, so `runSystemTurn` callers don't have to materialize them
themselves; `rebase-driver.ts` and `handleAnswerQuestion` receive the
manager directly through their existing dependency seams.

`runSystemTurn` recursively re-enters itself to drain queued messages
(`session-runner.ts:200-205`). The preflight must run **inside** the
per-iteration body of `runSystemTurn` (before the per-iteration
`agent.run`) — not only at host-site entry — so each drained queued turn
gets its own account selection, credential provisioning, and token sync-in.
The non-streaming `tryPostTurnDrain → drainNextQueuedMessage` path inside
`runAgentWithMessage` already re-enters `runAgentWithMessage`, which will
re-run the helper there; no change needed for that path. It is responsible for:

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

Reserved route ids have an explicit preflight contract because they are not
provider-account rows:

| Route id | Provisioning | Env/config pushed to the runner | Token sync | Quota/delayed-turn behavior |
| --- | --- | --- | --- | --- |
| `codex-api-key` | Skip provider-account credential copy. The per-session credential subtree must **not** contain `.codex/auth.json` for this attempt — today's adapter (`codex-adapter.ts`) strips `OPENAI_API_KEY` from the spawned environment whenever `.codex/auth.json` is present, so setting the env var alone is insufficient. Either provision an empty `.codex/` (no `auth.json`) or skip the subscription provisioning entirely so the file-auth probe returns false. | Set `OPENAI_API_KEY` for the Codex run. | No-op; API keys do not rotate through the Codex subscription token store. | No subscription quota. It is not ranked with subscription accounts, not used for subscription failover, and does not create delayed quota turns. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-api-key` | Skip provider-account credential copy. The Claude CLI is observed to prefer `.credentials.json` over `ANTHROPIC_API_KEY` when both are visible (see "CLI precedence" note below), so the per-session credential subtree must omit `.claude/.credentials.json` and `.claude.json` for this attempt. Either provision an empty `.claude/` directory or skip the subscription provisioning so the CLI falls back to the env-var path. | Set `ANTHROPIC_API_KEY` for the Claude run. Persist this key in `CredentialStore` (not just `process.env`); today `services/settings.ts:setApiKey` writes only to `process.env.ANTHROPIC_API_KEY` and `clearApiKey()` deletes it in-process. Bring it up to parity with `OPENAI_API_KEY` by adding `ANTHROPIC_API_KEY` to `ALLOWED_ENV_KEYS` in `src/server/shared/agent-registry.ts` and routing the existing bespoke `/api/settings/api-key` mutators through `credentialStore.setAgentEnv` / `unsetAgentEnv` (the underlying allowlist change is a separate, visible API-surface delta that must be called out in the migration PR). | No-op; API keys do not rotate through the Claude OAuth token store. | No subscription quota. It is not ranked with subscription accounts, not used for subscription failover, and does not create delayed quota turns. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-env-oauth` | Skip provider-account credential copy because the source of truth is the orchestrator/session env, not `/credentials/provider-accounts/...`. The per-session `.claude/` subtree must omit `.credentials.json` for this attempt — the Claude CLI is observed to prefer a file token over `ANTHROPIC_AUTH_TOKEN` (see "CLI precedence" note below), so leaving a stored account's file in place would silently run the turn against that account. Either provision an empty `.claude/` or temporarily move/exclude `.credentials.json` for the duration of the turn (and restore on next non-env-OAuth turn). | Set `ANTHROPIC_AUTH_TOKEN` and do not set `ANTHROPIC_API_KEY`. Today `AgentRunParams` does not carry per-turn env vars; this work must add a turn-scoped env channel (e.g., `AgentRunParams.runEnv`) plumbed through `ProxyAgentProcess` and the worker's `/agent/start` to the CLI spawn, distinct from the account-wide `getAllAgentEnv()` path. Precedence: `runEnv` takes priority over any account-level env from `selectAgentEnvForPush`; collisions on `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` use the `runEnv` value. The worker REPLACES its tracked env set on each `PUT /secrets`, so the turn-scoped env must be sent as part of the same PUT (not a separate channel) and cleared on the next non-env-OAuth turn's PUT so values don't leak between turns. | Sync-in reads only the current env token; sync-back is a no-op because ShipIt cannot safely rewrite an env-provided token. If the provider returns a refreshed token file during the run, it must not be copied into a stored provider-account row. | Subscription-style quota applies. The limits badge remains visible, hard exhaustion can create delayed quota turns, and reset-time handling matches Claude OAuth accounts. It is not ranked against stored provider-account rows for multi-account spreading because it has no account row; it is used when explicitly selected, pinned from migration/local auth, or when no stored Claude account exists and env OAuth is the available Claude auth. Capability handling: env-OAuth has no plan/profile data (`getAccessToken()` returns `plan: null`), so it is always in unknown-capability state. The selection policy's "fallback account with unknown capability is not used for automatic failover" rule does **not** apply to reserved routes; env-OAuth bypasses the capability gate and is selectable whenever it is the configured Claude auth source, matching today's behavior in dogfood/local mode. |

**CLI precedence note.** The reserved-route preflights for `claude-api-key`
and `claude-env-oauth` assume the Claude CLI prefers `.credentials.json`
over `ANTHROPIC_API_KEY` and over `ANTHROPIC_AUTH_TOKEN`. ShipIt's own
`AuthManager.getAccessToken()` picks env over file (`auth.ts:289-294`), so
the CLI's precedence is **not** structurally derivable from existing
orchestrator code — it's an observation about the CLI's startup behavior.
The implementation PR must record (a) the Claude CLI version under which
the precedence was verified, (b) the test command, and (c) a CI check that
reasserts the behavior so a future CLI release doesn't silently invert it.
If the precedence ever flips, the "omit `.credentials.json`" workaround
becomes unnecessary but also harmless.

Preflight must check route kind before assuming a `provider_account_id` can be
loaded from `ProviderAccountManager`. Account-row provisioning, capability
metadata writes, and token copy-back only run for real provider-account ids.
Reserved-route handling still records the selected route in turn metadata so
`agent_init`, diagnostics, and post-turn cleanup can explain which auth path
was used.

Detached/system-turn paths must hydrate persisted session routing before creating
or reusing a runner. In particular, child follow-up messages and other paths that
call `runnerRegistry.getOrCreate(...)` after a runner was disposed must read
`SessionInfo.agentId` and `SessionInfo.providerAccountId` first and pass the
persisted agent into runner creation. Falling back to `defaultAgentId` before
preflight would recreate the runner under the wrong provider and can bypass the
pinned account. The shared preflight then validates that the hydrated account is
still usable before the turn starts.

### Quota and exhaustion detection

Doc 135's limits map changes from agent-keyed to account-keyed. Both layers
remain partial because providers that report `canFetch() === false` are
omitted (today's invariant in `usage-limits-types.ts`) and accounts may not
yet have a fetched snapshot:

```ts
type SubscriptionLimitsMap = Partial<
  Record<AgentId, Partial<Record<string, SubscriptionLimits>>>
>;
```

A missing inner key still means "do not render a pill"; an account that has
been authenticated but has never produced a snapshot (Codex, see below) is
absent rather than present-with-nulls.

This adds one nesting level inside the existing `SubscriptionLimitsMap`:
the outer `Partial<Record<AgentId, …>>` is unchanged; the inner type goes
from `SubscriptionLimits` to `Partial<Record<accountId, SubscriptionLimits>>`.
That inner shape change is still a wire-format break — existing clients
read the inner value as the flat `SubscriptionLimits` object. To avoid
corrupting older browser tabs during a rolling deploy, the server emits
both `subscription_limits` (legacy, populated with the primary account's
snapshot per provider) and `subscription_limits_v2` (account-keyed) for
one release. Clients written against this doc consume v2 only; the legacy
event is removed in a follow-up once telemetry confirms no v1 consumers.

Claude can poll quota per account using that account's OAuth token. Codex remains
event-fed where possible; its rate-limit event must be associated with the
account used by the current runner.

`ClaudeLimitsProvider` (polled) and `CodexLimitsProvider` (event-fed) in
`src/server/orchestrator/limits/` currently take a singleton
`Pick<AuthManager, "getAccessToken">` constructor argument with no concept of
accountId. Their account-scoping treatments diverge:

- **Claude (polled):** the poller iterates accounts and calls
  `claudeLimitsProvider.fetchForAccount(accountId)` per account using the
  per-account `getAccessToken({ accountId })` to retrieve that account's
  OAuth bearer. One provider instance, stateless across accounts.
- **Codex (event-fed):** the provider has no HTTP path (doc 135 Phase 2
  rejected polling) — `CodexLimitsProvider.fetch()` returns the latest
  pushed snapshot. Account-scoping it means routing the per-turn
  `account/rateLimits/updated` notification to the account the runner used
  (orchestrator already knows which account is selected for the turn), and
  storing snapshots in an account-keyed map inside the provider instead of
  a singleton field. The poller does **not** iterate Codex accounts; it
  just exposes a `recordCodexRateLimits(accountId, snapshot)` setter that
  the adapter callback calls with the active account.

Either way, the `getAccessToken({ accountId, credentialDir })` signature
change must be reflected in the limits providers as a touchpoint.

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

A consequence of (3) is that non-primary Codex accounts never receive a turn
until the primary is exhausted, which means their quota is never hydrated.
This intentionally degrades multi-account Codex spreading to a strict
fail-over model (primary until exhausted, then secondary) rather than a
spread-the-load model. If a user wants their secondary Codex account ready,
they explicitly route a turn through it once. The Settings row for an
unknown-quota Codex account makes this state visible ("no recent turn —
quota will appear after first use").

This also means the "Session startup" rules 5/6 (quota-low primary →
healthier account) do **not** apply to Codex multi-account selection: a
quota-low (but not hard-exhausted) Codex primary still wins over an
unknown-quota secondary because the secondary's health is unproven. The
practical Codex policy is "primary until hard exhaustion, then a one-shot
probe of the secondary, then resume primary if it healed." Rules 5/6 remain
in force for Claude (where polling produces known quota for every
account).

The `OPENAI_API_KEY` fallback from doc 119 and the Claude `ANTHROPIC_API_KEY`
fallback are **not** subscription accounts and do not participate in
subscription quota ranking. Model them separately as provider auth fallbacks:

- They may make `codex` or `claude` runnable when no subscription account exists.
- They do not render a subscription-limits pill.
- They are never selected for "switch to another subscription" failover.
- Sessions that use them persist `provider_account_id = "codex-api-key"` or
  `"claude-api-key"` so history and diagnostics show that the turn used
  Platform API billing rather than subscription auth.
- If both a subscription account and the provider's API key exist, subscription
  credentials remain preferred so Platform API billing is not used silently.

`ANTHROPIC_AUTH_TOKEN` is different: route id `claude-env-oauth` is reserved,
but it is OAuth-style subscription auth per doc 135, not a pay-as-you-go
API-key path. It keeps the Claude
subscription-limits pill, quota polling, hard-exhaustion detection, and delayed
quota turns. It is excluded only from multi-account spreading/ranking among
stored provider-account rows because there is no provider-account row to update
or sync back into.

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
  pill when a provider has more than one account. Doc 135 establishes the
  badge as account-wide rather than focus-driven; with multiple accounts the
  default remains account-wide (the pill represents the active turn's
  account when one is running, otherwise the user's primary account), and a
  detail surface inside Settings shows the full per-account breakdown.
- Session diagnostics shows the active provider account for the current session.
- Settings exposes a per-pinned-session "switch account" action so the
  runtime-transition path from "Existing pinned sessions" has a user-visible
  trigger. Without this, the kill-process / clear-`agentSessionId` /
  reprovision flow exists in code but has no caller; account changes would
  only happen via disconnect-and-replace.
- Chat system messages report failover decisions:
  - `Claude: Primary exhausted until 14:30; retrying with Work account.`
  - `Claude: Primary exhausted after file edits; Work account is available. Say continue to retry from the current workspace state.`

Do not open provider dashboards for normal quota/status inspection. Billing and
account-management links live in overflow menus.

## Retry safety model

Track per-turn side effects using existing agent event observations:

- Before first tool call: safe to retry.
- After read-only tools only: safe to retry.
- After write/edit/bash/side-effecting MCP/external side-effect tools: require
  user intent.

Implementation can start coarse:

- Maintain `runner.turnHadSideEffects`.
- Mark true for `Write`, `Edit`, `Bash`, shell/file-write equivalents, git/gh
  shim writes, MCP tools except known read-only allowlist.
- Treat `Task` (Claude subagents) and any agent-spawning tool (e.g. Codex
  collaboration tools) as side-effecting from the moment they start. Their
  nested tool calls are not always visible to the parent stream, so the
  parent runner cannot prove read-only-ness on its own.
- If unknown, treat as side-effecting.

When a safe retry is decided, the orchestrator must also tear down any
persistent live-steering process bound to account A (see doc 140's
`existingAgent.sendUserMessage(...)` path) before starting the retry on
account B. The same kill/restart rules from "Existing pinned sessions" apply
to the in-turn failover case.

This intentionally favors correctness over seamless failover.

## Migration

A new `provider_account_id` column is added to the `sessions` table (and a
new provider-account table is added) via a numbered SQLite migration. The
migration must run **before** the orchestrator's first credential-move step
so that the migrated `claude-default` / `codex-default` rows have somewhere
to be referenced from. Order: schema migration → seed `claude-default` /
`codex-default` rows → move credential files (or set transitional symlinks)
→ backfill `provider_account_id` on existing pinned sessions.

Sessions that cannot be backfilled (token cannot be matched, no per-session
credential subtree) need a way to express "pinned but needs account
selection / re-auth" without overloading `agentId` or `agentPinned`. Add an
explicit `providerAccountStatus?: "needs_selection"` field on `SessionInfo`
(or equivalent), and clear it once the user picks a replacement account.

1. On startup, if root `.claude` exists and no Claude provider account exists,
   create `claude-default` by moving the writable credential source into the new
   account path, then leave only helper resolution or a symlink at the legacy
   root path.
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
  paths. Match by a **stable identity fingerprint** rather than raw token
  equality (per-session and source tokens diverge after doc-142 rotation;
  matching by token bytes would systematically mis-bucket recently-rotated
  sessions). Concrete fingerprint for Codex: the `chatgpt_account_id` JWT
  claim already extracted in `codex-auth.ts:159-198`. Concrete fingerprint
  for Claude: **to be confirmed** — `claudeAiOauth.subscriptionType` +
  `rateLimitTier` are the only stable fields the CLI persists today
  (`auth.ts:127-146`); no account-UUID is exposed in the current fixtures.
  The implementation must either (a) verify against a fresh credentials
  dump that a stable account identifier exists in `claudeAiOauth` (e.g., a
  `subscription.account_uuid` field), or (b) call the Anthropic profile
  endpoint with the token to obtain a stable identifier and cache it on the
  account row. Picking the fingerprint is a prerequisite to landing this
  feature and is also tracked as an open question below. If the fingerprint
  matches a root/default provider account, set `provider_account_id` to
  that account and keep using the existing provider-side `agentSessionId`.
  If no account row exists with that fingerprint but the token is valid
  against the provider's profile endpoint, create a new account row under
  `/credentials/provider-accounts/...` seeded from the per-session subtree
  and bind the session to it. If neither path succeeds, mark
  `providerAccountStatus = "needs_selection"` and require re-auth before
  the next turn. The per-session subtree remains only a consumer of account
  credentials.
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
- `src/server/shared/types/agent-types.ts` — add non-secret provider-account
  metadata for event decoration and, for local/direct runs, account-scoped
  credential HOME/config-root metadata consumed by adapters.
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
  pinned to account X. Today `repushTokenToPinnedSessions(agentId)` matches
  every session with `agentPinned && agentId === <provider>`; after this work
  it must also (a) filter by `providerAccountId === X` and (b) skip sessions
  pinned to reserved routes (`claude-env-oauth`, `claude-api-key`,
  `codex-api-key`) so reserved-route sessions aren't repushed with a stored
  account's token. `repushAgentToken` itself (`session-credentials.ts:323`)
  relies on "only overwrite a file the session already holds" for cross-agent
  safety; that guard does not prevent cross-account overwrite within a
  provider, so the function must also validate that the existing session
  token belongs to account X (e.g., by comparing the embedded
  `subscription.account_uuid` or refresh-token prefix) before writing.
- `src/server/orchestrator/services/claim-session.ts` — warm-pool claim is the
  most common new-session entrypoint and is agent-agnostic today; routing
  must hydrate or resolve `provider_account_id` here too so claimed sessions
  go through the same preflight as fresh sessions. Note that warm sessions
  spawned-as-first-turn via `shipit session create` reach the agent through
  `sendSystemMessage`, not `runAgentWithMessage`; the first-turn provisioning
  block currently in `agent-execution.ts:824-837` must move into the shared
  preflight so that path also pins the agent and provisions the selected
  account before the system turn starts.
- `src/server/session/claude.ts`, `src/server/session/agents/claude-adapter.ts`,
  and `src/server/session/agents/codex-adapter.ts` — allow local/direct agent
  spawns to use an account-scoped HOME/config root instead of hardcoded
  singleton paths.
- `src/server/orchestrator/limits/*` and `limits-poller.ts` — move from
  agent-keyed snapshots to provider-account snapshots.
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
- Integration: after a runner is disposed, child follow-up and other detached
  system-turn paths recreate it from persisted `agent_id` and
  `provider_account_id`, not `defaultAgentId`.
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
