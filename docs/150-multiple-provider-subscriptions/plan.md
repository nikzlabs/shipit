---
description: Allow multiple subscription accounts for the same agent provider and automatically fail over when the active subscription is exhausted.
issue: https://linear.app/shipit-ai/issue/SHI-56
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
2. User orders those accounts by preference and chooses the short-window and
   weekly usage cutoffs at which ShipIt should move to the next account.
3. ShipIt shows each account's quota state inline.
4. Before every turn, including turns in existing sessions, ShipIt chooses the
   first eligible account in that order whose configured quota cutoffs have not
   been reached.
5. If the current account hits a hard limit during a turn, ShipIt retries on the
   next eligible account when the operation is safe to retry.
6. Sessions record which provider account was used so credential isolation and
   auditability stay intact.

## Requirement provenance

The human-stated requirements for this feature live in
[`requirements.md`](./requirements.md) and are the source of truth; this doc is
design. Open questions in that file block implementation until the user answers
them (see `/shipit-docs/spec-discipline.md`).

The original requirement was automatic failover among multiple authenticated
subscriptions. A follow-up user requirement made the policy explicit:

- accounts form a user-controlled prioritized list per provider;
- both the short subscription window (currently five hours for Claude) and the
  weekly window have user-configurable usage cutoffs;
- both cutoffs default to 90%, and reaching either cutoff advances to the next
  eligible account in priority order; and
- this applies to existing sessions, not only newly created sessions. Switching
  preserves the ShipIt transcript and workspace context, so quota pressure does
  not force the user to abandon a conversation and start a new session.
- Claude and Codex each expose one subscription-authentication surface: the
  provider-account list. The migrated primary/default subscription is an
  ordinary account row and uses the same connect/reconnect flow as every
  secondary row. Provider API keys remain a clearly separate fallback, not a
  second way to populate a subscription row.

Hard provider exhaustion remains an immediate failover signal regardless of the
configured proactive cutoffs. The controls are subscription-routing policy, not
generic API-key billing failover.

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
  route, quota polling, hard exhaustion detection, and same-route reset-time
  display behave like a Claude subscription account.

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
- Automatically select an account for every turn from the user's ordered
  provider-account list, advancing when either configured quota cutoff is met.
- Re-route already-pinned sessions while preserving local transcript and
  workspace context; account pinning is audit state, not a reason to strand an
  existing conversation on an exhausted subscription.
- Automatically fail over after a hard quota/auth exhaustion signal, retrying the
  turn once on the next eligible account.
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
- **Docs 119 and 202's standalone `ClaudeAuthCard` / `CodexAuthCard`
  subscription controls are superseded.** Those cards established first-class
  subscription login in Settings before provider-account rows existed. Once
  account migration is available, both the default and additional Claude/Codex
  subscriptions authenticate through the same account-row UI. Their API-key
  disclosures survive as a separate fallback section; they do not remain mixed
  into a provider-wide subscription card.
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
- Guaranteeing that a retried turn does not repeat work. Req 14 chooses
  uninterrupted failover over side-effect protection; a retry may redo file
  edits or commands the first attempt already performed.
- Holding an exhausted prompt until quota resets. Req 13 fails the turn instead.

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
6. **Keep `agentSessionId` and the conversation-state subpaths.** Resume is
   backed by a per-session local file, not by the deleted account (see
   "Existing pinned sessions"), so disconnecting an account does not end the
   conversation. Step 5's purge targets credential files by stable account
   identity; it must not touch `projects/`, `sessions/`,
   `archived_sessions/`, or `history.jsonl`.

Then split by whether the user already picked a replacement:

7a. **Replacement chosen.** Update `provider_route_kind` / `provider_route_id`
    to the replacement account or reserved route. The next turn provisions the
    replacement credentials and resumes the same conversation.
7b. **No replacement.** Mark sessions as needing account selection/re-auth
    before the next turn. The recovery path runs at next-turn time: it
    re-provisions the user-selected account and resumes.

This prevents a deleted source account from continuing to run through a stale
per-session credential copy.

### Session startup

For every turn, the router chooses a provider account before credential
provisioning:

1. Filter to accounts that are eligible for the selected model, permission mode,
   and requested provider features.
