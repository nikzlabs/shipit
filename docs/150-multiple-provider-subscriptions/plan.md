---
description: Allow multiple subscription accounts for the same agent provider and automatically fail over when the active subscription is exhausted.
issue: https://linear.app/shipit-ai/issue/SHI-56/multiple-provider-subscriptions-and-quota-failover
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
still need route ids for session pinning/audit. Of the three, only the env-based
auth paths exist in code today (`OPENAI_API_KEY` per doc 119; `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` per `AuthManager.checkCredentials` / `getAccessToken`
in `auth.ts`). The explicit route ids and per-route preflight contract below
are introduced by this doc — there is no `AuthManager`-style route plumbing
today; the auth state is just a derived flag on the singleton manager.
Reserved route ids:

- `codex-api-key` — run with `OPENAI_API_KEY` / OpenAI Platform API billing.
- `claude-api-key` — run with `ANTHROPIC_API_KEY` / Anthropic Platform API
  billing. New logical route name; previously surfaced only as the
  `reason: "api-key"` branch returned by `AuthManager.getAccessToken`.
- `claude-env-oauth` — run with `ANTHROPIC_AUTH_TOKEN`, used by dogfood/local
  OAuth-style env auth.

The reserved ids are not all the same kind of fallback:

- `codex-api-key` and `claude-api-key` are pay-as-you-go fallbacks. They are
  eligible only when no subscription account is selected or when the user
  explicitly chooses that billing/auth path. They do not render subscription
  quota, do not appear in subscription quota ranking, and are never selected for
  "switch to another subscription" failover.
- `claude-env-oauth` is an OAuth-style subscription route backed by
  `ANTHROPIC_AUTH_TOKEN`, matching doc 135. It has Claude subscription quota
  visibility and keeps the existing subscription-limits badge behavior. It is
  not a provider-account row, so it does not participate in multi-account
  ranking between stored account rows; however, when it is the selected Claude
  route, quota polling, hard exhaustion detection, delayed-turn handling, and
  same-route reset-time display behave like a Claude subscription account.

  Selection rule for `claude-env-oauth`: it is the selected Claude route only
  when **no stored Claude provider-account row exists** (no `acct_<id>` under
  `provider-accounts/claude/`) AND `ANTHROPIC_AUTH_TOKEN` is set in the
  orchestrator process env at preflight time. This is deterministic: once the
  user adds even one stored Claude account, the router prefers that account
  and `claude-env-oauth` is never selected, regardless of whether
  `ANTHROPIC_AUTH_TOKEN` is still set.

  **Semantic break to flag explicitly.** Today (doc 135 era), an
  orchestrator process that booted with both `ANTHROPIC_AUTH_TOKEN` set
  *and* a stored Claude credential at `/credentials/.claude` would use the
  stored credential for the CLI but render the env-OAuth-style limits pill
  from the same source. Under this doc, the Migration step turns any
  pre-existing root `.claude` into a stored `claude-default` provider
  account, so the env-OAuth selection rule's "no stored account" precondition
  no longer matches — env-OAuth is now unreachable on that host. This is
  intentional (it ends the double-source ambiguity), but it does change the
  dogfood/local code path that doc 135 described: hosts that today rely on
  the env-token being authoritative will silently switch to using
  `claude-default` after migration. Operators of those hosts should clear
  the stored credential if they specifically want env-OAuth back.

  The reserved-route preflight contract's gates for the
  `syncAgentTokenIn` / `syncAgentTokenBack` helpers therefore fire iff this
  selection rule matches. Surfacing env-OAuth as a user-selectable Settings
  entry is explicitly out of scope here.

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

## Relationship to prior docs

This doc explicitly amends two previously stated positions and depends on
several others. The amendments are called out here so a reader who finds 119 or
135 first is not surprised by 150.

- **Doc 119 non-goal "one ChatGPT account per ShipIt installation, same as
  Claude" is superseded.** Doc 119 froze multi-account Codex out of scope while
  establishing subscription auth in the first place. This doc lifts that
  restriction symmetrically for Claude and Codex; doc 119's per-installation
  singleton becomes the migrated default account.
- **Doc 135 "one pill per provider, account-wide" is extended, not replaced.**
  Doc 135's original framing rested on two assumptions that this doc partially
  undoes: (a) "exactly one pill per provider" (broken — N accounts produce N
  sub-pills or a roll-up), and (b) "the pill represents the account-wide
  number for that provider" (still true *per account*, but no longer "the
  Claude pill = the Claude account's state" since there is no single Claude
  account). The "not focus-driven" property survives: pills do not change
  when the user switches sessions. The "account-wide" property survives at
  the per-account-pill level. The "one pill per provider" property is
  explicitly relaxed. Treat doc 135's prose as describing the 1-account
  case, which remains the common case post-migration; this doc owns the
  N-account extension.
- **Doc 138 per-agent credential isolation is the substrate this doc extends.**
  Isolation moves from "agent" to "agent provider account": a session pinned to
  Claude account A never has Claude account B's credentials, Codex credentials,
  or root `shipit-credentials.json` on disk.
- **Doc 142 token sync-back is extended account-scoped.** See the explicit
  invariant in Credential provisioning below.

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

Disconnect is blocked while the account is pinned to a running session unless
the user chooses a replacement account. On disconnect (two ordered paths
depending on whether the user already picked a replacement):

Common steps (run for every disconnect):

1. Find every session pinned to that provider account.
2. Kill any live persistent agent process for those sessions so no further
   requests go out with this account.
3. Disable token sync-back for the deleted account immediately.
4. Remove the account's source credentials from
   `/credentials/provider-accounts/...`.
5. Purge **only the deleted account's** credential subtree from each affected
   per-session credentials directory. The "this belongs to the deleted
   account" decision is made by **stable account identity**, not by byte
   equality of the token file — A-copyback from doc 142 means the
   per-session token may be a strictly newer rotated value than whatever the
   orchestrator source currently holds, and a byte-equality match would
   leave that rotated token in place. Use either the JWT account claim
   (e.g. Codex `chatgpt_account_id`) or the session's persisted
   `provider_route_id` to classify the file. Do not blanket-delete the
   entire `.claude` / `.codex` subtree on disk: a session can have had a
   prior env-OAuth turn (route `claude-env-oauth` per the reserved-route
   preflight) that wrote its own `.credentials.json` to that subtree, and
   that file does not belong to the deleted provider-account row. Deleting
   the per-session subtree wholesale would clobber a still-valid
   env-OAuth-produced file and force re-auth on a path that does not
   actually depend on the deleted account. Matching-by-stable-identity is
   the boundary; the per-session subtree as a whole is *not* deleted at the
   disconnect step.
