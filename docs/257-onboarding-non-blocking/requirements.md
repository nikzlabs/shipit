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

4. **It is still a sequence, not a settings page.** The user is guided through the steps in an
   order, with a sense of what is done and what remains. Removing the blocking behaviour does
   not mean scattering the setup across the app for the user to find.

5. **No modals in harness onboarding.** Every step is resolved in place, in the panel. Today
   two modals can be visible at once, which is confusing and busy; the fix is not to ration
   them but to stop using them here. Nothing in this flow opens anything on top of anything
   else.

   The one thing that legitimately leaves the panel is a provider's own sign-in page, which
   ShipIt does not own and cannot host. That is a link out, not a modal.

6. **The flow has room to grow.** Once a user is choosing among several services rather than
   two providers (docs/252), the credential step carries materially more than it does now. The
   layout must accommodate that without becoming unreadable — the current problem is a lot of
   functionality inside a small dialog, in fact inside one part of a dialog.

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

8. **Harness onboarding is not dismissible, because it does not need to be.** It occupies the
   conversation view rather than covering the product, so there is nothing for a dismissal to
   uncover. Once at least one harness credential is configured it is finished and does not
   return; adding or changing credentials after that is Settings' job. There is no
   "re-run harness onboarding".

   This is specifically about the harness half. It says nothing about whether the GitHub step
   can be skipped or deferred — that step keeps whatever behaviour it has today.

9. **Starter prompts appear only after harness setup.** The empty-session starter prompts
   (`docs/216-onboarding-starter-prompts`) share the conversation view with this flow, and they
   are sequential rather than simultaneous: the setup panel until a credential exists, the
   prompts once one does. They never occupy the panel at the same time.

## Out of scope

- **Removing the GitHub / git identity step.** Whether that step should exist at all is a fair
  question and explicitly not this change. It stays in the flow.

## Open questions

Raised by a cross-backend review of this document (2026-08-09). Every one was checked against
the code before being recorded here.

- **When is harness onboarding finished — a credential, or a runnable model?** Req 8 says "once
  at least one harness credential is configured", and docs/252 makes those different things: a
  credential belongs to a `(service, billing mode)`, while whether any model is *selectable*
  also depends on which harnesses are installed (docs/252 reqs 8 and 14). So onboarding could
  finish having stored a credential for a service no installed harness can run, leaving the
  composer correctly disabled on a flow that says it is done. The same distinction is already
  live in today's code, which gates on `installed && authConfigured` rather than on a
  credential alone.

- **Does the panel replace the conversation in *every* session, or only an empty one?** Reqs 1–3
  pull in different directions: onboarding "takes over the conversation view", yet sessions and
  navigation "work normally" and the composer is the *single* thing unavailable. Nothing says
  what a user sees when they open a second session, or one that already has a transcript.
  Today's eligibility is global, not per-session. And wherever the panel is *not* shown, the
  disabled composer has nothing next to it explaining why.

- **What happens if the last credential is removed after onboarding has completed?** Req 8 says
  onboarding never returns; req 9 says starter prompts appear only after harness setup. Remove
  the last credential and neither surface is selected — the empty conversation view has no
  defined content. (This is about deliberate removal in Settings. A credential *failing*
  mid-session is already settled by docs/252 req 12 and is not reopened here.)

- **Must credential errors surface inside the panel, or may they use toasts?** Req 5 bans
  modals. A toast is not a modal, so the ban does not settle it — but the surface req 7 points
  at reports several failures through global toasts today. Given that the whole point of the
  panel is that the ask is on screen while everything else works, an error that appears
  somewhere else and then disappears may be the wrong shape.

- **What scale must req 6 accommodate — exactly docs/252's launch set, or more?** "Room to grow"
  and "without becoming unreadable" are not testable as written. docs/252 names a concrete
  launch set of services, each with up to two billing modes, so binding req 6 to that set would
  make it checkable; promising open-ended growth would not.

- **Does req 9 order this flow against docs/216, or change docs/216's scope?** docs/216's own
  documents disagree about where starter prompts appear at all: its plan describes prompts on
  every empty session including sandbox ones, while its checklist records the scope as "regular
  repo sessions only (no sandbox)" and the implementation as reverted. Req 9 does not say which
  it assumes.

## Resolved questions

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
  setup panel until a credential exists, prompts once one does. Req 9 added.