2. Read the provider's persisted user-defined account order — `ProviderAccount.
   priority` ascending (see Data model). The primary account is the first entry
   (`priority === 0`); newly connected accounts append to the end until the user
   reorders them.
3. Treat an account as **quota-low** when either known short-window usage meets
   the configured short-window cutoff or known weekly usage meets the configured
   weekly cutoff. Both cutoffs default to 90% and are configurable per provider
   in Settings. Validate each as an integer percentage from 1 through 100.
4. Walk the ordered list and choose the first eligible account that is neither
   quota-low nor known exhausted. A session's currently pinned account remains
   in use only when it is still the highest-priority qualifying account; this
   preflight runs before every turn, including existing-session, queued, and
   system-initiated turns.
5. Skip accounts known to be exhausted until their reset time. For Claude
   accounts that expose `weeklyOpus` / `weeklySonnet` sub-windows
   (`usage-limits-types.ts`),
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
   If an earlier account is quota-low and a later eligible account is not,
   choose the later account. User priority, not maximum remaining quota, decides
   between multiple healthy accounts.
6. If every eligible account is quota-low, keep the least-used eligible account
   rather than cycling indefinitely; prefer the earliest account in user order
   when usage is tied. A known-hard-exhausted account is never selected by this
   fallback.
7. When preflight changes an existing session's account, stop its persistent
   provider process, provision the replacement credentials (preserving the
   conversation-state subpaths), and persist the new route for audit. The
   restarted process resumes the same conversation from `agentSessionId`; no
   context rebuild is needed (req 9, see "Existing pinned sessions").
8. If all eligible accounts are exhausted, fail the turn immediately with a
   chat-visible system message naming the earliest reset time, and do not start
   the agent (req 13). ShipIt does not hold the prompt for later; the user
   resends when they choose to.

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
  failover** when the current turn requires that capability; ShipIt reports
  `no_model_eligible_account` / `capability_unknown` instead. Per req 17 it
  never substitutes a model the account does support — a skipped account
  produces a report, not a quiet downgrade.
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

**Exhaustion is a turn failure, not a deferral (req 13).** The preflight that
detects `all_exhausted` ends the turn in an error state with a chat-visible
system message naming the earliest reset time and the accounts it covers. There
is no delayed-turn record, no orchestrator wake-up timer, no attachment
staging step, and no restart-time re-arming. This keeps the exhausted path on
the same failure machinery every other preflight rejection uses.

Two orderings still matter:

- The preflight must decide "can any account run this turn?" **before** the
  first-turn side effects — `provisionAgentCredentials`, `setAgentId` /
  `setAgentPinned`, `syncAgentTokenIn`, `tryPushAgentSecrets`. Failing after
  them would pin the session to an account no turn ever used and leave a
  provisioned credential subtree behind.
- `drainNextQueuedMessage` calls `runAgentWithMessage` recursively without going
  through `handleSendMessage`, so a dequeued message hits the same preflight and
  fails the same way. Each queued message therefore produces its own exhaustion
  error rather than draining silently; the queue empties as today. If that
  proves noisy in practice, collapse repeated identical exhaustion messages
  within one window at the message level — not by reintroducing deferral state.

### Mid-turn failover

#### Landed: the retry is the auth-retry mechanism, re-aimed

Req 14's same-turn retry needed no new machinery. docs/179 already built
exactly this shape in `turn-executor.ts` for the runtime-401 case — stand the
`done` handler down, kill the process, re-enter `executeAgentTurn` on a fresh
agent with `emitUserEcho: false` and a shared `persistGuard`, bounded to one
attempt by a flag on the input. The quota retry is the same five pieces with a
different trigger, so it reuses them rather than growing a parallel path:

- **Trigger.** `agent_result` carrying an error that `detectHardExhaustion`
  classifies, checked *before* any post-turn work. Draining the queue or
  broadcasting "finished" there would announce the end of a turn that is about
  to be re-run.
- **It does not choose the account.** By the time it fires, the listener has
  already benched the spent account (req 7), so the retry's own env-prep does
  the switching: `failoverPinnedSession` sees the pinned account is no longer
  usable, moves the session, preserves the conversation (req 9), and posts the
  req-11 notice. The no-account-left case comes free — env-prep throws and the
  retry surfaces req 13's "every account is out of quota, earliest reset at X",
  which is a better message than the raw provider error the first attempt died
  of.
- **`persistGuard` gives "no duplicated user history" for free**: the same latch
  docs/179 threads through the auth retry, threaded through this one.
- **Side effects are kept, not rolled back.** Req 14 is explicit that the retry
  happens "regardless of what that turn has already done." The failed attempt's
  partial output has already been *finalized* into history by the listener's
  `agent_result` path, so the retry's fresh in-progress turn appends below it
  rather than colliding with it. The transcript reads: partial attempt →
  "X is out of quota — continuing on Y" → the real answer. Nothing about the
  edits that already happened is hidden.
- **Bounded to one.** `isQuotaRetry` stops a second hop, so an account-exhausted
  fleet fails the turn normally instead of marching down every account one
  process at a time.

One deliberate non-change: the first attempt's provider error still reaches the
transcript. It is true, the req-11 notice immediately after explains the
recovery, and suppressing a real provider error to tidy the transcript is the
kind of thing that costs a debugging session later.

When a hard exhaustion signal arrives partway through a turn, ShipIt switches to
the next eligible provider account and retries once, regardless of what the turn
has already done (req 14). There is no side-effect gate, no per-turn side-effect
tracking, and no read-only tool allowlist: a retried turn may repeat work the
first attempt already performed, and the user accepted that tradeoff in exchange
for uninterrupted failover.

If no eligible account remains, the turn fails as in the exhaustion path above.

The retry is a same-turn retry, not a new user message. The implementation must
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

**Conversation continuity survives an account switch on its own — verified,
not assumed.** An earlier draft of this doc asserted that "account B cannot
resume account A's Claude session or Codex thread" and built a replay package
around that assertion. The assertion is wrong. Both providers resume from a file
in the session's own credential subtree, and neither file carries account
identity:

- Claude: `--resume <agentSessionId>` (`agents/claude/process.ts:197`) reads
  `.claude/projects/<encoded-cwd>/<agentSessionId>.jsonl`.
- Codex: `thread/resume` (`agents/codex/codex-event-handler.ts:682`) reads
  `.codex/sessions/<Y>/<M>/<D>/rollout-*-<threadId>.jsonl`; losing that file is
  what produces `-32600 no rollout found for thread id …`.

`~/.claude` and `~/.codex` are symlinks into the per-session credentials dir
(`session-credentials-scaffold.ts` → `AGENT_CREDENTIAL_PATHS`), which is
per-session and account-agnostic. So switching accounts does not invalidate
resume. What *would* invalidate it is this doc's own reprovisioning step
deleting those files — the same data-loss shape docs/153 already hit, which is
why `token-sync-manager.ts` keeps a conversation-state allowlist
(`CLAUDE_SESSION_STATE_SUBPATHS` / `CODEX_SESSION_STATE_SUBPATHS`:
`projects`, `sessions`, `archived_sessions`, `history.jsonl`).

That satisfies req 9 with no new machinery: keep `agentSessionId`, preserve the
conversation-state subpaths across reprovisioning, and let the CLI resume.

What genuinely is account-bound is the running process and the credential files.
So an account switch for an already-pinned session is:

1. Stop the persistent agent process, if one exists, before switching accounts.
   Reusing the old process would keep sending requests with account A (live
   steering reuses a worker-side process via
   `existingAgent.sendUserMessage(...)` rather than calling `/agent/start`).
2. **Keep the stored `agentSessionId`.** Provider-side resume is not reset by an
   account change, per the verification above. If a future provider is found to
   bind conversations to an account, clear it for *that* provider only and fall
   back to `buildConversationReplay` (`services/replay.ts`), which already exists
   for the rollback path — no bespoke replay package is needed.
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

   **The rm half must exempt the conversation-state subpaths** listed above.
   Removing `.claude/projects` or `.codex/sessions` would delete the very
   transcript the next `--resume` / `thread/resume` reads, converting an
   account switch into silent conversation loss — req 9's failure mode. Reuse
   `SUBTREE_STATE_SUBPATHS` from `token-sync-manager.ts` rather than
   re-deriving the list, so a future CLI layout change is fixed in one place.
   Its "a subtree absent from the map is unpreservable, so fail rather than
   delete" default applies here too.
5. Record a chat-visible system event that the session moved from account A to
   account B (req 11). The conversation itself continues uninterrupted, so the
   event is attribution, not a warning about lost context.

Automatic account switching is therefore allowed only at a turn boundary or in
the mid-turn retry path. If a persistent process is alive, the router first
terminates it and restarts, resuming the same conversation under the new
account. Token sync-in alone is never sufficient for account switching.

## Data model

Add a provider-account registry to `CredentialStore`:

```ts
interface ProviderAccount {
  id: string;
  provider: AgentId; // "claude" | "codex"
  label: string;
  /**
   * Position in this provider's user-controlled priority list (req 2).
   * Ascending: the lowest `priority` is tried first. Dense and contiguous
   * within a provider — reordering rewrites the affected rows rather than
   * inserting fractional values, so "first entry" is unambiguous and the
   * order survives a round-trip through the store.
   *
   * A newly connected account appends to the END (highest priority value),
   * never displacing the account the user already relies on. On disconnect,
   * the remaining rows are re-densified so no gap survives.
   */
  priority: number;
  /**
   * Derived, not independent: the primary IS the head of the order
   * (`priority === 0`). Kept as a stored field only because Phase 1 already
   * ships it and the Settings UI reads it; "make primary" is implemented as
   * "move to position 0" and must not be allowed to disagree with `priority`.
   * A later cleanup may drop the field and compute it — do not add a second
   * writer in the meantime.
   */
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
   * 100%. Used to render reset hints and to name the earliest reset in the
   * exhaustion error; NOT an exhausted/ready boolean. Whether a given turn is blocked
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

**Selector naming.** This doc calls the per-turn selector
`ProviderAccountManager.selectAccountForTurn(...)`. The shipped Phase 1 method
is `selectRouteForTurn(provider): ProviderRoute | null` — it walks the stored
accounts (primary first, then the rest) and falls back to the reserved
env/API-key routes, but it returns `null` for every unusable state, conflating
"no auth at all" with "authenticated but nothing can run this turn".
`selectAccountForTurn` is the target: same walk, plus the requested model /
capability filter and a **structured** failure result
(`all_exhausted` | `auth_required` | `no_model_eligible_account` |
`capability_unknown`). That result type is not cosmetic — req 13 (fail the turn
with the earliest reset time) and req 17 (skip an ineligible account and report)
cannot be expressed by a `null`. Phase 2 should widen `selectRouteForTurn` into
it rather than adding a second selector; callers that only need coarse
availability keep using `hasAnyAuthForProvider`.

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
- preserving conversation state across an account switch,
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

| Route id | Provisioning | Env/config pushed to the runner | Token sync | Quota/exhaustion behavior |
| --- | --- | --- | --- | --- |
| `codex-api-key` | Skip provider-account credential copy. Preserve any existing subscription `.codex` files instead of deleting them. | Set `OPENAI_API_KEY` for the Codex run and ensure adapter config prefers the API-key path over subscription files for this attempt. | No-op; API keys do not rotate through the Codex subscription token store. | No subscription quota. It is not ranked with subscription accounts and is not used for subscription failover. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-api-key` | Skip provider-account credential copy. Preserve any existing subscription `.claude` files instead of deleting them. | Set `ANTHROPIC_API_KEY` for the Claude run and ensure adapter config prefers the API-key path over OAuth files for this attempt. | No-op; API keys do not rotate through the Claude OAuth token store. | No subscription quota. It is not ranked with subscription accounts and is not used for subscription failover. Runtime API 429s surface as API-key rate/billing errors for that route. |
| `claude-env-oauth` | Skip provider-account credential copy because the source of truth is the orchestrator/session env, not `/credentials/provider-accounts/...`. Per the selection rule above, this route is only ever chosen when no stored Claude account row exists, so there is no `provider-accounts/claude/acct_<id>/` subtree to preserve. Any `.credentials.json` the CLI writes during this env-OAuth turn stays local to the per-session credential subtree; it is never copied back to `provider-accounts/...`, and if the user later adds a stored Claude account the next preflight switches off env-OAuth and the per-session file is purged on the normal account-switch path. | Set `ANTHROPIC_AUTH_TOKEN` and do not set `ANTHROPIC_API_KEY`. Claude must treat the bearer as the selected OAuth source, matching doc 135's env-token path. | Both `syncAgentTokenIn` and `syncAgentTokenBack` are explicitly **disabled** for this route at the helper-invocation site. `AGENT_TOKEN_FILES[claude]` is a static map in `session-credentials.ts` and is not mutated per-route; the gate belongs in the preflight code that decides whether to call the helpers at all. Without that gate, the generic file-list pathway would still pull a token file into and out of the env-OAuth session. If the provider returns a refreshed token file during the run, it must not be copied into a stored provider-account row. | Subscription-style quota applies. The limits badge remains visible, hard exhaustion fails the turn with a reset time, and reset-time handling matches Claude OAuth accounts. It is not ranked against stored provider-account rows for multi-account spreading because it has no account row; it is used when explicitly selected, pinned from migration/local auth, or when no stored Claude account exists and env OAuth is the available Claude auth. |

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
  is the first place we *create* it. Per req 18 it runs the normal account
  router rather than inheriting the parent's route, and must persist the
  routing before `setAgentPinned` fires.
- `src/server/orchestrator/services/recovery.ts` — both recovery paths that
  call `deps.runnerRegistry.getOrCreate(...)` during the `creating_container`
  phase. **Hydration.**
- `src/server/orchestrator/index.ts` — the test/dev runner-state endpoint
  that calls `runnerRegistry.getOrCreate(..., defaultAgentId)`. **Hydration**
  for consistency, even though this is a non-production path.

The shared preflight then validates that the hydrated account/route is still
usable before the turn starts.

#### Landed: the preflight is `prepareSessionAgentEnvironment`, not a new helper

The design above asked for a new `prepareProviderAccountTurn(...)` that every
turn entrypoint would be made to call. Building it turned out to be
unnecessary: `prepareSessionAgentEnvironment` (docs/149) is *already* that
chokepoint, and already does five of the eight things the helper was specified
to do (resolve/pin the route, provision account-qualified credentials, sync the
token in, record state for sync-back, decide reuse). Every entrypoint the
section lists reaches it — the WS path and the dispatched/system-turn path both
through `SystemTurnDeps.prepareAgentEnv`, plus service-level warm-up calls from
child spawn, child send, headless create, CI fix, and session wake. Adding a
second preflight beside it would have meant two places that pin a route.

So the preflight is that function, extended with the routing decision:

- Route resolution moved from `selectRouteForTurn` (route-or-null) to
  `selectAccountForTurn` (route-or-reason), with the session's `model` passed
  through so req 17's skip-and-report can fire.
- `provider-route-preflight.ts` decides what a `{ ok: false }` means:
  `all_exhausted` and `no_model_eligible_account` throw
  `ProviderRouteUnavailableError`; `auth_required` does not. Not-signed-in
  already has a guided surface (`authConfigured`, the Settings account rows),
  and converting it into a thrown turn error would replace that flow with a
  dead end — so it keeps today's fall-through.
- The throw is gated on an explicit `enforceAccountRouting` flag, set by
  exactly the two callers that are a turn's own pre-spawn step
  (`ws-handlers/agent-execution.ts` for the WS path,
  `runner-registry-factory.ts` for the dispatched path — the latter also
  gained `providerAccountManager`, which it had never been given). The
  service-level warm-up calls keep their fail-open contract: they run *before*
  the turn exists, so throwing there would abort a session **creation**,
  stranding a session in the sidebar that nobody asked for. They simply pin
  nothing, and the executor's preflight moments later is what stops the turn.
- The block surfaces through the existing agent-`error` path, which already
  persists a terminal error row into the transcript, clears turn state, marks
  `lastTurnErrored`, and drains the queue. `agent-listeners.ts` special-cases
  `ProviderRouteUnavailableError` so the user is not told their agent crashed:
  nothing crashed, and the message already says when quota returns and that
  the resend is theirs to make (req 13 — ShipIt does not hold the prompt).

Because the check runs before Step 1, a blocked turn leaves **no** pinning and
**no** provisioned credential subtree — the next turn re-decides rather than
inheriting a route the router never chose.

**Not yet covered.** A session that is *already pinned* skips selection
entirely, so this fails fast only for the first turn of a session. Re-checking
a pinned session's account — and moving it when its own quota is gone — is the
failover work in Phase 3/4 (reqs 3, 7, 8), not something this preflight does
today.

### Quota and exhaustion detection

#### Landed: the two exhaustion signals, and why the persisted one is needed

`exhaustedUntil(limits, account, now)` in `provider-account-manager.ts` takes
the **soonest** of two independent signals, and both are now written:

1. **Live telemetry.** Both CLIs already push quota windows on the agent stream
   (Claude's `rate_limit_event`, Codex's `account/rateLimits/updated`), which
   `recordAgentRateLimits` attributes to the reporting turn's route. A window at
   `usedPct >= 100` with a future reset benches the account for free.
2. **A persisted `exhaustedUntil` stamp** (req 7), written when the provider
   *fails a turn* saying the subscription is spent.

The second exists because the first is telemetry, and telemetry is not a
promise. It can lag the failure, Claude reports `usedPct: null` below a warning
threshold, and a freshly connected account has no snapshot at all — so a turn
can be refused for quota while the snapshot still says the account is fine.
Without the stamp the router would keep choosing the account that just refused
the work. The field was already read by the selector from the start of Phase 2;
nothing wrote it until now.

`detectHardExhaustion` (`ws-handlers/agent-rate-limits.ts`) classifies the
`agent_result` error, and it is **deliberately narrow**: explicit quota language
only, never a bare `429` or "rate limit", which upstream also uses for
short-term throttling that a retry fixes. A false positive benches a working
subscription, so the negative cases are as load-bearing as the positive ones and
are tested as such.

When the provider names a reset instant, that becomes the lockout. When it does
not, `UNKNOWN_RESET_LOCKOUT_MS` (15 minutes) does. Neither extreme was
acceptable: no stamp means the next turn walks into the same wall, which is the
failure this detection exists to prevent; an indefinite stamp would strand a
healthy subscription on one bad parse. A short self-expiring lockout gets the
next turn onto another account while making a mistake cost minutes, and real
telemetry supersedes it as soon as it lands because `exhaustedUntil` takes the
soonest of the two. The stamp only ever moves *later*, so a second, vaguer
failure cannot shorten a lockout whose true end the provider already gave.

Resolution from "session X's turn died of quota" to "bench account Y" lives in
`bootstrap-managers.ts` next to `recordAgentRateLimits`, for the same reason:
that is the one place that knows how a session maps to a route. Only a pinned
**account** route is stamped — an unpinned session has no account to blame, and
a reserved env/API-key route is metered billing with no subscription window
(req 12).

**What this delivers, and what it does not.** Combined with the pre-turn
failover, a turn killed for quota now benches its account, and the session's
*next* turn moves to another one. The turn that hit the wall is still lost —
retrying it in place is req 14, and lands next.

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
subscription-limits pill, quota polling, and hard-exhaustion detection. It is
excluded only from multi-account spreading/ranking among
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
100%, used to name the earliest reset when a turn fails. Whether the account is
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
- **One connect flow, not two (req 16).** Connecting the first account for a
  provider and connecting the Nth use the same UI. Today they diverge: the
  first account goes through the provider-wide sign-in control while
  additional accounts go through the per-row account-scoped control added in
  Phase 1. Collapse them — the provider-wide control becomes the account-row
  control operating on the first (or a newly appended) row, so there is one
  code path and one thing for the user to learn.
- Header subscription-limits badge stays the existing pill (req 10) — same
  visual language, one per connected account, each labelled with that
  account's name. This is the doc-135 amendment described in "Relationship to
  prior docs": the pill is still account-wide and never focus-driven, but a
  provider with N accounts now shows N labelled pills (or a roll-up that
  expands into them) rather than collapsing to a single number. The label is
  the user's account name from Settings, which is what makes two pills for
  the same provider tellable apart. The grouped layout MUST keep the header
  non-shifting for the common 1-account case so existing users see no UI
  change after migration.
- Session diagnostics shows the active provider account for the current session.
- Chat system messages report failover decisions:
  - `Claude: Primary exhausted until 14:30; retrying with Work account.`
  - `Claude: all accounts exhausted. Earliest reset 14:30 (Primary). Send again after that.`

Do not open provider dashboards for normal quota/status inspection. Billing and
account-management links live in overflow menus.

## Retry safety model

There is no side-effect gate (req 14). A hard exhaustion signal retries the turn
on the next eligible account whatever the turn has already done, so ShipIt does
not track `turnHadSideEffects`, does not maintain a read-only tool allowlist, and
does not ask the user for intent mid-turn.

What the retry does still owe the user is legibility: the failover is recorded as
a system event on the same turn (see "Mid-turn failover"), so a repeated file
edit or command is attributable rather than mysterious. Retry is capped at one
switch per turn, which bounds duplicated work to a single repeat.

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
5. **Backfill `priority` on existing rows.** Phase 1 shipped
   `ProviderAccount` without it, so rows already in `CredentialStore` have no
   order. Backfill on load: the row flagged `isPrimary` takes `priority: 0`,
   the rest take their existing stored order starting at 1. Because
   `isPrimary` is already single-valued (`upsertProviderAccount` demotes the
   others, and both it and `deleteProviderAccount` re-promote `accounts[0]`
   when none is flagged), the backfill is deterministic and needs no user
   input. Write the backfilled values back once so later reads are not
   order-sensitive. This is a JSON-store migration, not a SQLite one — the
   provider-account registry lives in `CredentialStore`, while the session's
   `provider_route_kind` / `provider_route_id` columns are the SQLite half and
   are unaffected.

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
  recovery path must kill any persistent process, provision the chosen
  account, and restart. `agentSessionId` is cleared only when the
  conversation-state file backing it is genuinely gone, in which case
  `buildConversationReplay` re-seeds from ShipIt's transcript as it does on
  the docs/153 repair path.

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
  error paths in the rebase driver must trigger the same
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
- `src/client/components/Settings/ProviderAccountsCard.tsx` — unified Claude
  and Codex subscription-account authentication and management UI.
- `src/client/components/ClaudeAuthCard.tsx` /
  `src/client/components/CodexAuthCard.tsx` — legacy provider-wide subscription
  surfaces to remove after onboarding and API-key fallback are separated.
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
- Consolidate legacy provider-wide subscription cards into the account rows for
  both Claude and Codex; keep API-key fallback visually and semantically separate.

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
- **Re-auth wipes the scope's credential files at flow start.**
  `startOAuthFlow` calls `removeCredentialFiles(configDir)` (the same removal
  loop `signOut` uses) before spawning `claude /login`. `claude /login` only
  runs the full OAuth code-paste flow from a clean slate; an expired
  `.credentials.json` left on disk makes it short-circuit (treats the account
  as already logged in) and never write a fresh token, so the login silently
  no-ops. This was the "must Clear saved credentials before re-authenticating"
  bug — the wipe now does that automatically. It complements the #1406
  baseline-mtime gate (which prevents a *premature* success on a stale file);
  the wipe is what makes a fresh login actually start, and leaves the baseline
  at 0 so any write the flow produces counts as fresh. Regression test:
  `auth-manager.test.ts` → "wipes a stale/expired credential file before
  spawning the login CLI".
- **Re-auth also strips env-var auth from the login subprocess.** The on-disk
  wipe above is necessary but *not sufficient*: `claude /login` honors
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` over the interactive OAuth flow,
  so when either is set in the orchestrator's environment (dogfood secrets, a
  stale exported key) the CLI treats itself as already authenticated and never
  emits the code-paste URL — the UI hangs on "Starting…" regardless of disk
  state. This is why the *only* thing that recovered the flow was "Clear saved
  credentials" (`DELETE /api/auth/api-key` → `clearApiKey()` deletes
  `process.env.ANTHROPIC_API_KEY`), not the on-disk wipe. `startOAuthFlow` now
  builds the child env as `{ ...process.env, HOME }` with `ANTHROPIC_API_KEY`
  and `ANTHROPIC_AUTH_TOKEN` deleted, sanitizing only the login subprocess (the
  orchestrator's own `process.env` is left intact, so env-var auth keeps working
  for agent turns / dogfooding). Regression test: `auth-manager.test.ts` →
  "strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the login subprocess
  env".