6. Clear `agentSessionId` for affected sessions because provider-side resume is
   no longer valid against any other account.

Then split by whether the user already picked a replacement:

7a. **Replacement chosen.** Update `provider_route_kind` / `provider_route_id`
    to the replacement account or reserved route. The next turn invokes the
    full account-switch replay path — replay assembly reads from ShipIt's
    persisted chat history and current workspace state, never from the deleted
    source credentials or the now-purged per-session subtree.
7b. **No replacement.** Mark sessions as needing account selection/re-auth
    before the next turn. The recovery path runs at next-turn time: it
    re-provisions the user-selected account, clears any residual
    `agentSessionId`, and starts from local context via the same replay
    mechanism.

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
   above 90% or known weekly usage is at or above 95%. For Claude accounts that
   expose `weeklyOpus` / `weeklySonnet` sub-windows (`usage-limits-types.ts`),
   the sub-window that matches the *requested model* counts as the weekly
   window for this check — a Claude Max account at 100% `weeklyOpus` and 40%
   `weekly` is quota-low (and effectively exhausted) for an Opus turn, but
   healthy for a Sonnet turn. The model → window mapping for Claude is:

   | Requested model | Window used |
   | --- | --- |
   | `opus` | `weeklyOpus` if present on this account's snapshot, otherwise `weekly` |
   | `sonnet` | `weeklySonnet` if present, otherwise `weekly` |
   | `haiku` | `weekly` (no per-model sub-window today) |
   | any other / unknown model | `weekly` |

   Codex has only the top-level `weekly` window today; all Codex turns use
   that one. If a plan publishes `weeklyOpus` but not `weeklySonnet` (or vice
   versa), the missing sub-window is treated as "absent" per the table —
   the requested model falls through to `weekly`, not to "Opus is
   ineligible because Opus quota is unknown." Sub-window absence is
   structural (the plan does not split that model) and is distinct from
   "unknown quota" (the snapshot has not been hydrated yet).
   If the primary account is quota-low and another eligible account is not
   quota-low, choose the healthier account instead of primary.
6. Prefer accounts with the most remaining weekly quota; use short-window quota
   as the tiebreaker.
7. If all eligible accounts are exhausted, put the prompt into a delayed
   recoverable state with a wake-up time, show a chat-visible system message
   with reset times, and do not start the agent.

Eligibility is checked before quota ranking. A fallback account that cannot run
the selected model, image support, MCP/review capability, or other
provider-gated feature is not a valid substitute for the turn. This matters
because two accounts for the same provider can have different plans, enterprise
policy, regional access, beta flags, or model availability. Failover must not
silently downgrade behavior. If no account can satisfy the current turn's
feature requirements, ShipIt surfaces that as an account/model availability
problem instead of trying a lower-capability subscription.

**Permission mode is not part of the persisted-capability eligibility check.**
Doc 138's behavior — silently downgrading `guarded` → `auto` when a runner
reports the CLI rejected guarded — is per-runner volatile (see "Per-account
capability facts"). The eligibility predicate therefore queries
`capabilities` for model / image / MCP / review fields only, and queries the
**live runner's** `guardedUnavailable` flag for guarded-mode availability
when the requested mode is `guarded`. The non-guarded modes (`plan`, `auto`,
default) do not participate in eligibility ranking at all — they are
supported by every provider account by construction. If a future provider
introduces an account that genuinely cannot run a non-guarded mode, model
that as a `supportedPermissionModes` snapshot in `capabilities` at that
time; today the field exists in the interface for forward-compatibility but
is not consulted by the router.

Per-account capability facts live on `ProviderAccount` as a cached
`capabilities` snapshot:

```ts
interface ProviderAccountCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: PermissionMode[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}
```

Sources:

- Provider profile/auth metadata seeds plan/tier-derived defaults when stable.
- The agent registry supplies provider-wide defaults as a conservative fallback.
- Runtime `agent_init` updates the account that actually ran the turn.

Guarded-mode availability is **not** part of the persisted capability snapshot.
Doc 138 (per-runner `guardedUnavailable`) defines it as a volatile per-runner
flag that clears on session/container restart and on page reload, so that an
admin later enabling auto mode is rediscovered on the next fresh attempt.
Persisting it on `ProviderAccount.capabilities` would reverse that design and
create a long-lived "this account can't run guarded" cache with no reliable
invalidation signal. The router therefore treats guarded availability as a
per-runner observation only: if the live runner for this account has already
set `guardedUnavailable`, that runner downgrades guarded → auto as today; the
account row itself never carries that state across runners or restarts.

Selection treats unknown capability conservatively for automatic failover:

- If the current/primary account has unknown-but-unproven capability, it may be
  attempted because that matches today's behavior.
- A fallback account with unknown capability is not used for **automatic
  failover** when the current turn requires that capability; ShipIt asks for
  user intent or reports `no_model_eligible_account` / `capability_unknown`
  instead.
- Guarded-mode eligibility is checked via the live per-runner `guardedUnavailable`
  flag rather than `capabilities`, in line with the rule above.

**Narrow first-use exception.** The "primary may be attempted with unknown
capability" bullet above is already enough to unblock the very first turn
when the primary itself is usable. The remaining case the conservative rule
would over-block is: primary is exhausted or auth-failed on the very first
turn for this provider — no account has produced an `agent_init` yet, so
*every* non-primary fallback also has unknown capability. In that single
case (no prior `agent_init` exists on this provider AND the primary cannot
run this turn), the router may select one non-primary unknown-capability
account to bootstrap the snapshot, instead of returning
`no_model_eligible_account`. Codex's unknown-quota fallback rule (Quota and
exhaustion detection rule 4) is unaffected — it already selects in the
unknown-quota case independent of this exception.

