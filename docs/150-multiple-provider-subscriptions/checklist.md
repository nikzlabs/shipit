# 150 — Multiple provider subscriptions checklist

## Phase 0 — Research and Preconditions

- [ ] Confirm stable provider account identity fields for Claude.
- [x] Confirm stable provider account identity fields for Codex.
- [x] Decide default failover posture — on by default for every provider (req 15).
- [x] Decide child-session inheritance policy for provider routes — normal priority order, no inheritance (req 18).
- [ ] Decide whether concurrent turns should spread across accounts or keep primary affinity.

## Phase 1 — Account Registry and Manual Routing

- [x] Add shared `ProviderAccount`, `ProviderAccountCapabilities`, and provider route types.
- [x] Add `provider_route_kind` and `provider_route_id` session persistence fields.
- [x] Add SQLite migration for session provider route fields.
- [x] Add provider-account metadata persistence to `CredentialStore`.
- [x] Add `ProviderAccountManager` for account CRUD, default selection, reserved-route selection, and coarse provider auth checks.
- [x] Migrate existing singleton Claude credentials into `provider-accounts/claude/claude-default`.
- [x] Migrate existing singleton Codex credentials into `provider-accounts/codex/codex-default`.
- [x] Keep legacy root credential paths as aliases during the compatibility window.
- [x] Rewire `AgentRegistry.authConfigured` derivation through provider-account/reserved-route availability.
- [x] Provision per-session credentials from the selected provider account.
- [x] Select any usable stored account, not only the primary, before falling back to reserved env/API-key routes (reqs 3, 12).
- [x] Preserve conversation-state subpaths when reprovisioning replaces a provider subtree (req 9).
- [x] Extend token sync-in/sync-back to account-qualified credential paths.
- [x] Skip token sync for `claude-env-oauth` reserved route.
- [x] Account-qualify token re-push helper so account X does not update account Y sessions.
- [x] Persist selected provider route when a session is first pinned.
- [x] Make Claude auth manager account-scoped for starting/checking/signing out specific accounts.
- [x] Make Codex auth manager account-scoped for starting/checking/signing out specific accounts.
- [x] Force auth subprocesses to write to an account-specific HOME/config root.
- [x] Add account-qualified auth pending/complete/failed SSE events.
- [x] Add Settings endpoints/services for list, create, rename, make primary, and disconnect provider accounts.
- [x] Render provider account management in Settings.
- [x] Replace provider-wide Claude/Codex subscription cards with one account-row authentication surface for all stored subscriptions (req 16 — first and subsequent accounts use the same connect UI).
- [x] Share the account-row shell across Claude code-paste and Codex device-code challenge variants.
- [x] Key pending challenge, failure, and completion state by provider account id.
- [ ] Key Claude CLI auth *diagnostics* by account id too (still provider-wide; the row renders the shared buffer while it is mid-challenge).
- [ ] Reuse the account-row flow in onboarding instead of singleton Claude/Codex auth cards.
- [x] Move Claude and Codex Platform API-key inputs into separate collapsed fallback sections with explicit metered-billing copy.
- [ ] Migrate singleton Claude/Codex login, code, cancel, and sign-out callers to provider-account endpoints.
- [ ] Remove singleton subscription auth endpoints and provider-wide pending client state after caller migration.
- [x] Block disconnect while an account is pinned to a running session unless replacement is selected.
- [x] Implement account-switch runtime transition for pinned sessions: kill process, reprovision while preserving conversation-state subpaths, keep `agentSessionId`, resume (req 9).
- [x] Hydrate persisted provider route for detached/system-turn runner recreation.
- [x] Route child-session first turns through the normal account router (req 18).
- [ ] Route child follow-up turns through persisted agent and provider route, not default agent fallback.
- [x] Offer a replacement account inline when disconnecting an account that pinned sessions use.
- [ ] Add `agent_init` provider-account metadata decoration at the orchestrator boundary.
- [ ] Add local/dogfood direct-run account-scoped HOME/config-root support or explicit unsupported diagnostic.

## Phase 2 — Inline Quota Per Account

- [ ] Change `SubscriptionLimitsMap` wire shape to provider -> account-or-route -> limits.
- [ ] Update `LimitsPoller` cache, state, delta detection, and SSE broadcast for account-keyed snapshots.
- [ ] Poll Claude quota per stored Claude provider account.
- [ ] Preserve `claude-env-oauth` as a quota-bearing reserved route keyed by `claude-env-oauth`.
- [ ] Associate Codex `agent_rate_limits` events with the account used by the current runner.
- [ ] Persist quota snapshots and plan labels onto provider accounts where appropriate.
- [ ] Compute Claude model-specific quota state using `weeklyOpus`, `weeklySonnet`, or `weekly`.
- [ ] Treat unknown Codex quota as selectable but lower-ranked than known healthy quota.
- [ ] Render header subscription limits as one existing-style pill per account, labelled with the account name (req 10).
- [ ] Keep the 1-account badge layout visually stable.
- [ ] Render multi-account grouped/expanded quota state without layout overlap.
- [ ] Render active provider account in session diagnostics.
- [ ] Skip known-exhausted accounts for new turns.
- [ ] Surface `all_exhausted`, `auth_required`, and `no_model_eligible_account` as distinct recoverable states.
- [ ] Fail an all-exhausted turn immediately with the earliest reset time, before any first-turn pinning or credential provisioning (req 13).