- **Selection walks every stored account, not just the primary.**
  `selectRouteForTurn` originally consulted `getPrimary()` alone, so a user
  with two connected subscriptions lost the healthy one the moment the primary
  went `auth_failed`: selection returned `null` while `hasAnyAuthForProvider`
  still reported `true`, and with `ANTHROPIC_API_KEY` in the environment the
  turn silently routed onto metered Platform API billing instead of the
  working subscription (violating reqs 3 and 12). It now iterates
  primary-then-stored-order and only falls through to the reserved routes when
  no stored account is usable. Regression tests:
  `provider-account-manager.test.ts` → "falls back to a healthy secondary
  account when the primary's auth failed" / "prefers a healthy secondary
  account over the API-key fallback".
- **Reprovisioning preserves conversation state.**
  `provisionAgentCredentialsFromRoot`'s replace path used to `rmSync` the whole
  `.claude` / `.codex` subtree, which includes `projects/`, `sessions/`,
  `archived_sessions/`, and `history.jsonl` — the files `--resume` and
  `thread/resume` read. Harmless while provisioning was first-turn-only, but it
  is the exact primitive the account-switch transition calls, so it would have
  turned every switch into silent conversation loss (req 9). It now removes
  only the non-allowlisted entries, reusing `SUBTREE_STATE_SUBPATHS` (exported
  from `token-sync-manager.ts`) so there is one definition of "this is
  conversation state" — and keeps that map's fail-safe default: an unknown
  subtree is not deleted at all. Regression tests:
  `session-credentials.test.ts` → "reprovisioning from another account
  preserves conversation state but replaces credentials" (+ the Codex rollout
  variant).
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
  inline on the owning account row. The client retains the event's `accountId`
  and submits Claude authorization codes through the account-scoped endpoint,
  so a provider-wide authenticated primary cannot hide a secondary account's
  active flow. Concurrency is serialized per
  provider for now (the managers remain single-flow); concurrent flows for
  different accounts are deferred.
