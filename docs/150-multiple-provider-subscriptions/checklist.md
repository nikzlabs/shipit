# 150 — Multiple provider subscriptions checklist

## Phase 0 — Research and Preconditions

- [x] Confirm stable provider account identity fields for Claude — `.claude.json`'s `oauthAccount` (`accountUuid` as the stable key, `emailAddress` as the default label). Not `.credentials.json`, which carries only plan data (req 22).
- [x] Confirm stable provider account identity fields for Codex.
- [x] Decide default failover posture — on by default for every provider (req 15).
- [x] Decide child-session inheritance policy for provider routes — normal priority order, no inheritance (req 18).
- [x] Decide whether concurrent turns should spread across accounts or keep primary affinity — neither is fixed; the user picks per provider, defaulting to strict priority (req 21).

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
- [x] Key Claude CLI auth *diagnostics* by account id too. `claudeAuthDiagnostics` is now `Record<accountId, …>` and each row renders its own buffer. Hardening, not a bug fix: the SSE payloads already carried `accountId`, the store cleared on every `attemptId` change, and `startAccountAuth` refuses a second concurrent per-provider sign-in (409) — so only one row could ever be mid-challenge. The scoping now lives in the data instead of depending on that guard. An unscoped payload is dropped rather than pooled (no sign-in flow is unscoped since Phase 5).
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
- [x] Route child follow-up turns through the persisted agent, not the default-agent fallback. The *route* half of this item was never broken — the provider route is read from the session record inside `prepareSessionAgentEnvironment`, so it cannot go stale. The agent half was: `getOrCreate` applies its agentId argument only when it *constructs* a runner, so a runner seeded with the global default by container rescue or the warm pool was returned as-is and used for the turn (`reconcile-runner-agent.ts`).
- [x] Offer a replacement account inline when disconnecting an account that pinned sessions use.
- [x] Do NOT route around model capability — removed the skip-and-report mechanism (req 17 reversed to a non-goal, 2026-08-02).
- [x] Add local/dogfood direct-run account-scoped HOME/config-root support. Took the real fix, not the diagnostic: the local agent factory now takes a per-spawn `AgentHomeResolver`, and each in-process runner's `createAgent` binds it to `resolveLocalAgentHome`, which resolves the session's pinned account to `provider-accounts/<provider>/<accountId>` — the same root the auth and refresh subprocesses already use. Both adapters honour it (Claude's `HOME`, Codex's `HOME` + `CODEX_HOME`), and a scoped spawn also drops the env credentials that would otherwise beat the on-disk ones (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; `OPENAI_API_KEY` for Codex, req 12). Containerized mode is untouched — no resolver, so `agentHome()` resolves exactly as before. Residual, in plan.md: local mode interposes no per-session copy, so a mid-session switch does not carry the CLI-side conversation file to the new account root.
- [x] Scope AI session naming to an account: it resolves the same route a turn would take and points `HOME` at that account's root (it forced `/root`, which aliases to the migrated default), and heals that account rather than the whole provider.

## Phase 2 — Inline Quota Per Account