The reserved route `claude-env-oauth` has no `isPrimary` notion — it is not
a provider-account row, so the "primary vs non-primary" framing above does
not apply. When env-OAuth is the only Claude auth available (the selection
rule's precondition), the router selects it directly without consulting
the first-use exception. Its capabilities snapshot still hydrates on its
first `agent_init` as a special key on
`SubscriptionLimitsMap.claude["claude-env-oauth"]` (per the
`SubscriptionLimitsMap` definition above); the same conservative rule then
gates *future* unknown-capability fallback to a stored Claude account if one
is added later.

An exhausted turn cannot use the existing in-memory message queue by itself.
Today queued messages drain from agent completion paths; if no agent starts,
there is no completion event to wake the queue after a quota reset. Delayed
quota waits therefore need their own persisted/scheduled state:

- materialize attachments to stable on-disk paths **before** persisting the
  delayed turn: today `runAgentWithMessage` calls `saveImagesToUploadsDir`
  during prompt assembly (not "immediately before `agent.run`," but well before
  the agent ever spawns). Inline base64 images only exist in the WS payload up
  to that point. The preflight that delays a turn must run that same write
  step first so the delayed record references stable file paths, not WS-only
  base64 bytes. If materialization itself fails (disk full, permission error,
  workspace dir missing), the delay is **rejected** rather than persisted
  with broken file references: the user gets an immediate chat-visible error
  ("could not stage attachments for delayed turn — exhaustion still in effect
  until <reset>; try again with attachments removed or after reset") and the
  turn ends in an error state. The session is not pinned, no delayed-turn
  record is written, and no timer is scheduled.
- conversely, the preflight must NOT run the first-turn side effects that
  follow attachment materialization in today's order — first-turn
  `provisionAgentCredentials`, `setAgentId` / `setAgentPinned`,
  `syncAgentTokenIn`, and `tryPushAgentSecrets`. Running any of these and then
  deferring would (a) pin the session to an account before the user has had a
  chance to pick a replacement during the wait, (b) leave a provisioned
  credential subtree that no turn ever consumed, and (c) defeat the
  replacement-account recovery path in the disconnect section. The preflight
  must decide "is this turn going to be delayed?" **before** running any of
  those steps,
- persist the full turn request in a delayed-turn table or session field:
  user text, validated file refs, upload refs, image refs (the on-disk paths
  just materialized), permission mode, review-file authorization, selected
  model, selected agent, target provider, and the assembled prompt/context
  snapshot needed to restart deterministically,
- schedule an orchestrator timer for the earliest eligible reset,
- re-check account eligibility/quota at wake time before starting,
- revalidate that referenced files/uploads still exist and surface a recoverable
  error instead of starting with silently missing context,
- broadcast the delayed state so reconnecting clients show why the prompt is not
  running,
- allow the user to cancel or replace the delayed prompt from chat.

If the process restarts before the reset, startup tasks reload delayed turns and
re-arm their timers.

**Interaction with the in-memory message queue.** `drainNextQueuedMessage`
calls `runAgentWithMessage` recursively without going through
`handleSendMessage`, so a dequeued message hits the same preflight as a fresh
one. The exhaustion path must not produce one delayed-turn record per queued
message — that would land N orchestrator timers for the same reset window,
and the user would see N rolling failover messages as each timer fires.

The rule is:

- A turn can be moved to the delayed state at most once. The first preflight
  that detects `all_exhausted` either persists the active prompt as a delayed
  turn **or** marks the rest of the queue as deferred behind the same wake-up
  event, but it never persists multiple separate delayed-turn records for one
  exhaustion window.
- While at least one delayed turn exists for a session, `drainNextQueuedMessage`
  short-circuits: it does not call `runAgentWithMessage` for further queued
  messages. The queue is held in-memory as today; the wake-up handler is the
  only path that resumes draining.
- When the wake-up fires and the active delayed turn starts, ordinary
  post-turn drain takes over from there.

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

### Existing pinned sessions

Sessions need three persisted fields rather than overloading one:

- `agent_id` — existing provider/agent (`claude`, `codex`).
- `provider_route_kind` — `"account"` when the turn ran through a stored
  provider-account row, `"reserved"` when it ran through one of the reserved
  auth routes. Every read path branches on this discriminator before treating
  the route id below as either an account row id or a reserved route id.
- `provider_route_id` — when `provider_route_kind === "account"`, this is the
  `ProviderAccount.id` (the doc uses the `acct_<...>` prefix above to make this
  obvious in stored credentials paths). When `provider_route_kind === "reserved"`,
  this is one of `codex-api-key`, `claude-api-key`, or `claude-env-oauth`. The
  split avoids a single overloaded `provider_account_id` column that mixes UUIDs
  and magic strings.

(The rest of this doc still uses the shorter "`provider_account_id`" name in
prose where the discriminator is implicit from context — for example, when
explicitly talking about provider-account rows. Persistence and APIs use the
two-field form.)

`claude-env-oauth` is still subscription-style OAuth for quota purposes even
though it is stored as a reserved route and not as a provider-account row.

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
3. **Tighten the A3 re-push guard.** Today
   `repushAgentToken` / `repushTokenToPinnedSessions` (app-lifecycle.ts) only
   filter by `session.agentId === agentId` and "session holds the agent's
   token file." That filter is not safe across account switches: if A3 fires
   for account A *after* this session has just been switched to account B,
   today's filter still matches (the session still holds a Claude/Codex
   token file from earlier) and account A's source token would be written
   into a B-pinned session. Gate the write with an additional
   `session.providerRouteKind === "account"` and
   `session.providerRouteId === accountId` check; auth-complete events
   themselves are already account-qualified per the auth-managers section.
4. **Replace the provider credential subtree in the session credential
   directory with account B's subtree before the next `/agent/start`.**
   `provisionAgentCredentials` uses `cpSync({ force: true })`, so files that
   exist in both A's and B's subtrees are overwritten by the copy itself. The
   explicit "delete" step is only needed for files A's subtree contains that
   B's does NOT — for example, cached `.claude/settings.json` written by the
   CLI under account A, or any per-account state file the CLI no longer
   produces under B. Provisioning therefore (a) recursively removes the
   existing provider subtree first, then (b) copies B's subtree in. Doing
   this in one provisioning step (rm-then-copy) is preferable to a separate
   "delete A files" step because it leaves no window in which the per-session
   subtree is empty or half-A/half-B.
5. Build an explicit replay package from ShipIt's persisted chat history and
   current workspace state before starting account B. This package includes the
   user/assistant transcript since the last checkpoint or bounded summary, any
   still-relevant file references, active thread/checkpoint metadata, current git
   diff summary, and a note that provider-side resume was reset because the
   account changed. Inject it into the system prompt or first user message using
   the same conversation-replay mechanism used when `agentSessionId` is cleared.
6. Record a chat-visible system event that the session moved from account A to
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
  // status is "ready" | "authenticating" | "auth_failed" | "unavailable".
  // "exhausted" is NOT a stored status — it is derived from
  //   exhaustedUntil != null && exhaustedUntil > now.
  // Storing it would create two sources of truth that can drift, which is
  // the same bug class doc 142 calls out for checkCredentials(). Selection
  // and UI must compute exhaustion at read time from exhaustedUntil.
  status: "ready" | "authenticating" | "auth_failed" | "unavailable";
  plan?: string | null;
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  /**
   * Earliest reset time across whichever quota window(s) are currently at
   * 100%. Used to schedule the delayed-turn timer and to render reset
   * hints; NOT an exhausted/ready boolean. Whether a given turn is blocked
   * is computed at selection time from `quota.*.usedPct` against the
   * requested model's window (see Quota and exhaustion detection).
   */
  exhaustedUntil?: number | null;
  quota?: SubscriptionLimits;
  createdAt: number;
  updatedAt: number;
}
```

In-flight auth state is **not** persisted on `ProviderAccount`. The
`{ provider, accountId }`-keyed pending-auth tracking described under "Auth
managers become account-scoped" (in-flight process handle, last pending URL/
code event, timeout, output buffer, completion/failure state) lives in an
in-memory map keyed by `{ provider, accountId }`, owned by the relevant auth
manager. The persisted `ProviderAccount.status` only reflects
`"authenticating"` while a flow is active, and is reset (to `"ready"` /
`"auth_failed"`) on process exit so a crash mid-flow doesn't leave a
permanent `"authenticating"` row.

`ProviderAccountCapabilities.source` precedence (highest first): `agent_init`
> `provider_profile` > `manual_default`. Runtime `agent_init` is the
authoritative observation and may clobber any prior `source`. Auth/profile
refreshes may only overwrite `manual_default`; they MUST NOT downgrade an
`agent_init`-sourced snapshot to `provider_profile` even if the profile
disagrees, because the runtime observation tells us what actually ran.
`refreshedAt` is updated on every overwrite and is the tiebreaker when two
sources of equal precedence disagree.

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
from doc 142. Compatibility goes through one path only:

- **Required: all code resolves credentials through `ProviderAccountManager`.**
  Legacy root paths are read only during the migration step itself and are not
  used afterwards. Singleton helper methods continue to exist for backward
  compatibility, but their implementations route through `ProviderAccountManager`
  and resolve to the primary account's file — not a second copy. Concretely,
  this means **rewriting `AuthManager.checkCredentials` and the related
  helpers** to ask `ProviderAccountManager.resolveCredentialDir({ provider,
  accountId: <primary> })` for the path on every call, rather than reading
  the module-level `CLAUDE_CONFIG_DIR` / `CODEX_CONFIG_DIR` constants. Just
  rebinding those constants at startup is **not** a working alternative
  here: once the primary account changes (via "make primary" in Settings),
  any code that captured the old constant in a closure or held a reference
  would read the wrong account's tokens. Route every read through the
  manager so primary-change is observed on the next call.
- **Explicitly rejected: stacked symlinks** (`/root/.claude` →
  `/credentials/.claude` → `provider-accounts/<provider>/<accountId>/.claude`).
  The session-worker image already stages `/root/.claude` →
  `/credentials/.claude` (doc 138); making `/credentials/.claude` a second
  symlink to an account-qualified path adds a CLI-atomicity dependency that is
  not guaranteed across CLI versions (the Claude CLI's atomic-rename refresh
  through two stacked symlinks is not a documented contract). Going through
  `ProviderAccountManager` keeps the symlink graph one level deep.
- **Explicitly rejected: copying token files into root and account paths where
  both can be refreshed independently.** This is the doc-142 split-token bug.

`capabilities` persists the account-specific snapshot described in session
startup. Migration initializes it from provider-wide `AgentRegistry` capabilities
with `source: "manual_default"`. Auth/profile refreshes and runtime `agent_init`
observations update it in `CredentialStore`, so fallback eligibility survives
orchestrator restarts. Guarded-mode availability is excluded from the persisted
snapshot — see "Per-account capability facts" above.

### Agent availability gates

`AgentRegistry.authConfigured` remains a coarse agent-level signal for existing
UI and server gates, but its meaning changes:

- `claude.authConfigured = true` when at least one authenticated Claude provider
  account exists, even if every account is currently quota-exhausted, or a
  supported reserved Claude auth route exists (`claude-api-key` or
  `claude-env-oauth`).
- `codex.authConfigured = true` when at least one authenticated Codex
  subscription account exists, even if exhausted, or `OPENAI_API_KEY` is
  configured.
- `AgentRegistry.available()` answers only "is this provider installed and has
  at least one credential of any kind?" It does **not** choose an account and
  does **not** guarantee that any account/route can satisfy the next turn — in
  particular, `available() === true` does not imply "ready to start a turn now"
  if every account is quota-exhausted. This is a deliberate semantic shift from
  the current "has working auth" reading; consumers that treated `available()`
  as "an agent can be picked right now" must move to
  `ProviderAccountManager.selectAccountForTurn(...)` before starting work.
  Existing call sites of `agentRegistry.available()` / `agentRegistry.get(id)?.
  authConfigured` (home-screen agent picker, default-agent resolution, dogfood
  startup gates) must be audited as part of phase 1; any that need the stricter
  "can actually run now" guarantee migrate to `selectAccountForTurn`.

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
- **Invariant — same-account sync only.** Doc 142's expiry/freshness guard
  compares the per-session token against "the source" token. That comparison
  must be account-X session token vs account-X source token only. It must
  never cross to the legacy root `.claude` / `.codex` path or to another
  account's source. The migration's compatibility behavior (root paths resolve
  to the primary account through `ProviderAccountManager`) makes the legacy
  root indistinguishable from one specific account's source — using it for
  comparison against a different account's session would silently corrupt the
  freshness signal or skip a needed write.
- Expiry/freshness guards remain provider-specific.
- Re-auth re-push from doc 142 A3 becomes account-scoped too. On auth completion
  for account X, force-copy the fresh source token only into sessions pinned to
  `{ provider, accountId: X }`; do not re-push to every session pinned to the
  provider. Auth completion events must therefore include `accountId`.

### Agent startup

Continue the existing pattern: `AgentRunParams` carries no raw credentials
today, and that does not change here. The orchestrator selects the account
before runner start and provisions files into the session credential subtree.
The worker/adapter continues to see normal CLI paths:

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
agnostic — option 2 above. The orchestrator-boundary emitter sets:

```ts
providerAccountId?: string;
providerAccountLabel?: string;
```

on the `agent_init` event after it leaves the adapter, before it reaches chat
history persistence or the WS broadcast. This gives chat history and
diagnostics an audit trail without exposing secrets.

Implication for the touchpoint list below: `agent-types.ts` does **not** need
a new `agent_init` field for this metadata, because decoration happens above
the adapter. The `agent-types.ts` change is limited to the local/direct-run
HOME/config-root metadata (see Runtime modes). If a future contributor needs
the metadata on the in-adapter event for some reason, switch to option 1
explicitly — do not silently mix the two paths.

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

Crucially, swapping HOME alone is not sufficient. The orchestrator's own
environment may carry `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY` from earlier configuration; if those leak into the child env,
they beat the on-disk credentials the new HOME points at and routing silently
no-ops. The local adapter spawn must therefore:

- start from a curated env, not blanket `...process.env`, and
- explicitly scrub provider auth env vars that do not belong to the selected
  route (e.g. unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` for a stored
  Claude account route; unset `OPENAI_API_KEY` for a stored Codex account
  route; conversely, set exactly the env vars the reserved route requires).

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