- **The two connect flows are now one (req 16).** Settings no longer stacks a
  provider-wide `ClaudeAuthCard` / `CodexAuthCard` on top of the account rows.
  `ProviderAccountsCard` (replacing `ProviderAccountSection`) is the single
  connect surface for both providers: "Add account" creates the row *and*
  starts its account-scoped login in one action, so the first subscription
  takes exactly the path the fifth does. Three things fell out of the
  consolidation:
  - **Codex account sign-ins reached no row at all.** `agent_auth_pending`
    carried `accountId`, but the client's codex branch dropped it and always
    wrote the provider-wide `codexDeviceAuth` slot — so a second Codex
    account's device code rendered in the singleton card, which the Codex tab
    is no longer even showing. The branch now keys by account like Claude's.
  - **One challenge slot, two variants.** The row shell is shared; only the
    challenge panel differs, because the providers genuinely differ (Anthropic
    returns a code the user pastes into ShipIt, OpenAI shows a code the user
    types on OpenAI's page). Both render on the row that started them.
  - **Sign-in state is keyed per account.** `providerAccountAuth` was a single
    slot — correct only while one account could connect at a time. With every
    account connecting through a row, two rows can be mid-challenge at once,
    and a single slot shows B's code on A's row. It is now
    `providerAccountAuths` / `providerAccountAuthErrors` keyed by
    `providerAccountAuthKey(provider, accountId)`.

  API keys stay deliberately outside the account list: they are not
  subscriptions, never participate in failover (req 12), and now live in a
  collapsed disclosure with explicit metered-billing copy. `ClaudeAuthCard` /
  `CodexAuthCard` survive only as first-run onboarding, which is the remaining
  consolidation step. Tests: `Settings.test.tsx` → "creates the account and
  immediately starts its sign-in, first account included", "renders a Codex
  device code on the row that started the sign-in", "keeps two concurrent row
  sign-ins independent".

- **The account-switch transition exists (req 9).**
  `services/provider-account-switch.ts` → `switchSessionProviderAccount` moves a
  pinned session between accounts of the same provider: kill the live agent,
  reprovision from the incoming account's root (preserving the
  conversation-state allowlist), persist the new route, and leave
  `agentSessionId` untouched so the next turn resumes the same conversation.
  The kill is not optional — both CLIs read credentials once at process start,
  so a running agent keeps spending the outgoing account's token no matter what
  is written to disk. It refuses rather than guesses on the unsafe cases:
  unknown session, cross-provider target, unusable account, or a turn in
  flight. A caller that must preempt a running turn (mid-turn exhaustion,
  req 14) stops the turn first — that ordering belongs to the caller.
- **Disconnect now offers a destination instead of a dead end.**
  `deleteProviderAccount` used to refuse outright whenever any session was
  pinned ("until account switching is available"). It now takes an optional
  `replacementAccountId`: without one it 409s *naming the usable alternatives*,
  with one it switches every pinned session across and then deletes. A
  *running* pinned session is still refused unconditionally. The client turns
  that 409 into a row-local picker rather than a toast, so the refusal is
  answerable where it appears. This is also the first production caller of the
  switch — the transition is exercised today, not merely staged for Phase 3.
- **Child sessions route independently (req 18), verified rather than assumed.**
  A spawned child reaches `prepareSessionAgentEnvironment` with no persisted
  route, so it asks `selectRouteForTurn` and gets the user's normal priority
  order; `providerRouteKind`/`providerRouteId` are only ever written from a
  router decision and never copied from a parent at spawn. Follow-up turns
  (including detached/system turns that recreate a runner) reuse the persisted
  route instead of re-selecting, so a conversation cannot drift onto a
  different account mid-flight. Both directions are pinned by tests in
  `session-agent-env.test.ts`.

**Phase 2 entry note — where the account keying has to live.** Surveying the
existing quota path before starting: `LimitsRegistry` caches
`Map<AgentId, SubscriptionLimits>` and each `LimitsProvider` (one per agent)
holds a **single** merged snapshot internally — Claude's merges the CLI's
`rate_limit_event` windows with its on-demand `/api/oauth/usage` result and
derives `plan` from `authManager.getAccessToken()`; Codex's holds one `latest`
and reads `plan` from the auth token's JWT claim. So the map key is not the only
single-slot assumption: **the providers are single-slot too.** Re-keying only
the registry would give each route its own cached copy of the *broadcast* while
both routes still shared one provider merge buffer — correct for the
last-reporting route, quietly wrong for the others (and outright wrong for
Claude's on-demand refresh, which would attribute the primary account's token
result to whichever route asked). The keying therefore has to go into
`LimitsProvider` — per-route internal state, `setRateLimits`/`fetch` taking the
route — with the registry keying on top, and `recordAgentRateLimits` resolving
the route from the reporting session's `providerRouteId` at the call site.
`claude-env-oauth` and `claude-api-key` stay reserved route ids in the same key
space, which is what keeps the env-auth pill working with no accounts stored.

**Phase 2 landed — quota is per account end to end.** Built exactly where the
entry note said it had to go:

- `LimitsProvider` is per route. Claude's `eventLatest` / `apiLatest` /
  `lockedUntil` / in-flight guard are all `Map<routeId, …>`, and Codex's
  `latest` likewise; `canFetch(): boolean` became `routeIds(): string[]`
  (a single flag could only ever describe one subscription), plus
  `forgetRoute(routeId)` for disconnects. The 429 lockout being per route
  matters: a 429 against one account's token says nothing about another's.
- `LimitsRegistry` caches `agentId → routeId → snapshot`, prunes routes the
  provider has forgotten so a stale pill can't outlive its account, and
  `markSignedOut(agentId, routeId?)` drops one account without blanking the
  other's pill.
- `recordAgentRateLimits(agentId, session, weekly, sessionId)` attributes each
  snapshot to the reporting session's pinned route. The resolution lives in
  `bootstrap-managers.ts` (one place that knows how a session maps to a route)
  rather than at each call site. **When no route resolves, the snapshot is
  dropped** — recording it under a guess would bill one subscription's usage to
  another, and a missing pill is honest where a wrong number is not.
- The header renders one pill per connected subscription, labelled with the
  account name (req 10), ordered by the user's account order with reserved
  routes last. With a single account the pill keeps the bare provider label, so
  the common one-subscription layout is unchanged.
- `normalizeAgentUsageLimitError` now reclassifies the upstream "monthly usage
  limit" only when **every** connected account for that provider is exhausted,
  and reports the soonest reset. Firing on the first exhausted account would
  have told a user with a healthy second subscription they were out of quota —
  precisely the situation this feature exists to avoid.

Still open in Phase 2: persisting snapshots onto accounts, Claude
model-specific windows (`weeklyOpus`/`weeklySonnet`), ranking unknown Codex
quota, the grouped/expanded multi-account layout, session diagnostics, and the
eligibility work (skip-exhausted, structured states, fail-fast on req 13) which
belongs with Phase 3.

**The account router is now quota-aware and gives reasons.**
`selectAccountForTurn(provider, { model, exclude })` is `selectRouteForTurn`
widened: the same eligibility walk, plus (a) skipping accounts whose quota is
spent, from either the live snapshot or a persisted `exhaustedUntil` stamp,
(b) an exclusion list so a mid-turn retry cannot land back on the account that
just ran out (req 14), (c) skipping accounts that cannot run the requested model
(req 17), and (d) a structured failure — `auth_required`, `all_exhausted` with
the soonest `earliestResetAt`, or `no_model_eligible_account` — because reqs 13
and 17 are specifically about telling the user *which* happened.
`selectRouteForTurn` survives as the thin wrapper for callers with nothing to do
with the reason.

Two rules that are load-bearing and were both caught by their own tests:

