# Checklist

> **Status: phases 1 and 2 implemented.** All three questions the design raised are answered
> and receipted.
>
> Req 6 is not fully *delivered* until [`docs/252`](../252-custom-models/plan.md) phase 3, where
> custom services first run a turn: until then a user can add a DeepSeek or OpenRouter key
> through the panel and watch `canRunTurns` stay false. Expected, not a defect — see
> [`plan.md`](./plan.md) → *Dependency on docs/252*.

## Design

- [x] `requirements.md` written and reviewed cross-backend
- [x] `plan.md` written against it
- [x] `plan.md` reviewed cross-backend twice; verified findings folded in
- [x] Answered: GitHub keeps today's blocking behaviour in full (+ receipt)
- [x] Answered: stamp only if currently runnable (+ receipt)
- [x] Answered: "Add a service" is a dialog; req 5 amended (+ receipt)

## Phase 1 — runnable signal + honest composer (reqs 3, 8, 10)

- [x] `canRunTurns` computed in `services/settings.ts` (pre-252 form: any agent installed
      **and** `authConfigured`) — `computeCanRunTurns`, the single swap point
- [x] Field on `GlobalSettings` → `GET /api/bootstrap` (`services/misc.ts`), including the
      settings-read-failed fallback, which computes it rather than defaulting to `false`
- [x] Field added to the SSE `agent_list` payload at **all ten** emit sites — via
      `buildAgentListPayload`, which every producer now goes through, so a hand-rolled
      `{ agents }` cannot reappear. (Eleven with the one added below.)
- [x] `POST /api/agents/:id/env` (the Codex API key) gains an `agent_list` broadcast — it
      returned `agents` and pushed nothing, so other tabs stayed stale. Eleventh producer.
- [x] Client store field (`settings-store.canRunTurns`); `useServerEvents` reads it, and
      ignores an absent field rather than clobbering a good value. The WS `global_settings`
      handler is deliberately untouched — that channel has no server producer
- [x] Explicit wiring in both HTTP readers, which copy named fields rather than spreading
      `settings`: `client/utils/session-data.ts` and the Settings refetch in `App.tsx`
- [x] `client/utils/chat-runnable.ts` — reader + `starterPromptsAllowed`
- [x] `MessageInput` `disabledReason`: disables the textarea, the attach button, paste and
      drag-drop, the permission selector, and hides the mic (a `MicButton` has no inert state
      worth rendering) — including the Quick Capture hotkey's mic auto-arm
- [x] `MessageInput` renders the textarea empty while `disabledReason` is set, so a retained
      draft or prefill cannot hide the placeholder; the draft survives in the store
- [x] `App.tsx` passes `disabledReason` when `!canRunTurns`; other disabled cases unchanged
- [x] `QuickCaptureOverlay` passes **`disabledReason`**, not just `disabled` — the existing
      prop guards submission only
- [x] Server test: `canRunTurns` false with no credential, true with one, false for a
      credential no installed harness can use
- [x] Server test: every emit site carries the field — a source scan asserting each producer
      routes through `buildAgentListPayload`, plus a per-file producer census, so a new
      producer fails loudly naming its file and line
- [x] Client test: composer is not typeable, cannot attach, cannot dictate, and shows the reason
- [x] Client test: a retained draft does not hide the placeholder, and cannot be sent
- [x] Client test: Quick Capture is inert — not typeable, not attachable and not recording,
      not merely unable to send
- [x] Unit test: `starterPromptsAllowed` — both conditions, including completed-then-removed

## Phase 2 — the panel (reqs 1, 2, 4, 5, 6, 7, 9)

- [x] `harnessOnboardingCompletedAt` on `CredentialData`; stamped when the server first sees
      `canRunTurns === true`; never cleared; no second stamp condition — `resolveHarnessOnboarding`
      in `services/settings.ts`, on the READ path so the migration case needs no separate step
- [x] The stamp's write is **confirmed**, not swallowed — `stampHarnessOnboardingCompleted`
      calls `writeToDisk()` directly and reverts the in-memory value on failure, so a lost stamp
      is reported as not-yet-completed rather than surviving until the next restart
- [x] Field on `GlobalSettings` + every SSE emit site — `buildAgentListPayload` now takes the
      credential store as a **required** parameter, so an omission is a compile error rather than
      a silently stamp-less payload
- [x] `OnboardingWizard` trimmed to step 1 and renamed `GitHubGate`; `StepDots`, `initialStep`
      and the agent props removed, along with App's now-unused API-key / refresh handlers
- [x] `App.tsx`: drop `noAgentReady`; the gate's condition is `githubNeeded` alone; **latch kept**
      (`onboardingTriggeredRef`, `onboardingDismissed`), with dismissal now firing when GitHub
      connects instead of on "Get Started"
- [x] `HarnessOnboardingPanel`: single-column lede + the Services surface. No step rail
- [x] Rendered in the chat-pane slot, replacing **both** `HomeScreen` and the conversation;
      `showHomeScreen`'s layout effects are deliberately left alone
- [x] Composer render gate widened so the composer renders under the panel
- [x] Panel visibility is `harnessOnboardingCompletedAt == null` **&& the gate is not up**; not
      dismissible, no "Get Started" — `harnessOnboardingPanelVisible` in `utils/chat-runnable.ts`,
      beside the composer's own predicate
- [x] Panel renders docs/252's Services card list and opens its "Add a service" dialog as-is —
      `ServicesPanel` took no change at all for this
- [x] `ProviderAccountsCard` global toasts moved inline — row-scoped where a row exists,
      card-scoped for "Add account" (no row yet) and for a *successful* disconnect's result (the
      row it describes is gone). `ServicesPanel`'s own credential-row toasts moved too, for the
      same reason and by the same argument
- [x] The duplicate-account refusal (`reason: "duplicate"`) gets an in-panel landing place: a
      `providerAccountNotices` store slot rendered as a card-level notice, since an SSE handler
      has no other channel into a component it does not render
- [x] Gate tests (`GitHubGate.test.tsx`): blocks with a fixed overlay; dismisses when GitHub
      connects; stays up on a rejected token; carries no step chrome
- [x] Panel tests: the predicate's four cases (`chat-runnable.test.ts`) — shown when never
      configured, gone once stamped, still gone for a completed install that removed every
      credential, and **suppressed while the gate is up**; plus the panel's own shape tests
- [x] Server tests for the stamp (`harness-onboarding-stamp.test.ts`): runnable legacy install
      is stamped and survives a restart; non-runnable legacy install is not stamped; completion
      survives removing every credential; a failed write is not reported as completed
- [x] Test: the flow itself puts nothing but the add dialog on top of the panel — the panel has
      no `fixed` element and no backdrop, and opening the add-flow yields exactly one dialog
- [x] Verified in the live app rather than asserted in a unit test — this is a claim about
      `AppLayout`'s composition, and a green component suite cannot see a panel mounted behind a
      backdrop. Screenshots in the PR
- [x] `docs/216` checklist item added: the re-implementation must `&&` in
      `starterPromptsAllowed`

## Before done

- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Cross-backend review of the implementation diff against every numbered requirement
- [x] Visual check in the live app: panel in the chat pane with the right panel live beside it,
      the add dialog as the only thing over it, and the panel absent behind the GitHub gate