Reserved route ids have an explicit preflight contract because they are not
provider-account rows:

| Route id | Provisioning | Env/config pushed to the runner | Token sync | Quota/delayed-turn behavior |
| --- | --- | --- | --- | --- |
| `codex-api-key` | Skip provider-account credential copy. Preserve any existing subscription `.codex` files instead of deleting them. | Set `OPENAI_API_KEY` for the Codex run and ensure adapter config prefers the API-key path over subscription files for this attempt. | No-op; API keys do not rotate through the Codex subscription token store. | No subscription quota. It is not ranked with subscription accounts, not used for subscription failover, and does not create delayed quota turns. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-api-key` | Skip provider-account credential copy. Preserve any existing subscription `.claude` files instead of deleting them. | Set `ANTHROPIC_API_KEY` for the Claude run and ensure adapter config prefers the API-key path over OAuth files for this attempt. | No-op; API keys do not rotate through the Claude OAuth token store. | No subscription quota. It is not ranked with subscription accounts, not used for subscription failover, and does not create delayed quota turns. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-env-oauth` | Skip provider-account credential copy because the source of truth is the orchestrator/session env, not `/credentials/provider-accounts/...`. Per the selection rule above, this route is only ever chosen when no stored Claude account row exists, so there is no `provider-accounts/claude/acct_<id>/` subtree to preserve. Any `.credentials.json` the CLI writes during this env-OAuth turn stays local to the per-session credential subtree; it is never copied back to `provider-accounts/...`, and if the user later adds a stored Claude account the next preflight switches off env-OAuth and the per-session file is purged on the normal account-switch path. | Set `ANTHROPIC_AUTH_TOKEN` and do not set `ANTHROPIC_API_KEY`. Claude must treat the bearer as the selected OAuth source, matching doc 135's env-token path. | Both `syncAgentTokenIn` and `syncAgentTokenBack` are explicitly **disabled** for this route at the helper-invocation site. `AGENT_TOKEN_FILES[claude]` is a static map in `session-credentials.ts` and is not mutated per-route; the gate belongs in the preflight code that decides whether to call the helpers at all. Without that gate, the generic file-list pathway would still pull a token file into and out of the env-OAuth session. If the provider returns a refreshed token file during the run, it must not be copied into a stored provider-account row. | Subscription-style quota applies. The limits badge remains visible, hard exhaustion can create delayed quota turns, and reset-time handling matches Claude OAuth accounts. It is not ranked against stored provider-account rows for multi-account spreading because it has no account row; it is used when explicitly selected, pinned from migration/local auth, or when no stored Claude account exists and env OAuth is the available Claude auth. |