- **A spent subscription never rolls onto metered billing (req 12).** The first
  implementation checked the reserved env/API-key route before reporting
  exhaustion, which would have quietly spent the user's pay-as-you-go money the
  moment a subscription ran out. The reserved route is now reachable only when
  there is no usable subscription *at all* (the manual-auth case), never as the
  next hop after one is exhausted.
- **Unknown quota counts as usable.** Claude reports `usedPct` only above a
  warning threshold and Codex reports nothing until a turn has run, so treating
  unknown as exhausted would lock out every freshly connected account forever.
  Erring toward "try it" costs one failed turn; erring the other way is
  unrecoverable. Same reasoning for an account with no capability snapshot: it
  is assumed able to run the model until we learn otherwise.

`bootstrap-managers` late-binds the quota source
(`attachSubscriptionLimits(() => limitsRegistry.getSnapshot())`) because the
registry needs the agent runtime, which is built after the account manager.

Still open for Phase 3: detecting hard exhaustion from each provider's runtime
errors, performing the single retry on the next eligible account (req 14),
recording the switch as a chat-visible event (req 11), and surfacing the three
failure states on a blocked turn (req 13's message).

**Existing pinned sessions now run the same quota preflight.** Before every
enforced turn, the turn adapter asks whether the persisted account route is
still usable for the requested model and current quota snapshot. If not, it
stops any resident process that still holds the outgoing token before capturing
the incoming agent; `prepareSessionAgentEnvironment` then selects the next
eligible subscription account, reprovisions only the credential files while
preserving Claude/Codex conversation-state paths, and updates the persisted
route without clearing `agentSessionId`. The switch is
written into the ShipIt transcript with both user-facing account labels. When
no account can serve the turn, the existing structured route error fails it
before spawn and reports the earliest reset instead of falling through to an
API-key route. Streaming chat releases a stale resident process before the turn
executor captures it, so the executor never tries to steer a process that the
environment preflight just killed. Unit coverage exercises account switching,
conversation preservation, process termination, healthy secondary affinity,
reserved-route isolation, and the all-exhausted failure.

**Follow-up — turn admission is account-aware too.** The interactive WebSocket
and HTTP dispatch gates previously checked Claude's legacy singleton
`AuthManager` even though account creation and the model picker use
`ProviderAccountManager`. A newly connected Claude subscription could therefore
be visible and ready in Settings but every turn failed with “Claude is not
authenticated” before provider-account preflight ran. Both ingress paths now
refresh and read `AgentRegistry.authConfigured`, whose production callback is
backed by `ProviderAccountManager.hasAnyAuthForProvider`. One shared gate covers
Claude and Codex and recognizes stored subscription accounts as well as explicit
reserved auth routes. Regression coverage holds the obsolete singleton state at
false while the account-aware registry is true and verifies the turn dispatches.

Planned authentication-surface consolidation:

- **One row model for both providers.** `ProviderAccountsCard` owns every
  stored Claude and Codex subscription, including the migrated
  `claude-default` / `codex-default` account. Each row exposes the same lifecycle:
  Connect, in-progress state, Cancel sign-in, Reconnect, and Disconnect. Primary
  is metadata and routing priority; it does not select a different auth UI.
- **Provider-specific challenge, shared shell.** Claude rows expand inline with
  the `claude /login` verification link and authorization-code input. Codex rows
  expand in the same place with the `codex login --device-auth` verification
  link, user code, copy affordance, and expiry state. These are variants inside
  one account-row component, not separate provider-wide cards.
- **Account-scoped state throughout.** Pending challenge, progress, diagnostic
  log, failure, and completion state carry `{ agentId, accountId, attemptId }`
  and are stored by account id. A successful primary account must not hide a
  secondary flow, and activity on one row must not overwrite another row's last
  diagnostics. The existing one-active-flow-per-provider server serialization
  remains until concurrent auth processes are deliberately supported.
- **Onboarding reuses the same flow.** When no stored subscription exists,
  onboarding creates the provider's default account row and renders the same
  account-row auth component in a compact layout. It must not call singleton
  auth endpoints or maintain separate pending state.
- **API keys are separate routes.** Below the subscription list, Settings may
  expose a collapsed “Use Platform API key instead” section for
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Copy must state that this uses metered
  API billing rather than the Claude/ChatGPT subscription. Saving an API key
  creates or updates the reserved `claude-api-key` / `codex-api-key` route; it
  never marks a provider-account row ready and never participates in subscription
  priority or quota failover.
- **Remove singleton client/server paths after migration.** Migrate all callers
  from `/api/auth/start`, `/api/auth/code`, `/api/codex-auth/start`, and their
  singleton cancel/sign-out variants to the provider-account endpoints. Then
  remove provider-wide subscription pending state (`sessionStore.authUrl`,
  `codexDeviceAuth`) and the subscription portions of `ClaudeAuthCard` /
  `CodexAuthCard`. Keep auth-manager methods internally capable of scoped CLI
  execution; the UI/API boundary always supplies an account id. Compatibility
  aliases for legacy credential files remain storage implementation details and
  do not justify a second user-facing flow.
- **Provider-wide availability remains derived.** `AgentRegistry.authConfigured`
  is true when any eligible account row is ready or an explicit reserved route
  is configured. It controls agent availability only; it must never be used to
  hide per-account connect/reconnect controls.

### Phase 2 — Inline quota per account

- Poll or receive limits per provider account.
- Render multi-account quota state inline.
- Skip known-exhausted accounts for new turns.

### Phase 3 — Automatic failover

- Detect hard exhaustion during startup or turn execution.
- Retry once on the next eligible account, unconditionally (req 14).
- Fail the turn with reset times when no eligible account remains (req 13).
- Record failover events in chat history and diagnostics.

### Phase 4 — Policy controls

- Drag/reorder controls for the per-provider prioritized account list.
- Per-provider short-window and weekly cutoff controls, both defaulting to 90%.
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
- ~~Provider terms / default posture~~: **closed.** Req 15 — automatic failover
  is on by default for every provider.
- **Concurrent turns on one account:** decide whether ShipIt should avoid routing
  multiple simultaneous heavy turns to the same provider account when another
  account has more remaining quota.
- **Warm pool timing:** confirm account selection happens before credential
  provisioning for every runner path, including claimed warm sessions.
- ~~Child-session inheritance policy~~: **closed.** Req 18 — spawned sessions run
  the normal account router; no inheritance.

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
- Integration: mid-turn exhaustion retries on the secondary account exactly once,
  including when the turn has already edited files or run commands (req 14).
- Integration: switching a pinned session from account A to account B kills any
  persistent agent, reprovisions account B's credentials, preserves
  `.claude/projects` / `.codex/sessions` and `agentSessionId`, and the next turn
  resumes the same conversation (req 9).
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
- Integration: with every account exhausted, the turn fails immediately with the
  earliest reset time, pins nothing, provisions no credentials, and schedules no
  timer (req 13); a queued message behind it fails the same way.
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

### Landed: proactive cutoffs are a third tier, not a lower exhaustion threshold

Reqs 4–6 add a per-provider cutoff on each window, defaulting to 90% (req 5).
The obvious implementation — lower the "is this account exhausted?" threshold
from 100 to the cutoff — is **wrong**, and wrong in a way that makes the feature
worse than not having it: once every connected account crossed 90%, every turn
would fail with `all_exhausted` while ten percent of each account's window sat
unused. A cutoff is a *preference*, not a wall.

So selection has three tiers, not two:

1. **Under its cutoff** — chosen first, in priority order.
2. **Over its cutoff but not spent** — still perfectly capable; used when
   nothing is under a cutoff. Picking the first in priority order (rather than
   the least-used) keeps the choice stable instead of hunting.
3. **Spent** (`usedPct >= 100`, or a persisted `exhaustedUntil`) — unusable, and
   only this tier produces req 13's `all_exhausted`.

`isRouteUsableForTurn` — which drives whether an existing session gets moved —
needs the same distinction, plus one more. A pinned session over its cutoff
should move **only if there is an account genuinely under one**. Comparing
against `selectAccountForTurn`'s answer is not enough: when every account is
over its cutoff the selector returns its tier-2 fallback, which is merely the
*first* over-cutoff account, so a session pinned to the second one would be
displaced onto the first, then back again — killing the resident process every
turn for no benefit. The check therefore looks for an under-cutoff alternative
directly. (This was caught by the churn test, not by review.)

Storage clamps to 1–100 on read as well as write, so a hand-edited config yields
a working selector rather than throwing on every turn; the API edge *validates*
instead, because a request carrying 0 or 150 is a caller bug and silently
accepting it as 1 or 100 would hide it.

The Settings control lives on the provider's accounts card rather than in
Advanced, and only appears once a provider has two or more accounts — with one
account there is nowhere to fail over to, so the number could never do anything
(req 15: connecting a second account is what turns failover on).

**Still open in Phase 4:** the user-controlled priority order itself (req 2) —
selection order is still "primary first, then stored order". Reqs 4–6 say the
cutoff advances to the next account *in the user's priority order*, so this
delivers the advancing half; the ordering half is the next piece.

### Landed: AI session naming runs on a real account (req 19 prerequisite)

Phase 5's last item — remove the legacy root credential paths and the alias
symlinks — carries its own precondition: *once every read and write goes
through an account root*. That precondition is not met yet, and this is one of
the readers standing in the way.

`session-namer.ts` shells out to `claude -p` / `codex exec` with `HOME` forced
to `/root`. In production `/root/.claude` → `/credentials/.claude` → the alias
symlink → `provider-accounts/claude/claude-default`. So AI naming always ran on
the **migrated default account**, whichever account the user had made primary —
and stopped working entirely once that account was disconnected, while
everything else kept working. A quiet, hard-to-attribute failure.

Naming now resolves the same route a turn for that agent would take
(`selectRouteForTurn`) and points `HOME` at that account's credential root —
the same "the account layout mirrors `$HOME`" trick the scoped auth flows use.
A reserved route (`claude-api-key`, `claude-env-oauth`) has no account root, so
it keeps the singleton path, which is what those routes legitimately use.

The same call site also carried the last deferred finding from the account-
scoping review: `graduateSession` called `ensureAgentTokenFresh(agentId)` with
no account, so every new session refreshed *every* connected account and
aggregated with `every()` — wasting a refresh on unrelated accounts and letting
a revoked sibling report failure for a token that was fine. It now heals the
account naming will actually use.

**What this does and does not unblock.** It removes one legacy-root reader.
Others remained at the time — `AgentRegistry`'s auth probe (`isConfigured()`
unscoped), Codex's unscoped `checkCredentials`, and provider-wide sign-out — and
each had an honest reason to read the singleton path. They have since been
resolved; see the next section, which retires the aliases themselves. Note the
aliases were not merely inert: they leak into session containers, which is the
entire reason docs/153's symlink-leak repair exists.

