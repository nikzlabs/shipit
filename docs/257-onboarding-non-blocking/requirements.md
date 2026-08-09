---
issue: planning#335
title: Non-blocking onboarding
description: Harness onboarding stops being a blocking modal and becomes an inline, modal-free panel in the conversation view, so a new user can see and use ShipIt before connecting anything.
---

# Non-blocking onboarding — requirements

These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here.

This feature exists because [`docs/252-custom-models`](../252-custom-models/requirements.md)
makes the current onboarding untenable — its credential step is hard-coded to two providers and
services become plural — but the problems below are ones the flow has today, independent of
that. docs/252 phase 2 carries an interim that keeps the existing wizard working under the new
credential keying; this feature replaces the flow.

**Terminology — "harness onboarding" is the subject here.** First-run setup has two parts, and
they are not interchangeable: connecting **GitHub / git identity**, and connecting a
**harness credential** so the agent can run. This document is about the second. The GitHub step
stays in the flow and is not otherwise changed (see *Out of scope*), so where a requirement
below turns on what is configured or when the flow is finished, it means the harness half.

## Requirements

1. **Onboarding does not block the rest of ShipIt.** It is not a modal over the application.
   The file tree, previews, the terminal, settings and navigation all remain usable while
   onboarding is unfinished. Today the wizard is a gate in front of the whole product, and a
   user who does not complete it sees nothing of ShipIt at all.

2. **Onboarding takes over the conversation view.** That is the surface it occupies — the panel
   where chat would be — rather than an overlay drawn on top of everything. When onboarding is
   not in progress, that space is the conversation as usual.

3. **A new user can see and use ShipIt before connecting a subscription.** Being able to use
   the product is not conditional on finishing onboarding. The concern this addresses is
   drop-off: a first-time user who is asked to connect an account before they have seen
   anything has been given no reason to.

   **Everything works except the chat.** The composer is disabled as a whole — it does not
   accept input that could not run — and that is the single thing an unconfigured install
   cannot do. Sessions, files, previews, the terminal, navigation and settings all behave
   normally.

   **A disabled composer always says why, in its own placeholder** — to the effect of "Add at
   least one service for the chat to work". This holds **whenever** the composer is disabled for
   want of a runnable service, not only during onboarding: while the panel is on screen it
   restates the ask in the place the user is about to click, and in any state where the panel is
   absent it is the only thing explaining the disabled input. Exact wording is a design
   decision, not a requirement.

4. **It is still a sequence, not a settings page.** The user is guided through the steps in an
   order, with a sense of what is done and what remains. Removing the blocking behaviour does
   not mean scattering the setup across the app for the user to find.

5. **No modals in harness onboarding.** Every step is resolved in place, in the panel. Today
   two modals can be visible at once, which is confusing and busy; the fix is not to ration
   them but to stop using them here. Nothing in this flow opens anything on top of anything
   else.

   The one thing that legitimately leaves the panel is a provider's own sign-in page, which
   ShipIt does not own and cannot host. That is a link out, not a modal.

   **Results and errors render inside the panel too**, next to the step that produced them —
   not as a toast elsewhere on screen. The point of the panel is that the ask is in front of
   the user while everything else keeps working; an error that appears somewhere else and then
   disappears defeats that.

6. **The flow accommodates every service and billing mode docs/252 ships.** Once a user is
   choosing among several services rather than two providers, the credential step carries
   materially more than it does now — the current problem is a lot of functionality inside a
   small dialog, in fact inside one part of a dialog. The bar is docs/252's launch set, which
   is a concrete list, rather than open-ended future growth.

7. **Setup happens in a panel in the middle of the conversation view, and connecting a harness
   there behaves exactly as it does in Settings.** The same credential kinds are offered, the
   same states are shown, the same actions are available, and a harness connected during
   onboarding is afterwards indistinguishable from one connected later in Settings. The two are
   the same act and must not drift into disagreeing about what a connected credential is.

   Identical *behaviour* is the requirement; identical *layout* is not, and the existing shared
   surface already varies its density for onboarding. Whether behavioural identity is achieved
   by literally reusing one implementation is a design decision for `plan.md` — it is the
   obvious way and it is what the reason given ("to avoid duplication") points at, but it is
   not itself an observable requirement.