Preflight must check route kind before assuming a `provider_account_id` can be
loaded from `ProviderAccountManager`. Account-row provisioning, capability
metadata writes, and token copy-back only run for real provider-account ids.
Reserved-route handling still records the selected route in turn metadata so
`agent_init`, diagnostics, and post-turn cleanup can explain which auth path
was used.

Detached/system-turn paths must hydrate persisted session routing before creating
or reusing a runner. Today `SessionRunnerRegistry.getOrCreate(sessionId,
sessionDir, defaultAgentId: AgentId): SessionRunnerInterface` carries only
the agent id. Two ways to wire the route through:

1. **Preferred — keep the registry signature minimal.** Every call site
   reads `SessionInfo.{agentId, providerRouteKind, providerRouteId}` first
   and passes the persisted agent id (not `defaultAgentId`) into
   `getOrCreate(...)`; the route fields are then consumed by the shared
   preflight (`prepareProviderAccountTurn`) before `agent.run(...)` or
   `existingAgent.sendUserMessage(...)`. The runner itself doesn't need to
   know its route — the preflight resolves it per turn. This keeps the
   registry signature unchanged and makes route resolution a per-turn
   decision (which it needs to be anyway, for account switches).
2. **Alternative — extend the signature.** Add an optional
   `route?: { kind: "account" | "reserved"; id: string }` parameter; the
   runner stores it for diagnostics only. Implementation is freer to choose
   this if there is a clear reason, but the registry should not become the
   source of truth for route — `SessionInfo` is.

