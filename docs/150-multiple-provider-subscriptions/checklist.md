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
- [x] Serialize concurrent per-provider sign-ins: start refuses (409) while another row owns the flow, cancel only kills the owning row's process, and a pasted code is rejected on a row that doesn't own the challenge.
- [x] Scope the runtime-401 heal to the turn's account (`resolveTurnAccountId`), so a revoked sibling account can't make a healthy account's turn look unhealable.
- [x] Reuse the account-row flow in onboarding instead of singleton Claude/Codex auth cards.
- [x] Move Claude and Codex Platform API-key inputs into separate collapsed fallback sections with explicit metered-billing copy.
- [x] Migrate singleton Claude/Codex login, code, and cancel callers to provider-account endpoints (sign-*out* stays provider-wide by design).
- [x] Remove singleton subscription auth endpoints and provider-wide pending client state after caller migration.
- [x] Block disconnect while an account is pinned to a running session unless replacement is selected.
- [x] Implement account-switch runtime transition for pinned sessions: kill process, reprovision while preserving conversation-state subpaths, keep `agentSessionId`, resume (req 9).
- [x] Hydrate persisted provider route for detached/system-turn runner recreation.
- [x] Route child-session first turns through the normal account router (req 18).
- [ ] Route child follow-up turns through persisted agent and provider route, not default agent fallback.
- [x] Offer a replacement account inline when disconnecting an account that pinned sessions use.
- [x] Do NOT route around model capability — removed the skip-and-report mechanism (req 17 reversed to a non-goal, 2026-08-02).
- [ ] Add local/dogfood direct-run account-scoped HOME/config-root support or explicit unsupported diagnostic.
- [x] Scope AI session naming to an account: it resolves the same route a turn would take and points `HOME` at that account's root (it forced `/root`, which aliases to the migrated default), and heals that account rather than the whole provider.

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
- [x] Return `all_exhausted` / `auth_required` as distinct results from the router (`no_model_eligible_account` removed with req 17's reversal).
- [x] Surface those states to the user on a blocked turn (req 13's message).
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
- [x] Route brokered one-shot runs (`shipit agent run`) through structured account selection and one bounded hard-exhaustion fallback (req 20).

## Phase 4 — Policy Controls

- [x] Persist a user-controlled priority order for authenticated accounts per provider (`ProviderAccount.priority`, ascending; legacy rows without one keep primary-then-stored order).
- [x] Widen `selectRouteForTurn` into `selectAccountForTurn` with structured failures (`all_exhausted` / `auth_required`), which req 13 depends on.
- [x] Add Settings controls to reorder provider accounts; newly connected accounts append to the fallback order. (Fixed: the controls wrote `priority` but every wire path returned raw storage order, so the rows never moved — `list()` is now the ordered accessor.)
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
- [x] Unit: one-shot reviews proactively select a healthy account, retry once after hard exhaustion, and do not retry model-access errors.
- [x] Integration: switching a pinned session kills the persistent agent, reprovisions credentials, preserves `.claude/projects` / `.codex/sessions` and `agentSessionId`, and resumes the same conversation.
- [ ] Integration: detached system turns recreate runners from persisted agent/provider route.
- [ ] Integration: answer-question and rebase/conflict direct `agent.run` paths use provider preflight.
- [x] Client: Settings renders multiple accounts and primary selection.
- [x] Client: account-scoped sign-in renders its authorization controls on the owning row and submits through the scoped endpoint.
- [x] Client: render the migrated primary/default Claude subscription through the same account-row auth flow as secondary Claude subscriptions.
- [x] Client: render the migrated primary/default Codex subscription through the same account-row device-auth flow as secondary Codex subscriptions.
- [x] Client: share the account-row auth shell across Claude code-paste and Codex device-code challenge variants.
- [x] Client: onboarding renders the same per-account connect surface as Settings, with no singleton card.
- [x] Integration: the retired singleton subscription auth endpoints 404.
- [x] Integration: the Codex device flow runs end to end through the account-scoped login route, asserting `accountId` on pending/complete/failed.
- [x] Client: onboarding's connect button hits the account-scoped endpoints, never a singleton one.
- [x] Client: onboarding renders the card `compact` (no between-accounts explainer) so the fixed-height pane keeps "Get Started" above the fold.
- [x] Manual: first-run onboarding in the dogfood preview — add account, challenge lands on its own row, cancel flips that row to `auth failed`.
- [x] Unit: both OAuth refreshers name the revoked account on `agent_auth_failed`.
- [x] Unit: a second concurrent sign-in is refused, cancel spares another row's flow, and a code is rejected on a non-owning row.
- [x] Integration: the runtime-401 heal names the turn's account, not the provider.
- [x] Integration: a reserved-route turn is not healed off other accounts' tokens.
- [x] Integration: a second concurrent sign-in is 409 with the blocking row named, and cancel frees the provider.
- [x] Unit: cancel / delete / failed-spawn all release the provider's login scope.
- [x] Integration: provider-wide sign-out is refused mid-turn (409) and allowed once idle.
- [x] Unit: `list()` — the accessor every wire path reads — reflects the user's order, not storage order.
- [x] Integration: `PUT /order` changes the order in its own response and in a later `GET`.
- [x] Manual: reorder buttons move rows in the preview, the primary badge follows, and the order survives a reload.
- [x] Unit: the backfill records the order legacy rows already resolved to, and is idempotent.
- [x] Unit: `isPrimary` is derived from position — a poisoned stored flag is ignored, and every accessor agrees.
- [x] Manual: make-primary in the running app renumbers `priority`, moves the badge, and disables its own button.
- [x] Unit: a completion with no account scope marks nothing ready and invents no row (the old singleton branch re-ran the migration here).
- [x] Manual: a scoped sign-in still reaches its own row with the challenge after the contract was tightened.
- [x] Unit: naming runs the CLI with `HOME` at the account root, and falls back to the singleton root for a reserved route.
- [x] Unit: graduation resolves the naming account from the router and heals that account, not the provider.
- [x] Client: Add account / Connect are disabled while another row of the provider is authenticating.
- [ ] Unit: API-key fallback configures only its reserved route and never marks a subscription account ready.
- [x] Client: an authenticated primary row does not hide or overwrite a secondary row's pending flow or diagnostics.
- [x] Client: subscription limits render multiple accounts per provider, each named.
- [ ] Client: session diagnostics renders the active account.
- [x] Unit: boot retires a legacy alias that points into `provider-accounts/`, leaves a real empty dir behind for the directory-shaped ones, and does not touch a real (pre-migration) file or dir.
- [x] Unit: boot-to-boot idempotence — a never-signed-in install gets no placeholder and no invented account across two boots; a migrated install keeps its placeholder but does not re-migrate it once every account is deleted; CLI config and a zero-byte credentials file are not mistaken for an account.
- [x] Integration: provider-wide sign-out erases the on-disk credentials of every connected account, not just the migrated first one.
- [x] Unit: transcript cleanup reads the OAuth bearer from the account root it was given, and stays unscoped for a reserved route.
- [x] Unit: each account's plan label is read from that account's credentials.

## Phase 5 — Legacy Removal (req 19)

Runs last: every shim below is load-bearing for an install that has not yet
exercised the new path. The signal one is ready to go is that nothing reads it.

- [x] Remove the legacy root credential paths and alias symlinks once every read/write goes through an account root. Migration no longer creates them, and `migrateDefaultAccounts` retires any left by an earlier boot — only symlinks pointing into `provider-accounts/` are touched, and a directory-shaped one is replaced by a real empty dir because `/root/.claude` is an image-level symlink to it and `mkdir` through a *dangling* link fails EEXIST.
  - [x] AI session naming (was `HOME=/root`).
  - [x] `AgentRegistry`'s auth probe — the registry never calls `isConfigured()` unscoped; `checkClaudeAuth`/`checkCodexAuth` are wired to `hasAnyAuthForProvider` at the DI boundary. The one surviving `isConfigured()` caller passes `{ credentialDir }`.
  - [x] Codex `checkCredentials()` — a no-arg call during a scoped flow resolves through `activeCredentialDir`, so the login close-handler reads the account's `auth.json`. Unscoped only when no flow is active, which is the pre-account case.
  - [x] Provider-wide sign-out clears singleton paths (deliberately, for pre-account credentials) *and* now walks every account row via `signOutProvider`.
- [x] Follow the aliases out of the readers that were quietly leaning on them. Both read a *real* account root now, resolved the same way session naming resolves one:
  - [x] Voice transcript cleanup (`pickCleanupProvider`) — the unscoped `getAccessToken()` would have dropped every migrated install to the OpenAI fallback, or to no cleanup provider at all.
  - [x] The Claude limits pill's plan label (`ClaudeLimitsProvider.fetch`) — stayed unscoped when `doRefresh` was fixed, so it labelled every account with the migrated default's plan, and with nothing once the aliases went.
  - [x] Startup credential logging asks the account manager, not the singleton path, so a multi-account install no longer boots claiming "no credentials found".
- [x] Give provider-wide sign-out the running-turn guard the per-account disconnect has. (An *idle* pinned session is deliberately left to re-route itself: a route whose row is gone reads unusable, so the next turn's preflight fails it over. Only the mid-turn case is unrecoverable.)
- [x] Drop `AgentAuthManager.start`'s no-scope overload and the account-less `complete` branch in `wireEventHandlers`. `accountId`/`credentialDir` are now required, so an unscoped flow is unrepresentable rather than merely unused.
- [x] ~~Remove `selectRouteForTurn`~~ — **not legacy after all.** It is a three-line convenience over `selectAccountForTurn` with two honest callers that genuinely want route-or-null (rate-limit attribution, sub-agent spawn). Removing it would inline the same wrapper twice.
- [x] Backfill `priority` onto stored rows (idempotent, runs from `migrateDefaultAccounts`), then drop the `isPrimary`-only ordering fallback from the read path.
- [x] Resolve `ProviderAccount.isPrimary` vs `priority` — `isPrimary` is derived from position on read and no longer persisted or maintained by the credential store. The wire shape is unchanged.
- [x] Confirm no singleton subscription auth endpoint, client state, or onboarding card remains (covers the three Phase 1 migration items).
