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

3. **A new user can see ShipIt before connecting a subscription.** Being able to look at the
   product is not conditional on finishing onboarding. The concern this addresses is drop-off:
   a first-time user who is asked to connect an account before they have seen anything has been
   given no reason to.

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

## Out of scope

- **Removing the GitHub / git identity step.** Whether that step should exist at all is a fair
  question and explicitly not this change. It stays in the flow.

## Open questions

- **What can the user actually do before connecting a credential, beyond looking?** Req 3 says
  ShipIt is visible; it does not say whether a session can be created, whether the composer
  accepts input, or what happens if the user tries to take a turn with nothing connected. The
  honest floor is that a turn cannot run — docs/252 req 8 makes a model selectable only when
  its billing mode has a credential — but "can't take a turn" and "can't create a session" are
  very different products, and the drop-off argument in req 3 pushes toward letting the user
  get as far as possible before being asked for anything.

- **Is onboarding dismissible, and does it come back?** Req 2 gives it the conversation view,
  which is also where the user would go to start working. So: can the user set it aside and
  return to it, is there a persistent way back once dismissed, and does it reappear on the next
  session or stay gone? A wizard that cannot be dismissed is a blocking modal wearing a
  different shape; one that cannot be recovered strands a user who dismissed it early.

- **What happens to the empty-session starter prompts?** `docs/216-onboarding-starter-prompts`
  already puts first-run guidance in the empty conversation view — the same surface req 2
  claims. These either compose (onboarding first, then the prompts) or compete. Not deciding
  means two features quietly fighting over one panel.

- **Is this one-time or does the surface persist for later setup?** A user who connects one
  service during onboarding may add a second one months later. That is Settings' job today. If
  onboarding is a conversation-view wizard, it is worth deciding whether it is strictly a
  first-run thing or a surface that returns when there is something new to set up.

## Resolved questions

_None yet._