Either way, falling back to `defaultAgentId` before preflight would recreate
the runner under the wrong provider and can bypass the pinned account.

The concrete `runnerRegistry.getOrCreate(...)` call sites today that need
attention are:

- `src/server/orchestrator/services/child-sessions.ts:529`
  (`sendChildMessage`) — child follow-up messages after the runner was
  disposed. **Hydration:** must read persisted routing before passing the
  agent id.
- `src/server/orchestrator/services/child-sessions.ts:321`
  (`spawnChildSession`) — child session's very first turn. **Selection,
  not hydration:** there is no persisted routing to read; the spawn path
  is the first place we *create* it. Covered by the
  "child-session inheritance policy" question in Open questions: this
  site either inherits the parent's `{ provider_route_kind, provider_route_id }`
  or runs the normal account router. Either way it must persist the
  routing before `setAgentPinned` fires.
- `src/server/orchestrator/services/recovery.ts` — both recovery paths that
  call `deps.runnerRegistry.getOrCreate(...)` during the `creating_container`
  phase. **Hydration.**
- `src/server/orchestrator/index.ts` — the test/dev runner-state endpoint
  that calls `runnerRegistry.getOrCreate(..., defaultAgentId)`. **Hydration**
  for consistency, even though this is a non-production path.

The shared preflight then validates that the hydrated account/route is still
usable before the turn starts.

### Quota and exhaustion detection

Doc 135's limits map changes shape from a one-level agent-keyed record to a
two-level agent → account-or-route record. This is a real wire-format change
broadcast over SSE — the SSE payload that today carries `{ claude: {...},
codex: {...} }` now carries `{ claude: { acct_a: {...}, acct_b: {...} },
codex: { acct_x: {...} } }` — so every client/server consumer of the
snapshot has to be updated together. The outer `Partial<...>` wrapper is
preserved so a missing top-level key still means "this provider has no
pill," in line with doc 135's "missing key = no pill" convention:

```ts
type SubscriptionLimitsMap = Partial<Record<
  AgentId,
  Partial<Record<string, SubscriptionLimits>>
>>;
```

Consumers that must change together (not exhaustive — verify against
current code at implementation time):

- Server: `src/server/orchestrator/limits/*`, `limits-poller.ts`
  (`getSnapshot`), the SSE broadcast site that emits
  `subscription_limits`.
- Client: `src/client/stores/ui-store.ts` (or wherever the snapshot is
  cached), `src/client/hooks/useServerEvents.ts` (the
  `subscription_limits` event handler), `src/client/AppLayout.tsx` /
  `SubscriptionLimitsBadge.tsx` (the renderer), and any helper such as
  `getSubscriptionLimitsSnapshot` that currently returns the flat shape.

Touchpoints below already name the server entries; the client entries are
called out under "Client architecture" but should be considered part of the
same migration commit so a snapshot in the new shape never reaches a client
that expects the old one.

The inner `string` key is either a stored provider-account row id
(`acct_<...>`) or the literal sentinel `"claude-env-oauth"` for the reserved
env-OAuth route — that route has Claude subscription quota (see Reserved
routes) but no account row, so it cannot be keyed by `acct_<id>`. The two
API-key reserved routes (`codex-api-key`, `claude-api-key`) do NOT appear in
this map: they have no subscription quota and no pill, matching the existing
"missing key = no pill" rule.

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
5. If the primary is itself ineligible (auth-failed / disconnected / not in
   the eligible set) and multiple non-primary accounts have unknown quota,
   tie-break by `lastUsedAt` descending — the most recently used non-primary
   account is most likely to still have a healthy session and is the least
   surprising default. If no `lastUsedAt` exists (none have ever been used),
   tie-break by `createdAt` ascending (the oldest account added). Record that
   the first turn will hydrate that account's quota.
6. Once a Codex snapshot arrives, update only the account used by that runner.

The `OPENAI_API_KEY` fallback from doc 119 and the Claude `ANTHROPIC_API_KEY`
fallback are **not** subscription accounts and do not participate in
subscription quota ranking. Model them separately as provider auth fallbacks:

- They may make `codex` or `claude` runnable when no subscription account exists.
- They do not render a subscription-limits pill.
- They are never selected for "switch to another subscription" failover.
- Sessions that use them persist `provider_route_kind = "reserved"` with
  `provider_route_id = "codex-api-key"` or `"claude-api-key"` so history and
  diagnostics show that the turn used Platform API billing rather than
  subscription auth.
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

Exhaustion is **derived per turn from `quota` plus turn metadata**, not
stored as a single account-wide flag — a Claude Max account at 100%
`weeklyOpus` and 40% `weekly` is exhausted-for-this-turn when the requested
model is Opus and ready-for-this-turn when it is Sonnet, and an
account-wide `exhaustedUntil` cannot model that. `ProviderAccount.exhaustedUntil`
therefore stores **only** the next reset time, not an exhausted/ready
boolean: it is the earliest reset across whichever windows are currently at
100%, used to schedule the delayed-turn timer. Whether the account is
exhausted "right now" for a given turn is computed at selection time from
`quota.*.usedPct` against the requested model's window (see "model → window
mapping" in the Session startup quota-low rule). Today's 'account-wide,
single-window' Codex case is a degenerate special-case of this rule: only
the top-level `weekly` window exists, so the per-turn computation collapses
to the same value `exhaustedUntil` would have held.

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
  pill when a provider has more than one account. This is the doc-135
  amendment described in "Relationship to prior docs": the pill is still
  account-wide, never focus-driven, but a provider with N accounts now expands
  into N sub-pills or a roll-up rather than collapsing to a single number. The
  grouped layout MUST keep the header non-shifting for the common 1-account
  case so existing users see no UI change after migration.
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
- After write/edit/bash/side-effecting MCP/external side-effect tools: require
  user intent.