8. **Harness onboarding is finished when the install can actually run something.** Not when a
   credential has been stored: docs/252 makes those different, because a credential belongs to
   a service and billing mode while whether any model is *selectable* also depends on which
   harnesses are installed. Storing a credential no installed harness can use has not finished
   anything — it would leave a flow saying it is done above a composer that is still, correctly,
   disabled.

9. **Harness onboarding is shown when nothing is configured and never was, and it is not
   dismissible because it does not need to be.** It occupies the conversation view rather than
   covering the product, so there is nothing for a dismissal to uncover.

   The condition is historical, not current. A user who has completed it and then removes every
   credential does **not** get onboarding back — they are not a new user, and Settings is where
   they undo what they did there. What brings the panel back is nothing: there is no "re-run
   harness onboarding". The condition is also **global rather than per-session** — it is a
   property of the install, so adding a second repository does not re-ask a user who is already
   set up, and a user who is not set up meets the same panel wherever they are.

   This is specifically about the harness half. It says nothing about whether the GitHub step
   can be skipped or deferred — that step keeps whatever behaviour it has today.

10. **Starter prompts never appear to a user who has not been through harness onboarding.** The
    empty-session starter prompts (`docs/216-onboarding-starter-prompts`) share the conversation
    view with this flow, and they are sequential rather than simultaneous: the setup panel
    first, the prompts only once onboarding has been completed. They never occupy the panel at
    the same time.

    This is a gate on top of whatever eligibility docs/216 defines for itself — it removes
    prompts in a case docs/216 would otherwise allow, and never adds them anywhere.

    **Prompts also require a runnable chat.** Both conditions hold: onboarding completed *and*
    something currently runnable. In every normal case these coincide, because a user who has
    just finished onboarding is runnable by definition; they diverge only where onboarding was
    completed and every credential later removed, and there the prompts are hidden. A chip seeds
    the composer rather than sending, so a chip above a disabled composer would put text into an
    input that cannot send it — and replace the placeholder explaining why (req 3) with that
    text. Never showing a control that cannot do its job is the simpler rule.

## Out of scope

- **Removing the GitHub / git identity step.** Whether that step should exist at all is a fair
  question and explicitly not this change. It stays in the flow.

## Open questions

Both were raised by the cross-backend review of [`plan.md`](./plan.md), which found the
design could not be completed without them. Neither is answered here; an agent inference
never closes one.

- **When does the panel go away, given the GitHub step is inside it?** Req 9 defines the
  panel's presence by the harness half, and the terminology paragraph says "finished" means
  the harness half — but the *Out of scope* section also says the GitHub step keeps today's
  behaviour, and today `githubNeeded` alone summons the whole wizard, including for an
  established user whose token was revoked (`App.tsx:354`). The two cannot both hold now that
  the panel replaces the conversation instead of covering an empty product. Either (a) the
  panel's lifetime is the harness half only — a user who connects a service from Settings
  while step 1 is on screen ends the flow with GitHub unconnected, and a later GitHub loss
  never re-opens the panel; or (b) the panel also waits on GitHub — which, since it is not
  dismissible (req 9), leaves it permanently in the conversation view of a user who has a
  working agent and does not want GitHub, and puts it back over an established user's real
  chat when a token expires.

