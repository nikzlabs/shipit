# Checklist

> **Status: design-only.** No implementation code is in the tree. All three questions the
> design raised are answered and receipted.
>
> Phase 2 depends on [`docs/252`](../252-custom-models/plan.md): phases 1–2 to exist, phase 3
> for req 6 to actually be delivered. See [`plan.md`](./plan.md) → *Dependency on docs/252*.

## Design

- [x] `requirements.md` written and reviewed cross-backend
- [x] `plan.md` written against it
- [x] `plan.md` reviewed cross-backend twice; verified findings folded in
- [x] Answered: GitHub keeps today's blocking behaviour in full (+ receipt)
- [x] Answered: stamp only if currently runnable (+ receipt)
- [x] Answered: "Add a service" is a dialog; req 5 amended (+ receipt)

## Phase 1 — runnable signal + honest composer (reqs 3, 8, 10)

- [ ] `canRunTurns` computed in `services/settings.ts` (pre-252 form: any agent installed
      **and** `authConfigured`)
- [ ] Field on `GlobalSettings` → `GET /api/bootstrap` (`services/misc.ts`)
- [ ] Field added to the SSE `agent_list` payload at **all ten** emit sites —
      `app-lifecycle.ts` `:1300`, `:1339`, `:1451`, `:1468`, `:1492`;
      `api-routes-bootstrap.ts` `:245`, `:282`, and the provider-wide sign-outs `:419`, `:481`;
      and the initial/reconnect snapshot `route-registry.ts:163`
- [ ] `api-routes-bootstrap.ts:147` (Codex API key) gains an `agent_list` broadcast — today it
      returns `agents` and pushes nothing, so other tabs stay stale
- [ ] Client store field; `useServerEvents.ts:437` reads it. Do **not** wire through the WS
      `global_settings` handler — that channel has no server producer
- [ ] Explicit wiring in the HTTP readers, which copy named fields rather than spreading
      `settings`: `client/utils/session-data.ts:349` and `App.tsx:1107`
- [ ] `client/utils/chat-runnable.ts` — reader + `starterPromptsAllowed`
- [ ] `MessageInput` `disabledReason`: disables the textarea (`:766`), the attach button
      (`:780`), paste/drag-drop (`:681`), the mic (`:799`) and the permission selector (`:820`)
- [ ] `MessageInput` renders the textarea empty while `disabledReason` is set, so a retained
      draft or prefill cannot hide the placeholder
- [ ] `App.tsx:1985` passes `disabledReason` when `!canRunTurns`; other disabled cases unchanged
- [ ] `QuickCaptureOverlay.tsx:254` passes **`disabledReason`**, not just `disabled` — the
      existing prop guards submission only
- [ ] Server test: `canRunTurns` false with no credential, true with one
- [ ] Server test: each of the ten emit sites carries the field (a table-driven test, so a new
      producer added later fails loudly)
- [ ] Client test: composer is not typeable, cannot attach, cannot dictate, and shows the reason
- [ ] Client test: a retained draft does not hide the placeholder
- [ ] Client test: Quick Capture is inert — not typeable and not recording, not merely unable
      to send
- [ ] Unit test: `starterPromptsAllowed` — both conditions, including completed-then-removed

## Phase 2 — the panel (reqs 1, 2, 4, 5, 6, 7, 9)

- [ ] `harnessOnboardingCompletedAt` on `CredentialData`; stamped when the server first sees
      `canRunTurns === true`; never cleared; no second stamp condition
- [ ] The stamp's write is **confirmed**, not swallowed — `save()` logs and returns on failure
      (`credential-store.ts:238`); a failed write reports not-yet-completed
- [ ] Field on `GlobalSettings` + all ten SSE emit sites
- [ ] `OnboardingWizard` trimmed to step 1 and renamed `GitHubGate`; `StepDots`, `initialStep`
      and the agent props removed
- [ ] `App.tsx`: drop `noAgentReady`; `needsOnboarding` becomes `githubNeeded` alone; **keep the
      latch** (`onboardingTriggeredRef`, `onboardingDismissed`), with dismissal now firing when
      GitHub connects instead of on "Get Started"
- [ ] `HarnessOnboardingPanel`: single-column lede + the Services surface. No step rail
- [ ] Rendered in the chat-pane slot, replacing **both** `HomeScreen` and the conversation;
      `showHomeScreen`'s layout effects (`AppLayout.tsx:338`, `:341`, `:313`;
      `MobileContentPanels.tsx:23`) are deliberately left alone
- [ ] `App.tsx:1982` composer render gate widened so the composer renders under the panel
- [ ] Panel visibility is `harnessOnboardingCompletedAt == null` **&& the gate is not up**; not
      dismissible, no "Get Started"
- [ ] Panel renders docs/252's Services card list and opens its "Add a service" dialog as-is —
      no host-agnostic refactor of that surface (req 5, amended)
- [ ] `ProviderAccountsCard` global toasts moved inline next to their row — failures (`:105`)
      **and** disconnect results (`:253`, `:258`)
- [ ] The duplicate-account refusal (`useServerEvents.ts:304`, `reason: "duplicate"`) gets an
      in-panel landing place — the row it would have used is deleted by the refusal
- [ ] Gate tests: blocks on `githubNeeded`; closes when GitHub connects; re-gates on the next
      load; does **not** re-gate mid-load for a user who completed it this load (today's
      behaviour, unchanged)
- [ ] Panel tests: yields when the stamp lands; absent once the flag is set even with no
      credential (req 9); **suppressed while the gate is up**, including a mid-session GitHub
      loss with the add dialog open
- [ ] Server tests for the stamp: runnable legacy install is stamped and survives a restart;
      non-runnable legacy install is not stamped; completion survives removing every credential;
      a failed write is not reported as completed
- [ ] Test: the flow itself puts nothing but the add dialog on top of the panel (Settings and
      add-repo are the user's own overlays and stay reachable — req 1)
- [ ] Test: in a session, preview / files / terminal / Present are usable beside the panel
- [ ] `docs/216` checklist item added: the re-implementation must `&&` in
      `starterPromptsAllowed`

## Before done

- [ ] `npm run lint:dev` + `npm run typecheck` clean
- [ ] Cross-backend review of the implementation diff against every numbered requirement
- [ ] Visual check in the live app: fresh install, panel in the chat pane, preview and terminal
      usable beside it in a session
