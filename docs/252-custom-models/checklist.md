---
issue: planning#321
title: Custom models — implementation checklist
description: Per-phase build steps for docs/252. All nine phases are done.
---

# 252 — Custom models: checklist

The design is [`plan.md`](./plan.md); the contract is
[`requirements.md`](./requirements.md). One section per phase in that plan's
table — a phase is checked off when its PR has merged.

## Phase 1 — Catalogue and identities

- [x] `shared/catalogue/` — types, harnesses, services, derived view
- [x] Launch rows for req 15's set, with real prices and context windows
- [x] `ModelSelection` triple through types, persistence and the picker's plumbing
- [x] Migrate the three persisted selections (session, `vibe-model-id`, sub-agent defaults)
- [x] Catalogue invariants under test

## Phase 2 — Credentials and Settings

- [x] `CredentialRoute` — credential storage keyed by `(service, billing mode)`
- [x] Several credential instances per string-delivered subscription (req 12)
- [x] Per-instance secret storage, with no secret on the returned record
- [x] `ProviderAccount` becomes a projection over routes (phase 3 deletes it)
- [x] Compile-time env-key name per `(service, billing mode)`, driving `ALLOWED_ENV_KEYS`
- [x] `/api/credential-routes` CRUD + reorder, with the catalogue's rules enforced server-side
- [x] Settings → Services add-flow (service → billing mode → credential)
- [x] Re-key `accountSelectionMode` / `failoverCutoffs` to `(service, mode)`
- [x] Close the compose delivery gap, and propagate a credential change to live sessions
- [x] One writer per credential — `setApiKey` and `set_agent_env` write through
- [x] Onboarding still connects a credential and reaches a runnable model
- [x] Cross-backend review, findings applied (see `plan.md`)
- [ ] GLM's `zai-plan-usage` quota reader — tracked as **planning#339**. **Unblocked by
      phase 6** — a provider now declares its own `(serviceId, billingMode)` and the registry
      indexes on it, so this is an addition rather than a change. Req 15 stays unmet on
      quota until it lands.

## Phase 5 — Credential-failure policy

- [x] `credential-failure-policy.ts` — req 12's branch, asked by every gate
- [x] The `auth_required` handler stops a key-authenticated turn instead of entering
      vendor re-auth: no token heal, no refresher nudge, no "sign in" copy
- [x] The same-turn quota retry gated on the billing mode, as account benching already was
- [x] Codex coverage established and closed — a `turn/start` quota rejection arrives as an
      adapter `error`, which neither the retry nor the exhaustion stamp watched
- [x] Benching widened to a string-delivered subscription credential; a metered key refused
- [x] Which of a subscription's string credentials a turn takes — order, selection mode,
      benched skipped, `all_exhausted` when none is left