### Landed: the legacy aliases are retired (req 19, Phase 5)

Migration no longer leaves `<credentialsDir>/.claude`, `.claude.json`, or
`.codex` as symlinks into the migrated default account, and
`migrateDefaultAccounts` retires any left behind by an earlier boot. The three
readers the previous section was blocked on turned out to be resolved or
deliberate: the registry's probe is wired to `hasAnyAuthForProvider` at the DI
boundary (its one surviving `isConfigured()` caller passes `credentialDir`);
Codex's no-arg `checkCredentials()` resolves through `activeCredentialDir`
during a scoped flow; and provider-wide sign-out reads the singleton path *on
purpose*, for installs that never migrated.

Two details are load-bearing:

- **Only symlinks pointing into `provider-accounts/` are removed.** A real file
  or directory at a legacy path belongs to an install whose migration has not
  run yet — deleting it would destroy the only copy of its credentials.
- **A directory-shaped legacy path is left as a real, empty directory — but only
  on an install that has an account.** `/root/.claude` and `/root/.codex` are
  image-level symlinks to these paths (`docker/Dockerfile.prod`), and `mkdir`
  through a *dangling* symlink fails with EEXIST — so a CLI invocation on a
  reserved route (which legitimately runs with `HOME=/root`) would lose its
  config dir and fail in exactly the quiet way session naming used to.
  File-shaped paths need no placeholder: a write through the dangling image
  symlink creates the target.

**The sweep's output is the next boot's input, and that closed a loop.** The
placeholder was first written unconditionally, including on an install that had
never been signed in. `migrateProviderDefault` gated on `fs.existsSync` of a
legacy path, so the *next* boot read that empty directory back as pre-account
credentials and registered a `ready` `claude-default` / `codex-default` row with
an empty credential root. That row is not inert: `hasAnyAuthForProvider` turns
true (so onboarding and the startup log both report a connected account), and
`selectAccountForTurn` prefers any `ready` account over the reserved route — req
12's guard only covers the *failover* direction — so an install running on
`ANTHROPIC_API_KEY` routed its turns to a directory with nothing in it. The same
state was reachable by deleting every account and restarting.

Two independent guards, because either alone leaves a hole:

- **The placeholder is owed only to an install with accounts.** A never-signed-in
  install keeps the legacy path absent, which is the state it had before req 19.
- **Migration gates on a credential *marker* with content**
  (`.claude/.credentials.json` and friends, `.codex/auth.json`), not on a legacy
  path existing. Existence was never evidence: `.claude.json` is the CLI's user
  config, and the directory itself is something any `HOME=/root` run creates
  through the image symlink. This is the guard that covers an install whose
  accounts were all deleted after a placeholder had already been written.

Boot-to-boot idempotence is the property under test, and a single-boot assertion
cannot see a violation of it — the regression tests run `migrateDefaultAccounts()`
across two manager instances over one credentials root.

**Sign-out was erasing one account's credentials, not the provider's.** The
route deleted the account *rows*, then called the unscoped `signOut()`, which
only ever cleared the singleton path — an alias into the migrated default. Every
account connected after that kept live OAuth tokens on disk, with its row
deleted so nothing in the UI could reach them. `signOutProvider` now walks every
account through `delete()` first, then runs the unscoped `signOut()` for
pre-account installs.

**Removing the aliases exposed two readers that had been quietly leaning on
them**, both fixed here by resolving a real account root the way session naming
does. Neither would have failed loudly:

- **Voice transcript cleanup** gated on an unscoped `getAccessToken()`, so on a
  migrated install it would have found nothing and silently dropped to the
  OpenAI fallback — or to no cleanup at all.
- **The limits pill's plan label** stayed unscoped when `doRefresh` was fixed,
  so it labelled every account with the migrated default's plan, and with
  nothing once the aliases went.

That pattern — an unscoped read that degrades quietly rather than erroring — is
what made this phase worth finishing rather than leaving the aliases in place.
Startup credential logging had the same shape and now asks the account manager,
so a multi-account install no longer boots claiming "no credentials found".

### Landed: there is no unscoped sign-in (req 19, Phase 5)

`AgentAuthStartOptions` had `accountId` and `credentialDir` optional, with a
docstring promising that "omitting both fields preserves the pre-150 singleton
behavior". That promise had no callers left: the singleton endpoints were
deleted with req 16, and `ProviderAccountManager.startAccountAuth` is the only
thing that starts a flow. Both fields are now **required**.

This is stricter than "unused code, delete it later", because the dormant path
was not inert. The client files every challenge under an account row and drops
an `agent_auth_*` event that names no account, so an unscoped flow would spawn
a provider CLI waiting on a code the user could never be shown. Making the
scope required means that state cannot be constructed, rather than merely not
being constructed today.

With `start` scoped, `getActiveAccountId()` is necessarily set when a manager
emits `complete`, so `wireEventHandlers`' account-less branch is unreachable.
That branch re-ran `migrateDefaultAccounts()` to re-register a default row
after a singleton sign-in — a flow that no longer exists, and one a user
signing in after a sign-out doesn't need, because "Add account" creates the row
before the login starts. It is replaced by a warning: a completion with no
scope means a manager emitted `complete` without a start, which is a bug worth
seeing rather than papering over by inventing a row.

One thing deliberately *not* tightened: `isConfigured` and `signOut` keep their
optional scope. Both have honest unscoped callers — `AgentRegistry` probes the
singleton credential path, and provider-wide sign-out clears credentials that
may predate accounts entirely. Those are reads and teardown, not a second way
to connect.

### Landed: one field for the order (req 19, Phase 5)

`priority` and `isPrimary` both encoded the same fact, and two fields for one
fact are two fields that can disagree. "Primary" only ever meant "first in the
fallback order" — `makePrimary` is implemented as a `reorder`, and `reorder`
wrote `isPrimary: index === 0` in step with it. So `isPrimary` was never
independent; it was a cached copy with three separate pieces of machinery
keeping it honest.

`isPrimary` is now **derived on read** — `list()` stamps `index === 0` — and is
neither persisted nor maintained. That deletes:

- the `isPrimary` write in `reorder` and `create`,
- `CredentialStore.upsertProviderAccount`'s two blocks (clear the flag from
  siblings; re-elect a primary if none is set),
- `CredentialStore.deleteProviderAccount`'s re-election,
- `CredentialStore.getPrimaryProviderAccount` entirely — `getPrimary` is now
  `list(provider)[0]`.

`get()` also routes through `list()`, so no caller can see a different
`isPrimary` depending on which accessor it reached for. The wire shape is
unchanged, so the client still reads `account.isPrimary` and nothing in the UI
moved. Stale flags left on disk are simply ignored.