Implementation can start coarse:

- Maintain `runner.turnHadSideEffects`.
- Mark true for `Write`, `Edit`, `Bash`, shell/file-write equivalents, git/gh
  shim writes, MCP tools except known read-only allowlist.
- If unknown, treat as side-effecting.

This intentionally favors correctness over seamless failover.

## Migration

1. On startup, if root `.claude` exists and no Claude provider account exists,
   create `claude-default` by moving the writable credential source into the new
   account path, then leave only helper resolution or a symlink at the legacy
   root path.
2. Same for root `.codex`.
3. Keep root singleton paths as compatibility aliases for one release:
   singleton call sites resolve the primary account.
4. Once all call sites use `ProviderAccountManager`, remove direct root-path
   reads except migration.

Existing sessions without `provider_account_id` are split by pin state.
Before classifying pinned sessions, run doc 142's A-copyback
(`syncAgentTokenBack` in `session-credentials.ts`) to ground state once so
root/default sources reflect the freshest token the CLI has produced; without
that, the matching below would over-classify sessions with a
mid-session-refreshed token as "newer than every source" and force avoidable
re-auth. (Doc 142 ultimately dropped its "A2" expiry-check rule; the
copy-back is just "A" / "A-copyback" — there is no separate A2 step to run.)

- **Unpinned sessions:** use the provider primary account on their next turn.
- **Pinned session token byte-matches a root/default account:** set
  `provider_route_kind = "account"` and `provider_route_id` to that account
  and keep using the existing provider-side `agentSessionId`. The per-session
  subtree continues as a derived runtime copy; archive/reset/janitor paths
  may remove it freely. **Why byte-equality is safe here but rejected in the
  disconnect flow:** the disconnect flow runs at an arbitrary later time
  when A-copyback may have rotated either the source token or the
  per-session copy independently, so bytes can diverge while still belonging
  to the same account. The migration step runs *immediately after* the
  A-copyback ground-state pass mentioned above — at that point the source
  token reflects the freshest CLI value, so byte equality is a valid proxy
  for identity. Outside that one-shot startup pass, fall back to the
  stable-identity rule the disconnect flow uses (JWT account claim or
  persisted `provider_route_id`).