- **What should an install upgraded with no credentials see?** Req 9's condition is
  historical, and no field in the tree records that history — account rows and stored keys are
  deleted on disconnect (`credential-store.ts:280`), so "completed onboarding, then removed
  everything" and "never configured anything" are indistinguishable on an install that
  predates the flag. A user in the first group would get onboarding back, which req 9 forbids.
  Either accept that for the one upgrade window (the panel blocks nothing, and the ask it
  makes is the correct one for someone who cannot run a turn), or treat *every* pre-existing
  install as already-completed (nobody who upgrades ever sees the panel, including a genuinely
  unconfigured one, who then meets only the disabled composer's placeholder).

## Resolved questions

- 2026-08-09 — Do starter prompts require a runnable chat, or only a completed onboarding?
  **Chosen: both — prompts require a runnable chat as well.** The two conditions coincide in
  every normal case and diverge only where onboarding was completed and every credential later
  removed; there, the prompts are hidden. The deciding fact is that a chip seeds the composer
  rather than sending (`docs/216` plan:41), so a chip above a disabled composer puts text into
  an input that cannot send it *and* replaces the placeholder explaining why (req 3) — leaving
  the user holding an unsendable message with the explanation gone. The alternatives were inert
  chips (a visible control that does nothing) or re-pointing them at Settings in that state (one
  chip meaning two things). Req 10 amended.

- 2026-08-09 — **Correction to the receipt below.** It recorded req 10 as clarified so that
  "prompts are not suppressed" in the post-completion, no-credentials state. That was the
  agent's inference from the gate's wording, not part of the answer, and review immediately
  asked the obvious follow-up: what happens when the user presses one? Nothing in the answer
  settles that. The clarification has been withdrawn from req 10 and the question reopened
  above. An agent inference never closes an open question, which is precisely what happened
  here.

- 2026-08-09 — In the post-completion, no-credentials state, what does the user see and what
  does the disabled composer say? **Chosen: the composer explains itself in its own
  placeholder — "Add at least one service for the chat to work" or similar — and this applies
  whenever the composer is disabled, not only in that state.** The question offered two options,
  suppressing the prompts or explaining the composer; the answer took the second and then
  generalised it past the case asked about, which is why it landed on req 3 (the composer)
  rather than on req 10 (the prompts). One consequence worth naming: the same message serves
  both while the panel is on screen and after onboarding is long finished, so it must make sense
  without the panel next to it. Req 3 amended, req 10 clarified that prompts are not suppressed.

- 2026-08-09 — When is harness onboarding finished — a stored credential, or a runnable model?
  **Chosen: when something is runnable.** Raised by cross-backend review, which noted that
  docs/252 separates the two: a credential belongs to a `(service, billing mode)`, while
  selectability also depends on which harnesses are installed (docs/252 reqs 8 and 14). The
  rejected reading would let onboarding declare itself finished above a still-disabled composer.
  Req 8 rewritten around runnability rather than storage.

- 2026-08-09 — What scale must the flow accommodate? **Chosen: docs/252's launch set.** "Room
  to grow" and "without becoming unreadable" were not testable as written. Binding the bar to a
  concrete shipped list makes it checkable, and declines to promise open-ended growth. Req 6
  amended.

- 2026-08-09 — Does the starter-prompts requirement order this flow against docs/216, or
  change docs/216's scope?
  **Chosen: a hard gate — starter prompts never appear to a user who has not been through
  harness onboarding.** The question arose because docs/216's own plan and checklist disagree
  about which sessions are eligible, and its implementation was reverted. The answer sidesteps
  that: this requirement only ever *removes* prompts, on top of whatever eligibility docs/216
  settles for itself, so the two do not need reconciling first. Req 9 renumbered to 10 and
  restated as a gate rather than a sequence.

- 2026-08-09 — Does the panel replace the conversation in every session, or only an empty one,
  and what happens after the last credential is removed? **Answered together: the panel is
  shown when nothing is configured *and never was*.** The question's premise was queried first —
  how would a user reach a second session without configuring a harness? — and the real case is
  adding another repository. So the condition is a property of the install rather than of a
  session, and it is *historical*: a user who set things up and later removed every credential
  is not a new user and does not get onboarding back. Req 9 rewritten; this closed the separate
  deconfiguration question too.

- 2026-08-09 — Must credential errors surface inside the panel, or may they use toasts?
  **Chosen: inside.** The surface req 7 points at reports several failures through global
  toasts today (`ProviderAccountsCard.tsx:105`), so this is a change to inherited behaviour
  within this flow rather than a restatement of it. Req 5 amended.

- 2026-08-09 — **Provenance of reqs 1, 2, 4 and 6**, which have no receipt of their own because
  they were not answers to questions. They come from Nik's original description of what is
  wrong with onboarding today, given in one statement: that it is *"a lot of functionality in a
  small dialog, actually even in part of the dialog"* (→ req 6); that *"the user cannot actually
  see anything before they finish onboarding, before they connect a subscription, so people will
  just stop there"* (→ reqs 1 and 3); that *"there are already two modals visible at the same
  time, so it's a bit confusing and a bit busy — if we add more to the same screen it would be
  very hard to understand what's going on"* (→ req 5); and that it should *"not be part of the
  dialog, but part of replacing the conversation view with this … so it would still be some kind
  of wizard, but it would not be blocking other elements — previews would work, files would
  work"* (→ reqs 1, 2 and 4). The Git step being possibly removable but *"out of scope for this
  change"* is the *Out of scope* section. Recorded because a review could not otherwise tell
  these apart from agent inference.

- 2026-08-09 — May a step open a modal? **Chosen: no modals in harness onboarding at all.**
  Review asked what the use case was, and there is none: the requirement said "at most one at a
  time" without naming a single step that needed one. It came from an over-reading of an
  ambiguous phrase in the original description, not from a step that requires one. The Settings
  credential surface behaves without one: the OAuth step is a link to the provider's own sign-in
  page (`ProviderAccountsCard.tsx:470`), and the one genuine question it asks — where a pinned
  session should go when its account is disconnected — is answered by a row-local picker
  (`:223`). Rationing modals would also have left the door open to the exact "busy, confusing"
  problem the requirement was reacting to. Req 5 rewritten.

  **Correction:** an earlier version of this receipt said that surface "resolves everything in
  place, including disconnect". That is wrong — it has a `toast()` helper (`:105`) and reports
  several failures through global toasts; only the pinned-session question is inline. A toast is
  not a modal, so it does not contradict req 5, but the claim as written was broader than the
  code supports. Whether errors *should* surface in-panel is now an open question rather than
  something this receipt quietly settled.

- 2026-08-09 — Which half of first-run setup do these requirements govern? **Clarified: the
  harness half.** Review noted that "onboarding" was doing double duty for both the GitHub /
  git identity step and harness credential setup, which matters most in req 8 — "finished once
  a credential is configured" is a claim about harnesses, not about GitHub. A terminology
  paragraph now says so up front, and req 8 says which half it binds. No decision changed; the
  document was ambiguous about what it already meant.

- 2026-08-09 — What can the user do before connecting a credential, beyond looking? **Chosen:
  everything except the chat; the composer is disabled as a whole.** The agent's
  recommendation was to let the user compose and send a message and ask for the credential at
  that moment, on the reasoning that the ask is finally motivated there. Rejected: it lets a
  user type something that cannot run and then blocks on submit, which is a worse moment to
  discover the requirement than an obviously-disabled input. The setup panel sits in the
  conversation view instead, so the ask is already on screen while everything else works. Req 3
  amended, req 7 added.

- 2026-08-09 — Should the onboarding credential UI be its own thing or Settings'? **Chosen:
  the same surface, to avoid duplication.** Connecting a harness during onboarding and from
  Settings are the same act. This continues an existing decision rather than making a new one —
  `docs/150` req 16 already collapsed onboarding's provider cards onto the Settings component
  for the same reason, after a user's first account was being connected by different code than
  their second. Req 7.

- 2026-08-09 — Is onboarding dismissible, and does it come back? **Chosen: not dismissible,
  because it does not need to be; and it does not return.** The premise of the question was
  wrong in a useful way: dismissal only matters for something that covers the product, and
  req 1 removes that. Once at least one harness credential exists the flow is finished, and
  later credential work happens in Settings. Req 8 added.

- 2026-08-09 — Is this one-time, or a surface that returns for later setup? **Answered by the
  dismissal decision: strictly first-run.** Settings owns adding a second service months later.
  Recorded separately because it was asked separately, not because it took a separate decision.
  Req 8.

- 2026-08-09 — What happens to the empty-session starter prompts? **Chosen: shown only after
  harness setup.** They share the conversation view with this flow, so they are sequential:
  setup panel until a credential exists, prompts once one does. Req 9 added — renumbered to
  req 10 and restated as a gate later the same day, see the receipt above.
