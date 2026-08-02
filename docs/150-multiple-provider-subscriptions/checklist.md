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
- [x] Do NOT route around model capability — removed the skip-and-report mechanism (req 17 reversed to a non-goal, 2026-08-02).
- [ ] Add local/dogfood direct-run account-scoped HOME/config-root support or explicit unsupported diagnostic.

## Phase 2 — Inline Quota Per Account

- [x] Change `SubscriptionLimitsMap` wire shape to provider -> account-or-route -> limits.
- [x] Update `LimitsPoller` cache, state, delta detection, and SSE broadcast for account-keyed snapshots.
- [x] Poll Claude quota per stored Claude provider account.
- [x] Preserve `claude-env-oauth` as a quota-bearing reserved route keyed by `claude-env-oauth`.
- [x] Associate Codex `agent_rate_limits` events with the account used by the current runner.
- [ ] Persist quota snapshots and plan labels onto provider accounts where appropriate.
- [ ] Compute Claude model-specific quota state using `weeklyOpus`, `weeklySonnet`, or `weekly`.
- [x] Treat unknown quota as selectable (ranking below known-healthy quota is still open).
- [x] Render header subscription limits as one existing-style pill per account, labelled with the account name (req 10).
- [x] Keep the 1-account badge layout visually stable.
- [x] Reclassify "monthly usage limit" only when *every* connected account is exhausted, reporting the soonest reset.
- [ ] Render multi-account grouped/expanded quota state without layout overlap.
- [ ] Render active provider account in session diagnostics.
- [x] Skip known-exhausted accounts for new turns.
- [x] Return `all_exhausted` / `auth_required` / `no_model_eligible_account` as distinct results from the router.
- [x] Surface those three states to the user on a blocked turn (req 13's message).
- [x] Fail an all-exhausted turn immediately with the earliest reset time, before any first-turn pinning or credential provisioning (req 13).

## Phase 3 — Automatic Failover

- [x] Detect hard quota exhaustion from Claude quota/runtime failures.
- [x] Detect hard quota exhaustion from Codex usage events/runtime failures.
- [x] Retry once on the next eligible account on hard exhaustion, unconditionally (req 14).
- [x] Avoid duplicating user chat history during same-turn retry.
- [x] Resolve the failed attempt's in-progress output before the retry (the listener finalizes it, so the retry appends below it instead of colliding).
- [x] Record failover as a chat-visible system event attached to the original turn (pre-turn failover; the same-turn retry's event lands with req 14).
- [x] Ensure all turn entrypoints use shared provider-account preflight: chat, answer-question, system turns, CI auto-fix, child sessions, and rebase/conflict recovery.
- [x] Re-check an already-pinned session's account before its turn; switch away from a known-exhausted or unusable account before spawning.

## Phase 4 — Policy Controls

- [x] Persist a user-controlled priority order for authenticated accounts per provider (`ProviderAccount.priority`, ascending; legacy rows without one keep primary-then-stored order).
- [x] Widen `selectRouteForTurn` into `selectAccountForTurn` with structured failures (`all_exhausted` / `auth_required` / `no_model_eligible_account`), which reqs 13 and 17 depend on.
- [x] Add Settings controls to reorder provider accounts; newly connected accounts append to the fallback order.
- [x] Persist per-provider short-window and weekly usage cutoffs with 90% defaults and 1–100 validation.
- [x] Add Settings controls for both proactive failover cutoffs.
- [x] Re-evaluate account eligibility before every turn, including existing-session, queued, and system-initiated turns.
- [x] Switch an existing session to the next eligible account when either configured cutoff is reached.
- [x] Leave a model-ineligible account in place and let the provider's error surface, with no automatic recovery (req 17, reversed to a non-goal).
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
- [x] Unit: account selection prefers primary, skips exhausted accounts, and respects reset times (quota *ranking* still open).
- [x] Unit: account selection follows user priority and advances when either configurable cutoff is reached.
- [ ] Integration: an existing pinned session switches accounts at the proactive cutoff and preserves local context.
- [ ] Integration: first Claude turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: first Codex turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: auth-complete for account X re-pushes only to sessions pinned to account X.
- [x] Unit: a turn the provider kills for quota benches its account, and the stamp survives a restart and expires on its own.
- [ ] Integration: exhausted primary starts a new turn on a secondary account.
- [x] Unit: all-exhausted fails the turn with the earliest reset time, pins nothing, and provisions no credentials.
- [ ] Integration: all-exhausted fails the turn with reset times, pins nothing, and schedules no timer.
- [x] Integration: mid-turn exhaustion retries on secondary once, including after file edits or commands.
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
- [x] Client: subscription limits render multiple accounts per provider, each named.
- [ ] Client: session diagnostics renders the active account.

## Phase 5 — Legacy Removal (req 19)

Runs last: every shim below is load-bearing for an install that has not yet
exercised the new path. The signal one is ready to go is that nothing reads it.

- [ ] Remove the legacy root credential paths and alias symlinks once every read/write goes through an account root.
- [ ] Remove `selectRouteForTurn` in favour of `selectAccountForTurn`.
- [ ] Backfill `priority` onto stored rows, then drop the `isPrimary`-only ordering fallback in `accountsInSelectionOrder`.
- [ ] Resolve `ProviderAccount.isPrimary` vs `priority` — drop whichever is no longer read independently.
- [ ] Confirm no singleton subscription auth endpoint, client state, or onboarding card remains (covers the three Phase 1 migration items).
