# 150 — Multiple provider subscriptions checklist

## Phase 0 — Research and Preconditions

- [ ] Confirm stable provider account identity fields for Claude.
- [x] Confirm stable provider account identity fields for Codex.
- [ ] Verify provider terms for automatic failover among user-owned subscriptions.
- [ ] Decide child-session inheritance policy for provider routes.
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
- [x] Extend token sync-in/sync-back to account-qualified credential paths.
- [x] Skip token sync for `claude-env-oauth` reserved route.
- [x] Account-qualify token re-push helper so account X does not update account Y sessions.
- [x] Persist selected provider route when a session is first pinned.
- [ ] Make Claude auth manager account-scoped for starting/checking/signing out specific accounts.
- [ ] Make Codex auth manager account-scoped for starting/checking/signing out specific accounts.
- [ ] Force auth subprocesses to write to an account-specific HOME/config root.
- [ ] Add account-qualified auth pending/complete/failed SSE events.
- [ ] Add Settings endpoints/services for list, create, rename, make primary, and disconnect provider accounts.
- [ ] Render provider account management in Settings.
- [ ] Block disconnect while an account is pinned to a running session unless replacement is selected.
- [ ] Implement account-switch runtime transition for pinned sessions: kill process, clear `agentSessionId`, reprovision, replay from local context.
- [ ] Hydrate persisted provider route for detached/system-turn runner recreation.
- [ ] Route child-session first turns through account selection or inheritance.
- [ ] Route child follow-up turns through persisted agent and provider route, not default agent fallback.
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
- [ ] Render header subscription limits by provider account.
- [ ] Keep the 1-account badge layout visually stable.
- [ ] Render multi-account grouped/expanded quota state without layout overlap.
- [ ] Render active provider account in session diagnostics.
- [ ] Skip known-exhausted accounts for new turns.
- [ ] Surface `all_exhausted`, `auth_required`, and `no_model_eligible_account` as distinct recoverable states.
- [ ] Persist delayed quota turns with staged attachments and wake-up time.
- [ ] Restore delayed quota turns and timers after orchestrator restart.
- [ ] Allow delayed turns to be cancelled or replaced from chat.

## Phase 3 — Automatic Failover

- [ ] Track per-turn side effects on the runner.
- [ ] Maintain a read-only tool allowlist for safe retry classification.
- [ ] Detect hard quota exhaustion from Claude quota/runtime failures.
- [ ] Detect hard quota exhaustion from Codex usage events/runtime failures.
- [ ] Retry once on the next eligible account when exhaustion occurs before side effects.
- [ ] Avoid duplicating user chat history during same-turn retry.
- [ ] Clear or replace failed in-progress assistant output during retry.
- [ ] Record failover as a chat-visible system event attached to the original turn.
- [ ] Stop and ask for user intent when exhaustion happens after side effects.
- [ ] Reset provider-side resume state when switching accounts.
- [ ] Rebuild replay context from ShipIt history and workspace state after account switch.
- [ ] Ensure all turn entrypoints use shared provider-account preflight: chat, answer-question, system turns, CI auto-fix, child sessions, and rebase/conflict recovery.

## Phase 4 — Policy Controls

- [ ] Add optional per-session account preference.
- [ ] Add optional per-provider “do not auto-failover” setting.
- [ ] Add optional provider-profile label refresh where stable.
- [ ] Add account billing/account links as overflow escape hatches only.

## Tests

- [x] Unit: provider-account migration creates default accounts.
- [x] Unit: provider-account route selection prefers stored primary before API-key fallback.
- [x] Unit: session manager persists provider route kind/id.
- [x] Unit: session credentials provision only the selected provider-account subtree.
- [x] Unit: account-qualified sync-in/sync-back writes only the matching account source.
- [ ] Unit: account-scoped Claude auth manager writes to the requested account root.
- [ ] Unit: account-scoped Codex auth manager writes to the requested account root.
- [ ] Unit: account selection prefers primary, skips exhausted accounts, respects reset times, and ranks quota.
- [ ] Integration: first Claude turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: first Codex turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [ ] Integration: auth-complete for account X re-pushes only to sessions pinned to account X.
- [ ] Integration: exhausted primary starts a new turn on a secondary account.
- [ ] Integration: all-exhausted state delays one active prompt and holds the in-memory queue.
- [ ] Integration: mid-turn exhaustion before side effects retries on secondary once.
- [ ] Integration: mid-turn exhaustion after side effects asks for confirmation and does not auto-retry.
- [ ] Integration: switching a pinned session kills the persistent agent, clears `agentSessionId`, and reprovisions credentials.
- [ ] Integration: detached system turns recreate runners from persisted agent/provider route.
- [ ] Integration: answer-question and rebase/conflict direct `agent.run` paths use provider preflight.
- [ ] Client: Settings renders multiple accounts and primary selection.
- [ ] Client: subscription limits render multiple accounts per provider.
- [ ] Client: session diagnostics renders the active account.