- [x] An already-pinned session moves off a spent credential and the move is **persisted**
      (which phase 3's stale-route drop asserted and did not do)
- [x] Per-credential env delivery, so the credential a turn authenticates with is the one
      it is attributed to
- [x] Routing controls for a **string-backed** subscription group — the selection mode, on
      the card. Carried from phase 2.
- [x] Cross-backend review, findings applied (see `plan.md`)
- [ ] **Failover cutoffs** for a string-backed subscription. A cutoff is a percentage of a
      reported quota and nothing reports one for these credentials until phase 6 builds
      `zai-plan-usage`, so the control would be inert. Belongs with the quota reader
      (**planning#339**), not with failover.

## Phase 3 — Spawn shaping and eligibility

- [x] Base URL + credential at both Claude spawn sites, after the scrub
- [x] Codex pointed at a service through a written `model_providers` block
- [x] The resolver as a callable component (`service-routing.ts`), for phase 7's second caller
- [x] Eligibility per `(service, billing mode)` credential, replacing `hasAnyAuthForProvider`
- [x] Turn routing scoped to the selected mode, closing the `sub` → `claude-api-key` leak
- [x] Resident spawn identity widened to the whole spawn-relevant tuple
- [x] `UsageRow` gains `service_id`, `billing_mode` and the four unit rates *(landed early — see `plan.md`)*
- [x] `cost_usd` written under its final rule from day one, by both producers
- [x] Sub-agent usage writer widened; Codex token semantics measured and normalized
- [x] Composer picker split into harness and model, model rows grouped by service
- [x] Delete `nativeModelIdsForHarness` and the hand-kept `METERED_MODELS` set
- [x] Cross-backend review — nine findings, eight fixed (see `plan.md`)
- [x] A stale pin stops naming with a notice; "nothing eligible" falls back to the pre-feature
      path instead, so an install whose CLI is authenticated outside ShipIt's credential store
      keeps naming its sessions
- [x] Delete the `ProviderAccount` projection. Closed as **planning#342**, on its own,
      because no phase needed it: each re-keyed what it *read*, not what the router is
      *built from*. The router's credential-row verbs now take a `serviceId`, the harness
      survives only where a login flow or a credential root is the subject, and
      `ProviderAccount` and both adapters are gone. See `plan.md` →
      *Retiring the `ProviderAccount` projection*.
- [x] Replace the first-credential delivery within one mode. Closed in **phase 5**: every
      stored credential is delivered under a name of its own and spawn shaping sources the
      pinned route's, so choosing a different one no longer means authenticating with the
      group's first.
- [x] The **sub-agent defaults** picker gains its service axis *(done in phase 4)*
- [x] The new-session picker reads the globally-active session for its **harness** display.
      Pre-existing (the combined picker did the same); found by review and recorded rather
      than fixed then, since untangling it is composer work with no bearing on billing.
      Closed after phase 9: both selectors take `seedFromHistory` — the shape
      `ReasoningSelector` already had — and with no session bound they display
      `newSessionAgentId`, the *same* rule that creates the session, rather than the ui
      store's `activeAgentId` (which `useConnectionSync` syncs to whichever session is
      connected). `hasActiveSession` turned out to be the wrong gate: the new-session route
      claims a warm session up front and talks to it, so it is `hasActiveSession: false`
      **and** bound at once, and must keep following that session. Cross-backend review then
      found the bug surviving in a narrower window — a claimed warm session is bound but
      **invisible** (`SessionManager.list` filters `warm = 0`), so the composer fell back to a
      stale `activeAgentId`; `useUiStore.reset()` now returns that field to the seed. A second
      finding with it: global `modelInfo` outranked the seed in Quick Capture whenever the
      background session ran the seeded harness.
- [x] `authConfigured` leaves `AgentInfo`. Its MEANING moved here — "this harness has at
      least one eligible model" — which is the part req 2 needed; the rename was deferred as
      churn. Taken after phase 9 as **`hasRunnableModels`**: an auth-shaped name describes
      the wrong axis once req 2 makes a harness runnable with no account at its own vendor.
      Pure rename, no shim — the field crosses the wire but nothing persists it, so every
      payload is recomputed on connect.

## Phase 6 — Usage, cost and attribution

- [x] Quota re-keyed to `(service, billing mode) → routeId → limits`, inner key preserved
- [x] A `key` mode reports no quota and renders no indicator at all (req 10)
- [x] `/api/limits/refresh` takes `(serviceId, billingMode)`, rejecting a mode with no quota
- [x] `UsageGroup` / `UsageTotals` — the split by `(service, mode)`, plus the legacy bucket
- [x] "At API rates" recomputes from persisted rates; "metered spend" sums `cost_usd`
- [x] Legacy rows excluded from BOTH dollar figures, with their own unqualified total
- [x] Volume in tokens: the group column, both headlines and the chart's third series
- [x] The chart's cost-vs-turns toggle becomes Metered / At API rates / Tokens
- [x] The inherited surfaces — dial trigger + popover, per-session cost, avg per turn,
      per-turn column, by-spend ranking — carry the split, with an explicit tiebreak
- [x] `SessionUsage.totalCostUsd` replaced by `totals` on every wire shape and reader
- [x] Labels: "Metered spend (est.)", `≈ … at API rates`, "earlier accounting"
- [x] Cross-backend review — five findings, all five fixed (see `plan.md`)

## Phase 4 — In-session switching

- [x] An explicit `(service, mode, model)` triple is honoured or **refused**, never
      re-resolved to a bare id (`model-switch.ts`)
- [x] A harness switch conforms the whole triple against the new harness's eligible set
- [x] One sentence reports everything a switch moved — model, billing group, reasoning effort
- [x] `model_selection_changed` — the server's authoritative selection, applied to the
      session store and toasted when the server moved or refused something
- [x] The composer's optimistic pick becomes the triple, so a same-id cross-service switch
      moves the checkmark and the disambiguating pill — and is dropped when the server
      answers, refusal included
- [x] The model a turn spawns with comes from the session row, not from a per-connection
      selection a second viewer can hold stale
- [x] A saved seed the displayed harness cannot run is dropped rather than shown
- [x] Sub-agent defaults picker gains the service axis; the triple is validated server-side
- [x] Co-located tests, plus an integration switch between two services on ONE model id
- [x] Driven in the real UI (the dogfood instance, OpenRouter ↔ Vercel on
      `anthropic/claude-opus-5`) — which is where two of the client defects were found
- [x] Cross-backend review — six findings, all fixed (see `plan.md`)

## Phase 7 — Non-turn work

- [x] `CredentialStore.nonTurnModel` — the stored `(service, billing mode, model)`. Phase 7
      kept **unset** as a distinct state rather than filling it in with the resolved answer;
      **2026-08-13 reversed that** — `seedNonTurnModel` writes the resolved answer the first
      time the install can run something, because the second state could not be named on
      screen. Unset now only describes an install before that first write.
- [x] `non-turn-model.ts` — the resolver: req 9's derived default (first service, first
      billing mode, first model), the derived harness (first installed harness offering it),
      and the credential route + spawn shaping for it