- [x] Change `SubscriptionLimitsMap` wire shape to provider -> account-or-route -> limits.
- [x] Update `LimitsPoller` cache, state, delta detection, and SSE broadcast for account-keyed snapshots.
- [x] Poll Claude quota per stored Claude provider account.
- [x] Preserve `claude-env-oauth` as a quota-bearing reserved route keyed by `claude-env-oauth`.
- [x] Associate Codex `agent_rate_limits` events with the account used by the current runner.
- [x] ~~Persist quota snapshots and plan labels onto provider accounts where appropriate.~~ **Struck 2026-08-04 — the answer to "where appropriate" is nowhere.** `quota` was never added to the shipped type; `plan` was, and had zero writers and zero readers (the pill's plan label comes from the live per-account snapshot, fixed in Phase 5) — so it has been removed. The one quota fact that must outlive a restart already persists as `exhaustedUntil`, a scalar that expires on its own. What is left is a cold-start pill reading `—`, and an honest `—` beats a stored reading of unknown age — the more so because `isOverCutoff` does not check whether a window's reset has elapsed, so a restored pre-rollover 95% would bench a freshly reset account with no clock to clear it. See plan.md → "Struck: persisting quota snapshots onto accounts".
- [x] ~~Compute Claude model-specific quota state using `weeklyOpus`, `weeklySonnet`, or `weekly`.~~ **Struck 2026-08-03 — mistaken twice over.** Those field names exist nowhere; the CLI's real sub-quota types are `seven_day_opus` / `seven_day_sonnet` (`claude-types.ts:340`), and they are deliberately dropped (`adapter.ts:329`, docs/135). Acting on them means model-aware routing, which req 17's reversal made a non-goal. See plan.md → "Struck: model-specific quota windows".
- [x] Treat unknown quota as selectable (ranking below known-healthy quota is still open).
- [x] Render header subscription limits as one existing-style pill per account, labelled with the account name (req 10).
- [x] Keep the 1-account badge layout visually stable.
- [x] Reclassify "monthly usage limit" only when *every* connected account is exhausted, reporting the soonest reset.
- [x] Render multi-account grouped/expanded quota state without layout overlap. A real defect, reproduced in the running app: three email-labelled accounts at 900px drew the first pill over the ShipIt wordmark and pushed the settings icons off-screen; at 640px the labels vanished entirely. Fixed in three places (the status group and the pills can now shrink, the logo reserves its own width), with the pill label truncating rather than the row overflowing. Below the width where named pills still fit, the whole status group collapses into the existing gauge dropdown — inline from `sm` for one pill, `md` for two, `lg` for three or more. See plan.md → "Fixed: three subscription pills did not fit the header".
- [x] Say *why* a session moved accounts. Not originally on this list: the notice read "X is out of quota" for every move, including a move at the user's configured cutoff (req 6 — the account still has quota) and a session stranded by a disconnect (req 23 — it never ran out of anything). `classifyRouteForTurn` now returns the reason `isRouteUsableForTurn` was discarding, and `failoverNotice` words the three cases differently. See plan.md → "Fixed: a cutoff-driven move said 'out of quota'".
- [x] Render active provider account in session diagnostics. Threaded through the diagnostics payload (`services/diagnostics.ts` → `describeProviderRoute`) rather than the session bootstrap: the panel already polls that endpoint, and the resolution — account label, reserved-route copy, or "not pinned yet" — is one pure function to test.
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
- [x] Route brokered one-shot runs (`shipit agent run`) through structured account selection and bounded hard-exhaustion fallback across every eligible subscription account (req 20).

## Phase 4 — Policy Controls

- [x] Persist a user-controlled priority order for authenticated accounts per provider (`ProviderAccount.priority`, ascending; legacy rows without one keep primary-then-stored order).
- [x] Widen `selectRouteForTurn` into `selectAccountForTurn` with structured failures (`all_exhausted` / `auth_required`), which req 13 depends on.
- [x] Add Settings controls to reorder provider accounts; newly connected accounts append to the fallback order. (Fixed: the controls wrote `priority` but every wire path returned raw storage order, so the rows never moved — `list()` is now the ordered accessor.)
- [x] Persist per-provider short-window and weekly usage cutoffs with 90% defaults and 1–100 validation.
- [x] Add Settings controls for both proactive failover cutoffs.
- [x] Re-evaluate account eligibility before every turn, including existing-session, queued, and system-initiated turns.
- [x] Switch an existing session to the next eligible account when either configured cutoff is reached.
- [x] Leave a model-ineligible account in place and let the provider's error surface, with no automatic recovery (req 17, reversed to a non-goal).
All four "optional" items below are resolved as **non-goals**, 2026-08-03 —
reasoning in plan.md → "Resolved: the four 'optional' Phase 4 items". Common
thread: no requirement asks for any of them, and requirements are the human's to
write. Each would start at `requirements.md` if wanted.

- [x] ~~Add optional per-session account preference.~~ Non-goal — a fourth input to a route decision reqs 3/9/6/14 already settle, asked for by nothing.
- [x] ~~Add optional per-provider "do not auto-failover" setting.~~ Non-goal — it *is* the separate opt-in req 15 forbids. Req 21's selection mode is the sanctioned control over account choice.
- [x] ~~Add optional provider-profile label refresh where stable.~~ Subsumed by req 22: the label comes from the provider at connect, and `labelIsGenerated` records whose name it is. A periodic refresh would rename rows behind the user's back.
- [x] ~~Add account billing/account links as overflow escape hatches only.~~ Non-goal — `CLAUDE.md` §3 permits such links but nothing requires them, and req 10 exists so quota never needs the provider dashboard.

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
- [x] Integration: an existing pinned session switches accounts at the proactive cutoff and preserves local context (`provider-route-pinning.test.ts`) — through the real env-prep, including the user-lowered cutoff, the no-churn case when every account is over its cutoff, a Codex rollout, and the persisted req-11 notice.
- [x] Integration: first Claude turn pins `{ agent_id, provider_route_kind, provider_route_id }` (`provider-route-pinning.test.ts`, against the real account manager + credential store + SQLite session manager).
- [x] Integration: first Codex turn pins `{ agent_id, provider_route_kind, provider_route_id }`.
- [x] Integration: auth-complete for account X re-pushes only to sessions pinned to account X (`claude-auth.test.ts`) — driven through `buildApp`'s own `wireEventHandlers` by emitting the real `complete`, asserting both directions on real per-session token files.
- [x] Unit: a turn the provider kills for quota benches its account, and the stamp survives a restart and expires on its own.
- [x] Integration: exhausted primary starts a new turn on a secondary account; a pinned session does not drift onto a newer account.
- [x] Unit: all-exhausted fails the turn with the earliest reset time, pins nothing, and provisions no credentials.
- [x] Integration: all-exhausted fails the turn with the *earliest* reset time, pins nothing, and provisions no credential subtree. ("Schedules no timer" has nothing to assert against — req 13's resolution removed the delayed-turn timer rather than leaving one to check.)
- [x] Integration: mid-turn exhaustion retries on secondary once, including after file edits or commands.
- [x] Unit: one-shot reviews proactively select a healthy account, retry once after hard exhaustion, and do not retry model-access errors.
- [x] Integration: switching a pinned session kills the persistent agent, reprovisions credentials, preserves `.claude/projects` / `.codex/sessions` and `agentSessionId`, and resumes the same conversation.
- [x] Integration: detached system turns recreate runners from persisted agent/provider route (`provider-route-pinning.test.ts`) — a wake turn over a runner seeded with the global default, and over a disposed one; the route half is asserted by which account the turn stamps.
- [x] Integration: answer-question and rebase/conflict `agent.run` paths use provider preflight (`ask-user-question.test.ts`, `rebase-flow.test.ts`) — with every account exhausted, both turns are *stopped* with req 13's message and no CLI receives the prompt. Both reach the preflight through the shared executor (`runAgentWithMessage` / `runner.dispatch`); neither hand-rolls a spawn any more.
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
- [x] Unit: API-key fallback configures only its reserved route, creates no account row, is outranked by a subscription, and is *not* rolled onto when the subscription is spent (req 12).
- [x] Client: an authenticated primary row does not hide or overwrite a secondary row's pending flow or diagnostics.
- [x] Client: subscription limits render multiple accounts per provider, each named.
- [x] Client: session diagnostics renders the active account — by name, with the opaque route id alongside for bug reports, and with the reserved-route and not-yet-pinned cases each asserted separately.
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

## Phase 6 — Account identity and selection mode (reqs 21, 22)

Both come from the 2026-08-03 answers to the two open Phase 0 questions. Neither
is a refinement of an existing mechanism: 22 adds a fact about an account that
nothing records today, and 21 turns a decision nobody made into a user setting.

### Account identity (req 22)

- [x] Read `oauthAccount` from `.claude.json` on connect; store `accountUuid` as the stable external key and tolerate its absence (older CLI, env-only auth) by falling back to today's behavior (`provider-account-identity.ts`).
- [x] Record the Codex equivalent (`chatgpt_account_id`) on the account row too — it is already decoded for plan extraction but never persisted as identity (`extractCodexIdentity`).
- [x] Default a newly connected account's label to the reported email instead of `Claude account N` / `Codex account N`, leaving rename intact. `labelIsGenerated` is what tells the two apart; `rename` clears it, and a row predating the field is treated as user-owned (overwriting a deliberate label is the unrecoverable direction).
- [x] Refuse a connect that resolves to an already-connected external id, naming the matched account. Leave the existing row's credentials untouched (decided 2026-08-03). The refusal fires on the auth manager's `complete` event, before the row is marked `ready` — once it is `ready` it is selectable, and a duplicate is worst exactly when it is picked as the failover target for the account it duplicates.
- [x] Confirm a failed/stale row can still re-authenticate through its own per-account action — refusal means re-connecting via "add account" is no longer a repair path. Confirmed: the row's own Connect/Reconnect button posts `.../${account.id}/login` (`ProviderAccountsCard.tsx:564` → `startLogin`), and `findByExternalId` excludes the row being authenticated, so a self-match is not a duplicate.
- [x] Unit: an account row records the external id at connect time, and a missing `oauthAccount` degrades to the generated label rather than failing the connect.
- [x] Unit: a second connect resolving to an existing external id does not produce a second row.
- [x] Unit: the refusal is reached from the real `complete` event, emits `reason: "duplicate"`, and emits no `agent_auth_complete` (`app-lifecycle.test.ts`).

### Selection mode (req 21)

- [x] Persist a per-provider selection mode (`strict` | `balanced`), defaulting to `strict`, alongside the existing per-provider cutoffs.
- [x] Branch `selectAccountForTurn` on the mode: `strict` keeps today's first-eligible walk; `balanced` picks the least-recently-used eligible account via `lastUsedAt`.
- [x] **Write `lastUsedAt`.** The field existed on `ProviderAccount` from the start but nothing ever set it, so an LRU order over it would have been a no-op sort over `undefined`. `markAccountUsed` stamps the account a turn resolves onto, from env-prep.
- [x] Make the stamp strictly monotonic across a provider's accounts. `Date.now()` is millisecond-granular, so sessions pinning in the same millisecond tied and the tie-break handed the whole burst to one account — losing the burst-safety that motivated LRU over quota-ranking.
- [x] Add the Settings control beside the two cutoff inputs, wording the choice in terms of unequal vs peer accounts.
- [x] Unit: `balanced` spreads consecutive pins across eligible accounts; `strict` pins them all to the highest-ranked one.
- [x] Unit: both modes fail over identically on exhaustion and honour the retry exclusion list (req 15 — the mode does not gate failover).
- [x] Unit: `balanced` still skips exhausted and over-cutoff accounts rather than balancing onto them.
- [x] Unit: an unrecognized stored mode falls back to `strict` rather than reaching the routing path.
- [x] Unit: the mode changes what a newly created session pins, and a session already pinned is not re-routed (asserted at `prepareSessionAgentEnvironment`, which is the pin point).

## Local-mode account scoping (req 19 residuals)

- [x] Unit: `resolveLocalAgentHome` maps a pinned session to its account root, gives two sessions on different accounts different roots, keeps the process-global home for a reserved route, and resolves a cross-provider sub-agent spawn through the provider's own selection.
- [x] Unit: a local runner's `createAgent` resolves the session's own account root, and re-reads it per spawn so a mid-session failover is picked up.
- [x] Unit: containerized/worker spawns are unchanged — with no resolver, Claude keeps `agentHome()` and Codex leaves `HOME`/`CODEX_HOME` as inherited.
- [x] Unit: a scoped Claude spawn drops `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, and an unscoped one keeps them (they are a reserved route's auth).
- [x] Unit: a scoped Codex spawn probes the account root's own `auth.json` and refuses to fall back to `OPENAI_API_KEY` (req 12).
- [x] Client: one Claude row's CLI diagnostics do not render on another row, and two accounts' buffers stay apart.

## Req 23 — the last account is always disconnectable

Came directly as a requirement on 2026-08-03, from hitting the refusal in the UI
("2 session(s) are pinned to this account and there is no other connected claude
account to move them to").

- [x] Drop the no-replacement refusal in `deleteProviderAccount`: with nothing usable to move pinned sessions to, disconnect proceeds and returns them as `strandedSessionIds`.
- [x] Leave the stranded sessions' `provider_route_id` pointing at the gone account rather than rewriting it — the same state provider-wide sign-out leaves, recovered by `isRouteUsableForTurn` on the next turn.
- [x] Keep the running-turn refusal (user's choice over a mid-turn 401 or aborting live turns), but name the sessions in it so it reads as a wait.
- [x] Report the consequence in the card: a toast naming how many sessions now have no connected account.
- [x] Unit: the last account disconnects with sessions pinned to it, reports them, and leaves the route dangling-but-unusable.
- [x] Unit: an unconnected sibling account is not a replacement, so that case disconnects too.
- [x] Unit: a usable replacement still produces the picker refusal rather than stranding.
- [x] Unit: a running pinned session on the last account still refuses, naming the session.
- [x] Client: the last-account disconnect shows no replacement picker and toasts the stranded count.
- [x] **Actually take the account away from the stranded sessions**, not just delete the row: retire any resident agent process and `revokeSessionProviderCredentials` their per-session credential subtree (conversation state preserved). Caught by cross-agent review — the first version left a working OAuth token on disk for every "disconnected" session, since first-turn provisioning never re-runs and only a switch overwrites the copy.
- [x] Unit: the per-session token file is gone and the resident agent is killed and cleared after a last-account disconnect.
- [x] Unit: the resume files survive the revoke (req 9 — a disconnect is not a reason to end the conversation).
- [x] Integration: `DELETE /api/provider-accounts/...` on the last account returns 200 with `strandedSessionIds` (this test previously asserted the 409), and a mid-turn pinned session still gets a 409 naming the session.
- [x] Follow-up, not req 23: provider-wide sign-out (`signOutProvider`) has the same per-session-copy gap — it erases source credentials only. Filed as [SHI-283](https://linear.app/shipit-ai/issue/SHI-283); the fix belongs to that issue, not this branch.
- [x] SHI-283 landed: both sign-out routes go through the service-layer `signOutProvider` (guard → retire agent → revoke per-session copy → drop rows), sharing `retireSessionProviderAccount` with the disconnect path. Scoped to `account`-route sessions on an account being signed out (reserved routes untouched, archived sessions included).
- [x] Unit (`services/provider-signout.test.ts`): per-session copies revoked, resident agent retired, conversation state preserved, reserved/other-provider/dangling routes untouched, archived included, mid-turn refusal revokes nothing.
- [x] Integration: the sign-out test that encoded the leak now asserts the per-session token is gone, the resume file survives, and the dangling pin is still left in place.

## Post-ship fix — the limit notice that arrived as assistant text (2026-08-06)

Production incident on session `174b5d98`: the Claude CLI hit its session limit
~2 minutes into a turn, reported it as an ordinary assistant message, and ended
the turn `subtype: "success"`. No failover, no exhaustion stamp, no quota retry
— and the notice became the auto-commit subject, with a healthy second account
sitting idle.

- [x] Widen `EXHAUSTION_PATTERNS`: add `session` to the window alternation and make `usage` optional — the CLI now says "You've hit your session limit", which none of the five patterns matched.
- [x] Stop gating detection solely on `agent_result.error`: fall through to the turn's final assistant text (`detectHardExhaustionInTurnText`) at all three sites — the req-7 stamp (`agent-listeners.ts`), the req-14 quota retry (`turn-executor.ts`), and the one-shot consult fallback (`services/sub-agent.ts`).
- [x] Give the text channel its own anchored notice grammar rather than reusing `EXHAUSTION_PATTERNS`, bounded to a notice-length message (`MAX_LIMIT_NOTICE_CHARS`). Caught by cross-agent review: the length bound alone let "The Vercel deploy failed because your account is out of credits" (85 chars) bench a healthy Claude subscription and repeat the turn.
- [x] Promote a text-detected exhaustion to a failed turn (`status: "error"` + the notice as `error`) where the two channels meet, so `lastTurnErrored`, the transcript error row and `shipit session wait` all keep working off `error` alone. Also caught by review: without it, an exhaustion with no account left to fail over to retires as a success — the original incident, one hop along. Same promotion at the end of the one-shot consult's fallback loop.
- [x] Check the error channel *instead of* the text channel, not with a nullish fallthrough, so a non-quota failure ending on notice-shaped output cannot bench an account (the sub-agent path had the fallthrough).
- [x] Parse the CLI's wall-clock reset form (`resets 5:10pm (UTC)`) to the next occurrence of that clock time, gated on an explicit UTC marker with no offset suffix (`UTC+02:00` is not UTC — review catch); unzoned clock times still take the 15-minute fallback.
- [x] Unit (`agent-rate-limits.test.ts`): the verbatim incident string on both channels, the with/without-`usage` wordings, the wall-clock parse (incl. 12am/12pm, next-occurrence, offset-suffix rejection), and the negatives — notice-shaped phrases something else introduces, long prose mentioning quota, ordinary summaries, unzoned clock times.
- [x] Unit (`agent-listeners.test.ts`): a success-subtype turn whose assistant text is the notice benches the account and ends errored; an ordinary success turn does neither.
- [x] Integration (`quota-exhaustion-retry.test.ts`): the same shape re-runs the turn on a fresh agent and does not commit the exhausted attempt; a retry that also exhausts in text ends errored rather than successful; a success turn whose text merely mentions limits still ends as one successful turn.
- [x] Unit (`sub-agent.test.ts`): a consult whose final text is the notice benches and retries on the next subscription; with no account left it fails rather than returning the notice as its answer; a non-quota error alongside notice-shaped text benches nothing.
