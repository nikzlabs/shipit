# Checklist

> **Status: design-only.** No implementation code is in the tree. Both open questions are
> answered and receipted.
>
> Phase 2 depends on [`docs/252`](../252-custom-models/plan.md): phases 1–2 to exist, phase 3
> for req 6 to actually be delivered. See [`plan.md`](./plan.md) → *Dependency on docs/252*.

## Design

- [x] `requirements.md` written and reviewed cross-backend
- [x] `plan.md` written against it
- [x] `plan.md` reviewed cross-backend; verified findings folded in
- [x] Open question answered: GitHub keeps today's blocking behaviour in full (+ receipt)
- [x] Open question answered: stamp only if currently runnable (+ receipt)

## Phase 1 — runnable signal + honest composer (reqs 3, 8, 10)

- [ ] `canRunTurns` computed in `services/settings.ts` (pre-252 form: any agent installed
      **and** `authConfigured`)
- [ ] Field on `GlobalSettings` → `GET /api/bootstrap` (`services/misc.ts`)
- [ ] Field added to the SSE `agent_list` payload at **every** producer — `app-lifecycle.ts`
      `:1300`, `:1339`, `:1451`, `:1468`, `:1492`; `api-routes-bootstrap.ts` `:245`, `:282`
- [ ] Client store field + `useServerEvents.ts:437` reads it (do **not** wire through the WS
      `global_settings` handler — that channel has no server producer)
- [ ] `client/utils/chat-runnable.ts` — reader + `starterPromptsAllowed`
- [ ] `MessageInput` `disabledReason`: disables the textarea (`:766`), the attach button
      (`:780`), paste/drag-drop (`:681`), the mic (`:799`) and the permission selector (`:820`)
- [ ] `MessageInput` renders the textarea empty while `disabledReason` is set, so a retained
      draft or prefill cannot hide the placeholder
- [ ] `App.tsx:1985` passes `disabledReason` when `!canRunTurns`; other disabled cases unchanged
- [ ] `QuickCaptureOverlay.tsx:147` `disabled` also gates on `!canRunTurns`
- [ ] Server test: `canRunTurns` false with no credential, true with one
- [ ] Client test: composer is not typeable, cannot attach, and shows the reason
- [ ] Client test: a retained draft does not hide the placeholder
- [ ] Client test: Quick Capture cannot submit when `!canRunTurns`
- [ ] Unit test: `starterPromptsAllowed` — both conditions, including completed-then-removed

## Phase 2 — the panel (reqs 1, 2, 4, 5, 6, 7, 9)

- [ ] `harnessOnboardingCompletedAt` on `CredentialData`; stamped when the server first sees
      `canRunTurns === true`; never cleared; no second stamp condition
- [ ] Field on `GlobalSettings` + every SSE `agent_list` producer
- [ ] `OnboardingWizard` trimmed to step 1 and renamed `GitHubGate`; `StepDots`, `initialStep`
      and the agent props removed; `AuthOverlay` mounts it on `githubNeeded` alone
- [ ] `HarnessOnboardingPanel`: single-column lede, rail (GitHub done + Add a service), the
      Services surface
- [ ] Rendered in the chat-pane slot, replacing **both** `HomeScreen` and the conversation
- [ ] `App.tsx:1982` composer render gate widened so the composer renders under the panel
- [ ] Panel visibility is `harnessOnboardingCompletedAt == null` alone; not dismissible, no
      "Get Started"
- [ ] docs/252's Services add-flow made host-agnostic; Settings supplies the dialog, the panel
      hosts it inline (no modal in the flow — req 5)
- [ ] `ProviderAccountsCard` global toasts moved inline next to their row — failures (`:105`)
      **and** disconnect results (`:253`, `:258`)
- [ ] Delete `noAgentReady` / `needsOnboarding` / the onboarding latch in `App.tsx`; keep
      `githubNeeded`
- [ ] Gate tests: still blocks on `githubNeeded`, closes the instant GitHub connects, re-gates
      on a later loss (today's behaviour, unchanged)
- [ ] Panel tests: yields when `canRunTurns` flips; absent once the flag is set even with no
      credential (req 9); never on screen at the same time as the gate
- [ ] Test: nothing in the harness panel renders a modal (req 5)
- [ ] Test: the rest of the app is reachable while the panel is up (req 1)
- [ ] `docs/216` checklist item added: the re-implementation must `&&` in
      `starterPromptsAllowed`

## Before done

- [ ] `npm run lint:dev` + `npm run typecheck` clean
- [ ] Cross-backend review of the implementation diff against every numbered requirement
- [ ] Visual check in the live app: fresh install, panel in the chat pane, preview and terminal
      usable beside it
