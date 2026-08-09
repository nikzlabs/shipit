---
issue: planning#335
title: Non-blocking onboarding
description: Onboarding stops being a blocking modal and becomes a wizard in the conversation view, so a new user can see and use ShipIt before connecting anything.
---

# Non-blocking onboarding — requirements

These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here.

This feature exists because [`docs/252-custom-models`](../252-custom-models/requirements.md)
makes the current onboarding untenable — its credential step is hard-coded to two providers and
services become plural — but the problems below are ones the flow has today, independent of
that. docs/252 phase 2 carries an interim that keeps the existing wizard working under the new
credential keying; this feature replaces the flow.

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

5. **A step may open a modal when it needs one, but never more than one at a time.** Today two
   modals can be visible simultaneously, which is confusing and busy. Anything that opens on
   top of the flow is a single, deliberate thing.

6. **The flow has room to grow.** Once a user is choosing among several services rather than
   two providers (docs/252), the credential step carries materially more than it does now. The
   layout must accommodate that without becoming unreadable — the current problem is a lot of
   functionality inside a small dialog, in fact inside one part of a dialog.

7. **Setup happens in a panel in the middle of the conversation view, and it is the same
   credential surface Settings uses.** Connecting a harness during onboarding and connecting
   one later from Settings are the same act, so they are not two implementations of it. A
   second copy would drift, and the two would disagree about what a connected credential looks
   like.

8. **Onboarding is not dismissible, because it does not need to be.** It occupies the
   conversation view rather than covering the product, so there is nothing for a dismissal to
   uncover. Once at least one harness credential is configured it is finished and does not
   return; adding or changing credentials after that is Settings' job. There is no
   "re-run onboarding".

9. **Starter prompts appear only after harness setup.** The empty-session starter prompts
   (`docs/216-onboarding-starter-prompts`) share the conversation view with this flow, and they
   are sequential rather than simultaneous: the setup panel until a credential exists, the
   prompts once one does. They never occupy the panel at the same time.

## Out of scope

- **Removing the GitHub / git identity step.** Whether that step should exist at all is a fair
  question and explicitly not this change. It stays in the flow.

## Open questions

_None._

## Resolved questions

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