**The legacy ordering rule is gone from the read path, not disabled.** `list()`
used to carry a compatibility branch — rows with no `priority` sorted
primary-first, then stored order — so an upgrade wouldn't move which account a
user's turns ran on. That guarantee now belongs to `backfillPriority()`, which
runs once from `migrateDefaultAccounts` (already the "bring stored accounts up
to the current shape" entry point) and records the order those rows *currently*
resolve to under the old rule. Same order, written down instead of recomputed
forever. The old rule survives only as `legacyRank`, used solely to seed that
one-time backfill; nothing on the read path calls it. `migrateProviderDefault`
also stamps `priority: 0`, so it stops minting priority-less rows.

A row with no `priority` now sorts *last* rather than first. That is deliberate:
after the backfill there shouldn't be any, and treating a missing value as `0`
would silently promote an unknown row to primary — the failure mode worth
avoiding is the quiet one.

### Fixed: the reorder buttons wrote the order but never showed it (req 2)

Reported as "buttons that change the order of accounts don't work". They half
worked, which is worse: `reorder` wrote `priority` correctly and the **router
honoured it immediately**, so which account a turn ran on really did change —
but nothing the user could see moved.

The split was between two accessors. `accountsInSelectionOrder()` sorted by
`priority` and was what the router read. `list()` returned
`credentialStore.listProviderAccounts()` — raw storage order — and was what
every *wire* path read: the `PUT /order` response, the `provider_accounts` SSE
broadcast, `GET /api/provider-accounts`, and bootstrap. Storage order never
moves, because `upsertProviderAccount` replaces a row in place. So the rows
stayed exactly where they were, the primary badge stayed on the old row, and
the control read as dead.

The fix is to delete the distinction: `list()` now returns selection order, and
`accountsInSelectionOrder()` delegates to it. An account list has no other
meaningful order, and sorting at the source means a future broadcast site
cannot reintroduce the bug by forgetting to sort — which is exactly how eight
call sites would have gone wrong one at a time.

**Why the tests didn't catch it.** Every existing assertion went through
`accountsInSelectionOrder` — the one accessor that was always right. Nothing
asserted the order of what the client is actually handed. The regression test
asserts `list()` (both the per-provider and all-providers forms the SSE
broadcast uses), and an HTTP-level test asserts the order in the `PUT` response
*and* in a subsequent `GET`, so a reload snapping the rows back would fail too.
Verified in the browser as well: three rows, moved to the top one press at a
time, primary badge following, order surviving a reload.

### Landed: the priority order (req 2)

`ProviderAccount.priority` (ascending, 0 tried first) is now the authoritative
selection order, replacing "primary first, then stored order". Three decisions
worth recording:

- **Legacy rows keep the old behaviour exactly.** `priority` is optional, and a
  row without one sorts by the previous rule (the primary leads, everything else
  in stored order). An install that never touches the reorder control therefore
  sees no change in which account its turns run on — an upgrade that silently
  moved work to a different subscription would be a bad surprise, not a feature.
- **A new account appends.** `create` assigns `max(existing) + 1`. Inserting it
  anywhere else would mean connecting an account silently changed which
  subscription existing sessions run on.
- **`reorder` takes the complete list, not a move-one verb.** An ordering is
  only meaningful as a whole, and demanding the full set makes a stale client —
  one whose list predates an account added in another tab — fail loudly with a
  400 rather than quietly demoting the account it never saw. `makePrimary` is
  expressed *through* `reorder` so `priority` and `isPrimary` cannot drift
  apart; position 0 and the `isPrimary` flag are written together.

The Settings control is a pair of up/down carets per row, shown only with two or
more accounts. Deliberately not drag-and-drop: the list is short, carets are
keyboard- and screen-reader-accessible without extra work, and each press is one
complete `PUT` rather than a drag that has to be reconciled mid-gesture.

With this, reqs 4-6's "advances to the next eligible account **in the user's
priority order**" is satisfied in full — the cutoff mechanism already advanced,
and this is the order it advances along.

### Fixed: three ways the per-account quota pill was wrong

Reported from a running instance: a single pill reading `Claude 5h · — 7d · —`,
with no account name and a refresh button that did nothing. Three separate
defects, all introduced by the Phase 2 per-account refactor — the route id was
threaded through the caches but not through the three places that needed it.

1. **The label counted snapshots, not accounts.** `entries.length > 1` gated the
   account name on how many *snapshots* had arrived, and routes with no snapshot
   are omitted from the map. Two connected accounts where only one had ever
   reported quota therefore rendered one pill labelled "Claude" — silent about
   which subscription it described. Beyond the counting bug, the rule itself
   contradicted req 10, which asks for the account name outright; suppressing it
   for the single-account case was an agent inference narrowing a stated
   requirement. The name is now unconditional for account routes; reserved
   env/API-key routes keep the provider label, since they are not accounts.

2. **`routeIds()` could not name a route until it already had data.** It
   returned the union of the cached maps' keys, so the once-per-sign-in seed
   fetch (`refreshNow(agentId, "seed")`, which iterates `routeIds()`) ran zero
   iterations for a freshly connected account — data was required in order to be
   allowed to fetch data. It now unions the *connected accounts* with the cached
   keys, so a new account is refreshable immediately and a reserved route that
   only exists in the cache is still surfaced.

3. **The usage fetch used the wrong credentials — this was the dead refresh
   button.** `doRefresh(routeId)` called `authManager.getAccessToken()` with no
   argument. That signature's account-scoped behaviour only engages when a
   credential dir is passed; without one it prefers `ANTHROPIC_AUTH_TOKEN` and
   otherwise reads the root config dir. For accounts stored under
   `provider-accounts/claude/<acct>/` the token came back `null` and the refresh
   returned silently, leaving the pill at "—" forever. In a dogfood/env-token
   setup it was worse than silent: it fetched the env account's usage and
   attributed it to whichever route it was called for. The route id now resolves
   to that account's credential root, and `undefined` (the reserved-route case)
   still selects the env/legacy path.

The lesson for the remaining per-account work: threading an id through the data
structures is the easy half. The half that bites is every *call* that still runs
provider-wide — enumeration, credential lookup, and any UI rule that infers
"how many accounts" from "how much data arrived".

### Legacy removal (req 19)

Req 19 says the compatibility shims are a migration step, not a permanent second
way for provider accounts to work. What "legacy" means concretely — this is
design detail, deliberately kept out of `requirements.md`:

- **Legacy root credential paths.** `LEGACY_CREDENTIAL_PATHS` and the alias
  symlinks that keep `~/.claude`, `~/.claude.json`, `~/.codex` working beside
  `provider-accounts/<provider>/<id>/`. Removing them means every read and write
  goes through an account root.
- ~~**The singleton subscription auth surface.**~~ **Done** — see "Landed: one
  connect surface, and only one" below. Sign-*out* is deliberately still
  provider-wide.
- **`selectRouteForTurn`.** The route-or-null wrapper kept for callers that had
  nothing to do with a reason; `selectAccountForTurn` is the real API.
- **The `isPrimary`-only ordering fallback.** `accountsInSelectionOrder` still
  honours rows with no `priority`. That branch exists so an upgrade doesn't move
  which account a user's turns run on — it can go once stored rows are
  backfilled, which is the one item here that needs a migration rather than a
  deletion.
- **`ProviderAccount.isPrimary` itself**, if it survives as nothing but "position
  0". It is currently written in step with `priority` by `reorder`; once nothing
  reads it independently, one of the two should go.

Ordering matters: this is the **last** phase. Each shim is load-bearing for an
install that has not yet exercised the new path, so removing one before the
replacement is proven turns a migration into a regression. The signal that a
shim is ready to go is that nothing reads it — not that the replacement exists.

### Landed: one connect surface, and only one (reqs 16, 19)

Req 16 was half-satisfied for a while: Settings connected every account through
`ProviderAccountsCard`, but **first-run onboarding still rendered the singleton
`ClaudeAuthCard` / `CodexAuthCard`**. So the very first account a user ever
connected — the one most likely to be their primary — was created by different
code, hitting different endpoints, than every account after it. That is exactly
the divergence req 16 names, surviving in the one place a new user is guaranteed
to hit.

**The change is a substitution, not a new component.** Onboarding renders the
same `ProviderAccountsCard` Settings does. Onboarding keeps only the props that
are genuinely its own (GitHub token, agent list, refresh, complete); every
sign-in prop it used to thread through — `authUrl`, `onStartClaudeAuth`,
`onPasteAuthCode`, and the four Codex device-auth props — is gone, because the
card owns that state.

**What got deleted rather than left dormant** (req 19 — a shim nothing reads is
the definition of ready to remove):

| Removed | Replaced by |
|---|---|
| `POST /api/auth/start`, `POST /api/auth/code` | `POST /api/provider-accounts/:provider/:accountId/login[/code]` |
| `POST /api/codex-auth/start`, `POST /api/codex-auth/cancel` | the same, plus `/login/cancel` |
| `startAuth` / `submitAuthCode` services | `startProviderAccountLogin` / `submitProviderAccountCode` |
| `ClaudeAuthCard`, `CodexAuthCard` (+ tests) | `ProviderAccountsCard` |
| `sessionStore.authUrl`, `settingsStore.codexDeviceAuth{,Error}` | `providerAccountAuths`, keyed by account |

Sign-**out** (`DELETE /api/auth/api-key`, `DELETE /api/codex-auth`) stays
provider-wide on purpose: it clears credentials that may predate accounts
entirely, and drops every row for the provider. It is not a second way to
*connect*, which is what req 16 is about.

**A latent bug the removal exposed.** With provider-wide slots gone, an
`agent_auth_pending` event carrying no `accountId` has nowhere to land. The SSE
*reconnect replay* in `route-registry.ts` was emitting exactly that — it
rebuilt the event from `getPendingPayload()` and never included the account,
unlike the live broadcast in `app-lifecycle.ts`. The pre-existing symptom was
already wrong (reload mid-sign-in put the challenge in the singleton card
instead of the row that started it); after the removal it would have been a
silent drop. The replay now carries `accountId`.

Claude's auth *diagnostics* remain provider-wide and still update for
account-less events — they are a debug buffer, not a challenge, and keying them
per account is a separate open Phase 1 item.

**A second one, in the same class, that the review found.** Both OAuth
refreshers detect revocation *per account* — they know the id, log it, and
broadcast a per-account `claude_account_unauthenticated` /
`codex_account_unauthenticated` — and then dropped it from the unified
`agent_auth_failed`. Same fix: name the account. That exposed a third bug behind
it: Claude wires `account_unauthenticated` → `markProviderAccountUnauthenticated`
(docs/195) but **Codex never did**, so a revoked Codex account kept
`status: "ready"` and the router went on picking it over a healthy secondary —
a req 3 failover hole with nothing to do with the UI. Wired.

**Verified in a running preview, which the unit tests could not do.** With the
Claude credential removed, the dogfood instance drops to first-run onboarding.
Two things only the browser showed:

- Two full-density cards overflowed the fixed-height pane by **206px**, putting
  "Get Started" below the fold with no scroll cue — a first-run user saw no way
  forward. The component test passed the whole time: it asserts elements exist,
  and they did. Fixed by giving step 2 its own (still fixed) modal height and
  adding a `compact` flag that drops the between-accounts failover explainer —
  prose about what happens *between* accounts, shown to someone with none.
  `compact` is density only: same rows, same endpoints, same state, so the
  flows still do not diverge.
- The end-to-end flow works: "Add account" created `acct_…`, started the login,
  and the Claude OAuth URL + paste-code input rendered **on the row that started
  it** — which is the account-scoped `agent_auth_pending` arriving with its
  `accountId`. Cancelling flipped that row to `auth failed` with the message on
  the row, not in a provider-wide slot.

**Dead plumbing removed with it, and the trap in doing so.** `AgentListenerDeps`
carried `authManager` and `authManagers` with comments claiming the
`auth_required` handler used them to launch a sign-in flow. It does not — that
handler only refreshes tokens (docs/179), and the only interactive auth start in
the process is `startProviderAccountLogin`. So both fields were dead, along with
`RebaseDriverDeps.authManager` and `RunnerRegistryDeps.authManager`, which
existed only to forward them.

Deleting them broke auto-resolve-conflicts, and the way it broke is worth
recording: `createPrStatusPoller` gated the whole auto-resolve callback on
`if (createGitManager && chatHistoryManager && usageManager && authManager)`.
Once `authManager` stopped being passed, that guard silently went false and the
feature turned itself off — no type error, no failing unit test, just six
integration tests timing out waiting for a card that would never arrive. A dep
that is unused by the code it is handed to can still be load-bearing as a
*presence check*; grep for the identifier in conditionals, not just in call
positions.

### Landed: auth operations are per-account, not per-provider

Two of the review findings above, both instances of the same mistake: an
operation that names an account, implemented against the provider.

**The runtime-401 heal healed everything.** When a turn's CLI reports
`auth_required`, docs/179 heals the OAuth token and quietly re-dispatches the
turn once. It called `ensureAgentTokenFresh(agentId)` with no account, and the
Claude refresher's no-account path refreshes *every* connected account and
returns `results.every(Boolean)`. That was correct when a provider had one
account. With several, a second account that is revoked or was never signed in
makes the aggregate `false`, so a turn whose own token healed fine is told it
could not heal — and the user gets a sign-in card for an account that was
never broken. The turn deps gained `resolveTurnAccountId`, wired on both turn
paths from the session's pinned route, so the heal names the account the turn
actually runs on. The refresher's docstring said "in production: just
`claude-default`" — the whole premise of this feature is that it isn't, so that
is corrected rather than left as a trap for the next reader.

**One login process, three unguarded entry points.** `startAccountAuth`,
`cancelAccountAuth`, and `submitAccountCode` each took an account id and then
drove the provider-wide manager without checking which account owned the
in-flight flow. Concretely: a second "Add account" marked its own row
`authenticating` and then either inherited the first row's challenge (Codex
replays its cached device code) or killed the first row's flow while leaving
that row spinning (Claude); one row's Cancel aborted another row's sign-in
while resetting only the clicked row; and a pasted authorization code went to
whichever flow was running, not the one that issued it. All three now check
`getActiveAccountId()`. Start and submit refuse with a 409 naming the row that
holds the flow; cancel spares a flow it doesn't own but still resets its own
row's status, because that row genuinely isn't signing in.