- **Pinned session token is strictly newer than every root/default source
  (mid-session refresh that A2 copyback couldn't reconcile):** the token
  works, so do not force re-auth. Copy it into a new account-qualified
  source under `/credentials/provider-accounts/<provider>/acct_<id>/...`
  only after validating it via a real provider call (e.g. quota fetch for
  Claude, status fetch for Codex), then point the session at that new
  account row. Bytes from the per-session subtree must not be promoted to
  a stored account without that validation step.
- **Pinned sessions whose credential source cannot be identified:** mark the
  session as needing re-auth/account selection before the next turn. The
  recovery path must kill any persistent process, clear `agentSessionId`,
  provision the chosen account, and restart from local context.

The per-session subtree is always a consumer of account credentials, never
the source of truth.

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
- `src/server/shared/types/agent-types.ts` — add a non-secret
  `AgentRunParams.providerCredentialHome?: string` field used **only by the
  local/direct-run path** to tell adapters which HOME/config-root to spawn
  the CLI with. The container path remains unchanged (credentials are
  provisioned into the per-session subtree before `/agent/start` and the
  adapter still sees `/root/.claude` / `/root/.codex`). No new `agent_init`
  field is added here — provider-account metadata for events is decorated
  at the orchestrator boundary, not inside the adapter; see Agent startup.
- `src/server/orchestrator/session-runner.ts` and
  `src/server/orchestrator/container-session-runner.ts` — route
  `sendSystemMessage` / `runSystemTurn` through the same provider-account
  preflight used by WebSocket turns.
- `src/server/orchestrator/runner-registry-factory.ts` — inject the
  provider-account preflight/sync dependencies into `SystemTurnDeps`.
- `src/server/orchestrator/services/child-sessions.ts` — two distinct sites
  need changes:
  - `spawnChildSession` (~:321) — agent-spawned sessions bypass
    `runAgentWithMessage` and directly provision credentials before
    `sendSystemMessage`; this site must select or inherit a provider account,
    persist `provider_route_kind` / `provider_route_id`, and provision
    account-qualified credentials before setting `agent_pinned`.
  - `sendChildMessage` (~:529) — child follow-up messages after the runner
    was disposed; this site must hydrate persisted routing from `SessionInfo`
    and pass the persisted agent into `getOrCreate(...)` instead of falling
    back to `defaultAgentId`.
- `src/server/orchestrator/services/github-ci-fix.ts` and other services that
  call `sendSystemMessage` — rely on the shared system-turn preflight rather
  than assuming WS setup has already provisioned credentials.
- `src/server/orchestrator/services/rebase-driver.ts` — route rebase/conflict
  recovery direct `agent.run(...)` calls through provider-account preflight,
  sync, and metadata decoration. This is a **new responsibility** for this
  service: today it calls `agent.run(...)` without provisioning credentials
  or running token sync (it relies on prior WS-path setup having done so),
  so the change is "rebase-driver now runs the full system-turn preflight,"
  not "rebase-driver now also passes one extra argument." Cancellation /
  error paths in the rebase driver must trigger the same delayed-turn /
  recoverable-error handling as the chat path when preflight reports
  `all_exhausted` or `auth_required`.
- `src/server/orchestrator/app-lifecycle.ts` — account-qualify auth-complete
  handling and token re-push so re-auth for account X updates only sessions
  pinned to account X. `repushAgentToken` /
  `repushTokenToPinnedSessions` must gain an `accountId` parameter and stop
  treating "session has any token file for this agent" as sufficient match.
- `src/server/orchestrator/app-di.ts` — re-point the `AgentRegistry` auth
  callbacks (`checkClaudeAuth`, `checkCodexAuth`) from singleton
  `authManager.checkCredentials()` / `codexAuthManager.checkCredentials()` to
  `providerAccountManager.hasAnyAuthForProvider(...)` so `authConfigured` is
  derived from the account registry rather than the singleton manager state.
  The implementation must mirror the route distinctions the rest of this doc
  draws, not collapse them:
  - `hasAnyAuthForProvider("claude")` returns true iff
    (any stored Claude provider-account row exists)
    OR (`process.env.ANTHROPIC_API_KEY?.trim()` is set)
    OR (`process.env.ANTHROPIC_AUTH_TOKEN?.trim()` is set).
    This coarse predicate intentionally does NOT mirror the env-OAuth
    *selection* precondition ("no stored Claude account exists") — that
    precondition belongs at selection time, not at "is this provider
    configured at all?" time. Having any of the three signals counts as
    configured for the purpose of `authConfigured`.
  - `hasAnyAuthForProvider("codex")` returns true iff
    (any stored Codex provider-account row exists)
    OR (`codex-api-key` reserved route eligible:
    `process.env.OPENAI_API_KEY?.trim()` is set).
  Without these reserved-route checks the rewiring silently regresses
  today's behavior. For Claude specifically, the `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` env vars already count toward today's
  `authConfigured` — `AuthManager.checkCredentials` ORs `hasCredentials ||
  hasApiKey || hasAuthToken` (see `auth.ts`) — so the `claude-api-key` /
  `claude-env-oauth` OR clauses here are **preserving** existing behavior
  through the new resolver, not adding new behavior. For Codex, the env-var
  OR was added in doc 119 (`AUTH_ENV_KEYS["codex"]`) and is preserved the
  same way.
- `src/server/session/claude.ts`, `src/server/session/agents/claude-adapter.ts`,
  and `src/server/session/agents/codex-adapter.ts` — allow local/direct agent
  spawns to use an account-scoped HOME/config root instead of hardcoded
  singleton paths.
- `src/server/orchestrator/limits/*` and `limits-poller.ts` — move from
  agent-keyed snapshots to provider-account snapshots.
- `src/server/shared/types/usage-limits-types.ts` — account-keyed limits map.
- `src/server/shared/types/domain-types.ts` / `sessions.ts` — persist the
  two-field `provider_route_kind` (`"account" | "reserved"`) and
  `provider_route_id` on `SessionInfo`. Migration writes both for existing
  sessions per the Migration section. The prose shorthand
  "`provider_account_id`" used elsewhere in this doc maps onto this field
  pair; persistence and APIs MUST use the two-field form, not an overloaded
  single column.
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

Implementation started:

- `CredentialStore` now persists provider-account rows and
  `ProviderAccountManager` owns default-account migration, primary account
  lookup, coarse `authConfigured` checks, and reserved-route selection for the
  current singleton/env paths.
- Existing root `.claude` / `.codex` credentials migrate into
  `provider-accounts/<provider>/<default-account>/...` and the legacy root path
  remains an alias so current auth managers keep working while call sites move
  to the manager.
- Sessions persist `provider_route_kind` and `provider_route_id`, and the shared
  `prepareSessionAgentEnvironment` / `finalizeSessionAgentEnvironment` path
  provisions and syncs account-qualified credentials when the selected route is
  a stored account.
- Account-qualified token sync helpers compare session tokens only against the
  matching account source; reserved `claude-env-oauth` skips file token sync.
- Settings now has provider-account CRUD endpoints under
  `/api/provider-accounts` and renders account rows in each agent tab. Users can
  rename account rows, make a row primary, add an unauthenticated placeholder
  row, and disconnect rows that are not pinned to existing sessions.
- Scoped login is wired: the Claude and Codex auth managers are now
  account-scoped (`start({ accountId, credentialDir })`, plus
  `checkCredentials`/`signOut`/`getAccessToken` credential-dir overrides and a
  `getActiveAccountId()` accessor). A scoped flow spawns the provider CLI with
  `HOME` pointed at the account credential root
  (`provider-accounts/<provider>/acct_<id>`), whose layout already mirrors
  `$HOME` (`<root>/.claude` + `<root>/.claude.json`, `<root>/.codex`), so no
  symlinks are needed — the "per-flow temporary HOME" option from the auth-
  managers section collapses to "set HOME to the account root." Account-scoped
  credential checks are file-only (env-var auth belongs to reserved routes, so
  it cannot make a half-finished scoped login look complete). The singleton
  flow (no `accountId`/`credentialDir`) is unchanged.
- `ProviderAccountManager` gained `attachAuthManagers` + `startAccountAuth` /
  `cancelAccountAuth` / `submitAccountCode` / `signOutAccount` /
  `setAccountStatus`, and is wired to the auth-manager map in `index.ts` after
  `buildAgentRuntime`. New routes `POST /api/provider-accounts/:provider/
  :accountId/login` (+ `/login/cancel`, `/login/code`) drive the flow.
- The `agent_auth_pending` / `agent_auth_complete` / `agent_auth_failed` SSE
  events now carry an optional `accountId`, read synchronously from the active
  manager inside the `app-lifecycle` wiring. On scoped completion the row is
  marked `ready` and the fresh token is re-pushed only into sessions pinned to
  that account; on failure the row is marked `auth_failed`. Settings renders a
  per-row Connect / Cancel sign-in control; the pending URL/code surfaces
  through the existing per-agent sign-in card. Concurrency is serialized per
  provider for now (the managers remain single-flow); concurrent flows for
  different accounts are deferred.

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

- **Claude account identity:** investigate whether `auth.ts` exposes a
  Claude-side equivalent of the Codex `chatgpt_account_id` claim, and whether
  the Claude OAuth profile endpoint already returns a stable user id. If
  neither does, fall back to OAuth-flow-time `email` plus a stored
  `account_label` for de-duplication.
- ~~Codex account identity~~: **closed.** `src/server/orchestrator/codex-auth.ts`
  already decodes the `https://api.openai.com/auth` claim out of the
  ChatGPT-issued JWT and exposes `chatgpt_account_id` and `chatgpt_plan_type`
  inline (see `OPENAI_AUTH_CLAIM` and `extractCodexPlan`). The Codex account
  identifier the duplicate-row check needs is therefore already available
  from existing credentials with no extra endpoint.
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
  Covered by `Settings.test.tsx`; endpoint coverage lives in
  `http-mutations.test.ts`.
- Client: subscription limits render multiple accounts per provider without
  layout overlap.