## Phase 3 — Automatic Failover

- [ ] Detect hard quota exhaustion from Claude quota/runtime failures.
- [ ] Detect hard quota exhaustion from Codex usage events/runtime failures.
- [ ] Retry once on the next eligible account on hard exhaustion, unconditionally (req 14).
- [ ] Avoid duplicating user chat history during same-turn retry.
- [ ] Clear or replace failed in-progress assistant output during retry.
- [ ] Record failover as a chat-visible system event attached to the original turn.
- [ ] Ensure all turn entrypoints use shared provider-account preflight: chat, answer-question, system turns, CI auto-fix, child sessions, and rebase/conflict recovery.

## Phase 4 — Policy Controls

- [ ] Persist a user-controlled priority order for authenticated accounts per provider (`ProviderAccount.priority`, ascending; backfill existing rows from `isPrimary`).
- [ ] Widen `selectRouteForTurn` into `selectAccountForTurn` with structured failures (`all_exhausted` / `auth_required` / `no_model_eligible_account`), which reqs 13 and 17 depend on.
- [ ] Add Settings controls to reorder provider accounts; newly connected accounts append to the fallback order.
- [ ] Persist per-provider short-window and weekly usage cutoffs with 90% defaults and 1–100 validation.
- [ ] Add Settings controls for both proactive failover cutoffs.
- [ ] Re-evaluate account eligibility before every turn, including existing-session, queued, and system-initiated turns.
- [ ] Switch an existing session to the next ordered eligible account when either configured cutoff is reached.
- [ ] Skip an account that cannot run the requested model and report no eligible account (req 17).
- [ ] Add optional per-session account preference.
- [ ] Add optional per-provider “do not auto-failover” setting.
- [ ] Add optional provider-profile label refresh where stable.
- [ ] Add account billing/account links as overflow escape hatches only.

## Tests

- [x] Unit: provider-account migration creates default accounts.
- [x] Unit: provider-account route selection prefers stored primary before API-key fallback.
- [x] Unit: a healthy secondary account is selected when the primary is auth-failed, and outranks the API-key fallback.
- [x] Unit: reprovisioning from another account preserves `.claude/projects` and `.codex/sessions` while replacing credentials.
- [x] Unit: session manager persists provider route kind/id.
- [x] Unit: session credentials provision only the selected provider-account subtree.
- [x] Unit: account-qualified sync-in/sync-back writes only the matching account source.
- [x] Unit: account-scoped Claude auth manager writes to the requested account root.
- [x] Unit: account-scoped Codex auth manager writes to the requested account root.
- [ ] Unit: account selection prefers primary, skips exhausted accounts, respects reset times, and ranks quota.
- [ ] Unit: account selection follows user priority and advances when either configurable cutoff is reached.
- [ ] Integration: an existing pinned session switches accounts at the proactive cutoff and preserves local context.
- [ ] Integration: first Claude turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: first Codex turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: auth-complete for account X re-pushes only to sessions pinned to account X.
- [ ] Integration: exhausted primary starts a new turn on a secondary account.
- [ ] Integration: all-exhausted fails the turn with reset times, pins nothing, and schedules no timer.
- [ ] Integration: mid-turn exhaustion retries on secondary once, including after file edits or commands.
- [x] Integration: switching a pinned session kills the persistent agent, reprovisions credentials, preserves `.claude/projects` / `.codex/sessions` and `agentSessionId`, and resumes the same conversation.
- [ ] Integration: detached system turns recreate runners from persisted agent/provider route.
- [ ] Integration: answer-question and rebase/conflict direct `agent.run` paths use provider preflight.
- [x] Client: Settings renders multiple accounts and primary selection.
- [x] Client: account-scoped sign-in renders its authorization controls on the owning row and submits through the scoped endpoint.
- [x] Client: render the migrated primary/default Claude subscription through the same account-row auth flow as secondary Claude subscriptions.
- [x] Client: render the migrated primary/default Codex subscription through the same account-row device-auth flow as secondary Codex subscriptions.
- [x] Client: share the account-row auth shell across Claude code-paste and Codex device-code challenge variants.
- [ ] Unit: API-key fallback configures only its reserved route and never marks a subscription account ready.
- [x] Client: an authenticated primary row does not hide or overwrite a secondary row's pending flow or diagnostics.
- [ ] Client: subscription limits render multiple accounts per provider.
- [ ] Client: session diagnostics renders the active account.