- [x] A retired pin resolves through its successor at read time (req 13), so one retirement
      cannot fire req 9's notice on every session forever
- [x] `applyServiceRouting` / `codexProviderArgs` moved to `shared/spawn-routing.ts` so the
      orchestrator's own CLI shell-out shapes a spawn from the same source as a turn
- [x] `session-namer.ts` takes the resolved target, forwards the model, shapes the
      environment, and returns telemetry instead of discarding it
- [x] `services/non-turn-work.ts` — the brokered generation over `runner.spawnSubAgent`,
      wired as the production `generateText` (an injected one still wins)
- [x] A blank PR-description generation normalizes into the generic fallback (req 9's
      *change*), with the rejection path and the blank-success path tested separately
- [x] Usage rows for both halves, with their own attribution, through `turn-attribution.ts`
- [x] The dismissible failure notice: typed card, `messages.non_turn_failure` column +
      migration, `emitChatCard`, `CARD_MESSAGE_FIELDS`, `TRANSCRIPT_SCOPED_MESSAGES`,
      dismiss endpoint, history round-trip test
- [x] Settings → Services → **Background work**: the visible setting, with the derived
      default labelled and the derived harness shown as a fact rather than a control
- [x] Cross-backend review — nine findings, eight fixed (see `plan.md`)
- [x] **Codex-harness non-turn work records its usage row** (planning#341). Closed by
      measurement, not by narrowing req 16: `codex exec --json`'s `turn.completed` carries the
      turn's `usage` (verified against codex-cli 0.146.0 on a local Responses recorder), so the
      naming shell-out parses it instead of discarding stdout's prose. `input_tokens` includes
      `cached_input_tokens` there as it does on the app server, so the subtraction moved to
      `shared/codex-token-usage.ts` and both boundaries read one rule. Codex still reports no
      dollar figure — `costReported` stays false and the rates apply, as for a Codex turn.
      Cross-backend review found two defects fixed with it: `cache_write_input_tokens` is a
      detail of the input total too, so leaving it inside `input` billed those tokens twice
      (pre-existing on the turn path since phase 3), and a present-but-empty usage block priced
      to $0 instead of counting as no telemetry. A third — naming that resolves **no** target at
      all reports tokens nobody records — is pre-existing, harness-independent and a
      requirements question; filed as `planning#343` rather than answered here.
- [x] **Naming that resolves no model records unattributed volume** (planning#343). Answered at
      the requirements level, not the implementation one: req 16's legacy group takes it, because
      the tokens are real and their attribution does not exist — a pre-feature turn's condition
      reached forward in time. The usage gate drops `target &&`; `recordNonTurnUsage` takes the
      harness that ran it plus an optional target and writes an all-null-attribution row, which
      the all-or-nothing `CHECK` already makes the only expressible unattributed shape, so no
      discriminator was invented and `BillingMode` was not widened. The row is **unpriced** — a
      hard zero rather than `resolveTurnCost`'s no-attribution default of the harness's own
      figure, which for Codex is nothing and would assert the run was free. Consequence
      honoured: the legacy group is no longer purely historical and no longer drains on its own,
      so `usage.ts`, `usage-types.ts`, the modal's group name and `mockup-usage.html` stop
      saying it does. Cross-backend review found two defects fixed with it — a legacy group
      holding only unpriced rows rendered `$0.00`, the free-work assertion arriving through the
      display rather than the write (it now reads "Unpriced / no rates recorded"), and the
      local-mode PR-description fallback spawns a real CLI and dropped its tokens the same way
      naming did, so `opts` is forwarded and app-di's generator records its own row.

## Phases 8 and 9

Both have landed; their notes are in [`plan.md`](./plan.md) rather than here, since each
landed ahead of this checklist's per-phase sections.

## UI audit follow-up

- [x] **One card component in Settings → Services, and no per-vendor tabs** (`ui-audit.md`
      D1, D2, D5, D7, D8, D9, and D16 by consequence). `ServiceCard` now owns the chrome for
      every `(service, billing mode)` alike; `ProviderAccountsCard` became `ProviderAccountRows`,
      a body rather than a card, with its "Add account" lifted into the card header. The
      Settings → Claude / Codex tabs are deleted, Services leads a flat sidebar and is the tab
      Settings opens on. Two duplicates went with them: a second selection-mode control that
      wrote the same `accountSelectionMode` key as the string-delivered one, and the "Use an API
      key instead" disclosure, which wrote through to the credential the Services add-flow
      writes. The status dot went rather than moved — it reported the *harness* having runnable
      models, so it read green above "No Claude subscription connected yet". Details in
      [`plan.md`](./plan.md) → *One card component — and no per-vendor tabs at all*.
- [x] **Name the primary path, and state the billing mode the same way everywhere**
      (`ui-audit.md` D4, D10, D11). The add-flow's step 3 is titled by the path being
      recommended rather than by whichever credential shape exists, so a mode accepting both
      an account and a string reads `3 · Sign in` with the key under its own `Or paste a key`
      sub-heading. The model menu's group header states the billing mode as the *same pill*
      the service card carries — a new `BillingModePill`, and a `ModelGroupHeader` shared by
      the composer's model menu and its settings menu, which held two copies of that markup.
      The harness row went to two lines, name over `N models available`.
- [x] **One way in: the sign-in is the add-flow's last step** (req 17). `AddServiceDialog`
      creates the account and starts its login itself, and renders the provider's challenge
      through the same `AccountChallenge` the account row renders. *Cancel* abandons what it
      created; dismissing the dialog leaves a live challenge to finish on the card. The card's
      "Add account" and "Add another" buttons, `ServiceCard`'s header-action slot and the
      `revealedServiceModes` store slice are all deleted — which is also the fix for a service
      the user chose, never connected, and could not remove.
- [x] **The panel lists credentials, not attempts** (req 17). `isUnconnectedAttempt` — never
      identified *and* still in a pre-connect status — is derived from the account itself
      rather than tracked beside it, so the Services list no longer flickers a card in and out
      around a sign-in that is starting or being abandoned. The add-service dialog adopts an
      existing attempt instead of creating a second, so nothing hidden can be stranded, and
      the one-login-per-provider guard is measured against the attempt the flow would adopt.
- [x] **Choosing an account-only mode starts its sign-in** (req 18). OpenAI → Subscription
      landed on one sentence and one button that only repeated the click just made, so the
      mode click starts the login and the user arrives at the provider's code.
      `signInIsTheWholeStep` reads the condition off the catalogue — accepts an account and
      nothing else — so Anthropic's subscription, which also takes a token, still asks. The
      harness-missing and one-login-per-provider guards are checked before the start, and the
      window before the code arrives says the sign-in is starting instead of that it stopped.
      Two review findings fixed with it: an account created after the user left is abandoned
      by whichever of `cancel`/`startSignIn` finishes last (a `left` ref), and the waiting
      state is the code's own box drawn as a pulse (`ChallengePlaceholder`, same shell, both
      98px, on screen from the step's first frame) with **no button beside it** — while the
      flow runs itself there is one control and it says Cancel, so a stray click cannot
      restart a live login.
- [x] **The Anthropic wait shows the Claude CLI's own output** (req 18 follow-up). Its sign-in
      is a wizard, not a code hand-over, so the wait runs ~6s and a pulse alone read as stuck.
      `AuthPanel` is one bordered box in every state, holding ShipIt's phase message and the
      collapsed `ClaudeAuthOutput` buffer — nothing about the sign-in renders outside it, and
      `ChallengePlaceholder` takes the `shape` of the box it stands in for. Two rejected cuts
      on the way: a live three-line tail below the box (the same output twice), then the
      collapsed buffer below the box (two places to look). The whole flow holds one height,
      measured live.

## Compact services panel (reqs 19-21)

- [x] `ServiceCard` compact: header line only, `N models` control top-right with the ids on hover
- [x] Drop the per-card description prose, the account empty-state box on a card that holds a credential, and the environment-variable sentence
- [x] Credential row = `label · quota · ⋯`; `SubscriptionLimitPill` reused with `label` optional
- [x] `⋯` menu: Rename / Reconnect / Disconnect (account), Rename / Replace secret / Remove (key)
- [x] Rename for a supplied key (the label patch endpoint already exists)
- [x] Drag-and-drop ordering replaces the carets, for both row types
- [x] Routing band: segmented control + inline cutoffs, with three existing strings kept verbatim in `WithTooltip`s (`label` widened to `ReactNode`); the band title survives only as the radiogroup's accessible name — no tooltip, it would have no trigger
- [x] Guard test: all four band strings are still reachable — three as tooltip content, the title as the accessible name
- [x] Delete `Make primary`: the button, both badges, `POST …/:id/primary`, `makePrimaryProviderAccount`, `ProviderAccountManager.makePrimary`
- [x] Reconnect opens the **same** `AddServiceDialog` on step 3 (`initialService` + `initialMode` + an existing `signInAccountId`); delete the row's inline challenge
- [x] Guard test: cancelling a reconnect leaves the account connected and in the same position
- [x] Guard test: exactly one `add-service-dialog` is mounted, however it was opened — no second dialog for reconnect
- [x] Adopt environment-delivered credentials into ordinary rows at boot (rotation, remembered deletion, reserved route ids)

Ten defects in all — four found by the work, six by the independent
cross-backend review (`shipit agent run --role reviewer`, run db1e8614). Recorded because each is a rule that was stated correctly and
implemented as a near-neighbour of itself:

- [x] **Cancelling a reconnect deleted the account.** `cancel` abandoned
      whatever `signInAccountId` named, which was right while every id the
      dialog held was one it had minted. `standDown` asks the ROW instead —
      `isUnconnectedAttempt`, the same predicate the panel uses to decide what
      to list — and cancels the login either way. Caught by the guard test
      above, before the code ran.
- [x] **`mixedDelivery` read "can hold both" for "holds both."** An
      account-capable mode with no account and two supplied credentials was
      treated as a mixed pair, so it offered no order between them and no
      routing band at all. Unreachable before adoption, because the second
      string credential was invisible; visible in the dogfood instance the
      first time it ran. Same correction for the routing pool and for the
      header count, which said "2 accounts" over two credentials on a card
      with no account.
- [x] **Adoption created a second API key**, which `createStringCredential`
      answers with a 409 — req 12 says keys never fail over. "Behave exactly as
      if I would add it manually" cuts both ways: an add that would be refused
      is an adoption that is refused, and the variable stays as shadowed as it
      already was.

### Found by the independent review

Requirements 19 and 21 were judged met; req 20 was judged **not fully met**, on
the first of these. All six are fixed.

- [x] **An adopted credential authenticated with the WRONG secret.** Adoption
      gives a stored row a legacy reserved id on purpose, and the test for "is
      this a stored route" was `startsWith("cred_")` — a faithful proxy only
      while every stored row had a minted id. Under it an adopted row was handed
      the mode's GROUP variable, which always carries the group's FIRST
      credential, so ordering or failover onto the adopted row authenticated as
      a different credential than the turn was attributed to. The question is
      now asked of the store, threaded through all four callers of
      `serviceRoutingForSelection` as a required parameter — a default would let
      a forgotten site fail silently, which is the failure being fixed.
- [x] **Cancelling a reconnect could still delete the account.**
      `isUnconnectedAttempt` is not sufficient on its own: a login whose identity
      cannot be read proceeds by design, so a connected account can have no
      `externalId`, and reconnect moves it to `authenticating` — both clauses,
      on a working credential. Only the dialog knows whether it MINTED the id
      (`mintedHere`), and that is now the gate.
- [x] **The reconnect's login outlived the dialog.** Running `cancel → start`
      from the click handler detached it from the dialog's `left` ref, so
      closing mid-flight let the start land afterwards — a login against a
      hidden row, which is the 409 nobody can clear. The dialog owns it now, via
      `startSignIn`, from a mount effect (mount IS the Reconnect click).
- [x] **Reconnect opened on the FAILURE screen.** With the start outside the
      dialog, `startingSignIn` stayed false, which satisfies `signInStalled` —
      "The sign-in stopped before the account connected." with a *Try again*,
      before the first request returned. Two fixes: the dialog owns the start,
      and `signInStalled` also waits for `reconnectLeftReady`, because the
      server's `authenticating` broadcast arrives after `startSignIn` resolves.
      A start that throws sets that flag, so a real failure still reaches its
      *Try again*.
- [x] **A stale challenge could mask the state.** `cancelAccountLogin` does not
      clear `providerAccountAuths`, so the code from a cancelled login rendered
      as the new one's — and suppressed `signInStalled`, leaving neither a
      completion nor a retry. The adopt path clears it.
- [x] **Two-write windows.** `CredentialStore.save()` swallows a write failure,
      so adoption's (row, provenance) and deletion's (route, removal marker)
      pairs each had a window whose ORDER decides how it fails. Both reordered
      so the survivable outcome is the one that happens: provenance before the
      row (self-heals next boot), marker before the delete (the row is still
      there and can be removed again, rather than being re-imported).
- [x] **Reconnect had no title of its own** — "Add a service — Anthropic",
      which reads as an add and names no account. Now "Reconnect — Anthropic ·
      Work", as the plan specified.

## Reported from the dogfood instance after reqs 19-21 shipped

- [x] **Failover cutoffs were missing** on a subscription whose credentials are
      supplied strings. "Quota" had been read as "account" in two places; it is
      a property of the MODE (`modeReportsQuota`), so an Anthropic plan token
      reports its windows whether it arrives as an account or a string.
- [x] **The quota read-out was missing from those rows too** — the header pill
      had always rendered one for the same routes.
- [x] **`stringSelectionFor` gained the account walk's quota tiers**, so the
      cutoff control is not a number that can never fire. planning#339 is
      untouched: GLM declares a reader that does not exist, reports no snapshot,
      and gets neither cutoffs nor a read-out.
- [x] **One token was listed as two credentials** — adoption imported a secret a
      stored row already held. It now compares by value, and withdraws a
      duplicate it created before the rule existed (narrowly: still its secret,
      still its generated label).
- [x] **Background work named a state no one could read.** "On the default" /
      "auto-configured" / "pinned" all needed a glossary, so the state went
      instead of the wording: `seedNonTurnModel` writes the setting the first
      time the install can run something, and only the user changes it after
      that. The menu's "ShipIt's default" row goes with it, the section drops to
      two rows (description over controls), and the line beneath the description
      carries only the derived harness. Seeding is narrow — a value is written
      only when there is none — so a chosen model whose credential goes away is
      reported, not replaced.
- [x] **Cross-backend review of that change — six findings, all fixed.** Adding the
      first service from an open Settings tab never seeded (the seed now also
      runs from `buildAgentListPayload`, which every credential mutation
      broadcasts through); the section kept a stale resolution after a
      credential change (the pair now rides `agent_list`, as the reviewer slots
      do); a half-finished sign-in could be frozen as the permanent setting
      (`requireReadyAccounts`); a harness only *assumed* installed could be too
      (the seed checks the probed registry); a failed disk write was reported as
      a successful one (`stampNonTurnModel` is atomic and rolls back); and a
      `null` over the wire left the removed state behind (it re-proposes).
- [x] **Second review round — two of those fixes missed a path, and one claim
      was wrong.** The harness guard *declined to write* where the probe and the
      install report disagreed, leaving no setting at all; it now steers the
      walk (`HarnessSearchOpts.isInstalled`) instead of rejecting its result.
      Cancelling a sign-in can reset a row to *ready* and announced only
      `provider_accounts`, so that install stayed unseeded — the route now emits
      `agent_list` too (producer census 10 → 11). And the claim that the new
      store method closes a check/PUT race is withdrawn: Node runs one request
      at a time and neither sequence yields, so the rollback is the reason the
      method exists, not atomicity. One residual is recorded in `plan.md` rather
      than fixed: a stale `agent_list` delivered after a newer PUT re-applies the
      older value in the browser until the next event.
- [x] **The single-credential card explained itself, and should say nothing.**
      "One account — nothing to route between yet. Add a second to choose an
      order and a strategy." came from the mock-up (audit cell D8) and was
      rejected on sight. The routing band now appears only when there is
      something to route between, which is what the code did before the audit
      pass; `NothingToRouteYet` is deleted and D8 is closed as **(d)**, the
      mock-up being wrong. Receipt dated 2026-08-13 in `requirements.md`.