Refusing is deliberate over queueing or pre-empting. One process per provider is
a real constraint of the CLIs, so the honest move is to say so — and the client
disables "Add account" / "Connect" while another row is authenticating, so the
409 is a backstop rather than the normal path.

**The guard needed three escape valves before it was safe.** A refusal keyed on
"who owns the flow" is only as good as the paths that *release* ownership, and
review found three that didn't:

- **Claude's `cancel()` never cleared the scope.** It called `kill()`, which
  tears down the PTY but leaves `activeFlowAccountId` set — and a cancel emits
  no terminal `complete`/`failed`, so nothing else would ever clear it. Harmless
  before; with the guard, one cancelled sign-in would refuse every later sign-in
  for that provider, forever. Codex's `cancel()` always cleared its scope; the
  two now match.
- **Deleting the owning row orphaned the flow.** `delete()` removed the row and
  its credential root without cancelling the login, so the manager kept naming a
  row that no longer existed — and with no row, no Cancel button, no way back.
  `delete()` now cancels a flow it owns.
- **A failed spawn left a phantom `authenticating` row.** The status was
  persisted before `mgr.start()`, so a throw left the row claiming to be signing
  in — blocking every other account. `startAccountAuth` now rolls the status
  back and releases the scope before rethrowing.

Submitting a code was also tightened past the original finding: `null` owner is
a refusal too, not a pass. Previously a code pasted after a timeout or restart
was swallowed by the manager with a log line while the endpoint answered 200,
so the user waited on a sign-in that had already gone nowhere.

**Known limit, deliberately kept.** `resolveTurnAccountId` is optional, so a
hand-built deps object with `ensureAgentTokenFresh` and no resolver still gets
provider-wide healing. Making that unrepresentable would mean a required field
on every test fixture for a path only production wires; the fallback is the
pre-docs/150 behaviour, not a new hazard. Every production path supplies it
(WS directly; dispatch and turn-adoption via the runner registry; the auth and
quota retries recurse with the same deps).

**What the review found that is real and was deferred out of that change** —
each was a different subsystem, and folding them in would have made one diff
un-reviewable. Two have since landed (see "auth operations are per-account"
below); these two have not:

- ~~Provider-wide sign-out lacks the pinned-session safeguards.~~ **Done, and
  smaller than it looked** — see "Landed: sign-out's real hole" below.
- `AgentAuthManager.start` still accepts a call with no account scope. Nothing
  calls it that way — `startProviderAccountLogin` is the only interactive
  caller — but the overload and the account-less `complete` branch behind it
  should go with the rest of Phase 5.

### Landed: sign-out's real hole was one case, not four

The review of the previous change reported provider-wide sign-out as broadly
unsafe: it drops every account row for a provider with none of the safeguards
per-account disconnect has, "stranding pinned sessions on dead route ids".
Checking that against the code rather than taking it as read, most of it does
not bite:

- **A session pinned to a deleted account is not stranded.** A route whose row
  is gone reads unusable (`isRouteUsableForTurn` returns `false` for an unknown
  account), so `sessionNeedsAccountFailover` is true and the next turn's
  enforcing preflight moves it to another account — conversation intact (req 9)
  — or reports `auth_required` if the user really did sign out of everything.
  Which is the correct outcome. The failover machinery built for reqs 3/8
  already covers the case.
- **Offering a replacement account makes no sense here.** Per-account
  disconnect asks "move these sessions where?" because other accounts remain.
  Sign-out removes them all; there is nowhere to move to.

What genuinely does not recover is a turn that is **running right now**:
sign-out rewrites credentials under a live agent, and the user gets a mid-turn
401 instead of an answer. That is the one case guarded, mirroring the identical
refusal in `deleteProviderAccount`, and it is the whole fix. Both sign-out
routes also surface the `ServiceError` instead of flattening it into a 500, so
the refusal arrives as an actionable 409.

The general point: a reported gap between two code paths is a hypothesis about
behavior, not a defect list. Three of the four differences here were correct by
design once the failover path was accounted for.

### Not legacy after all: `selectRouteForTurn`

Phase 5 listed "remove `selectRouteForTurn` in favour of `selectAccountForTurn`"
as compat-shim cleanup. It isn't one. It is a three-line convenience —
`selection.ok ? selection.route : null` — with two callers that genuinely want
route-or-null and have no use for a failure reason: rate-limit attribution
(`bootstrap-managers.ts`, which needs a route id to key a quota snapshot) and
sub-agent spawn (`sub-agent.ts`, which provisions from whatever account the
router would pick). Neither is a turn that can be blocked, so neither has
anything to do with reqs 13/17. Removing it would inline the same wrapper at
both sites and call the result cleanup. The checklist item is retired as
mistaken rather than executed.

### Non-goal: routing around model capability (req 17, reversed 2026-08-02)

Requirement 17 originally said ShipIt should skip an account that cannot run the
requested model and report that no account can serve the turn. The user reversed
it: mixing accounts with different model access is theirs to manage, ShipIt must
not work around it, and the error simply has to be clear with no automatic
recovery. See `requirements.md` for the rewritten requirement and its receipt.

**What prompted the reversal.** The mechanism was built and tested but dormant,
because nothing populated `ProviderAccount.capabilities.models`. The planned
source — an `agent_init` decoration — cannot do it: `AgentInitEvent` carries a
single `model`, the one that just *started*, plus tools and permission mode.
Both adapters construct it that way (`codex/codex-event-handler.ts:729`,
`claude/adapter.ts`). Nothing in it enumerates *supported* models.

Writing the observed model in would have been worse than leaving it empty.
`accountSupportsModel` read that array as a **whitelist**: absent or empty meant
"assume capable", non-empty meant "only these". The first turn an account ran on
Sonnet would have set `models: ["sonnet"]`, and the feature would then have
refused Opus on an account that very likely supports it — a single positive
observation silently promoted into an exhaustive capability list, failing in a
way that looks like the feature working.

The remaining options were a static plan→models table (stale the moment a
provider changes tiers, and mis-refusing silently when it does) or detecting
refusals from turn failures (sound, but real mechanism for a corner case). The
user's call was neither: **do nothing.**

**What that means in code.** Removed rather than left dormant, per req 19's
spirit — a mechanism with no data behind it is exactly the kind of second way of
working that requirement exists to prevent:

- `AccountSelectionFailure`'s `no_model_eligible_account` variant
- `SelectAccountOptions.model` and the `accountSupportsModel` helper
- the model filter in `selectAccountForTurn` and in `isRouteUsableForTurn`
- the model plumbing through `selectRouteForNewTurn` and
  `sessionNeedsAccountFailover`

**What provides the "clear error".** Nothing new. The turn runs on the selected
account, the provider rejects the model, and that error reaches the transcript
through the existing `agent_result` error path. The req-14 same-turn retry does
not fire, because `detectHardExhaustion` matches quota language only — verified,
not assumed: none of its patterns match a model-unavailable message. So "no
automatic recovery" holds by construction rather than by a new guard.
