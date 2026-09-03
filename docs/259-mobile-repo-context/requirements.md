---
issue: planning#336
title: Repository context on the new-session screen
description: The new-session screen does not say which repository the session will be created in.
---

# 259 — Repository context on the new-session screen

Human-owned. Numbered statements are what the feature must do, in plain
language. Mechanisms belong in [`plan.md`](plan.md).

## Requirements

1. The new-session screen (`/{owner}/{repo}/new`) must show which repository the
   session will be created in, on every viewport — mobile and desktop.
2. The repository must be identifiable without opening the sessions drawer and
   without reading the browser URL.
3. The same surface must let the user change the repository the session will be
   created in.
4. A draft must not follow the user from one repository to another. The
   repository switcher must respect the draft behaviour the composer already
   has: switching shows that repository's own new-session draft, and switching
   back restores the text that was there before.
5. Quick sessions are out of scope: the quick-capture overlay already carries an
   explicit *"New quick session in ⟨repo⟩"* picker, and that surface stays
   literally unchanged.
6. Sessions that are already running are out of scope. Only the new-session
   screen changes.

## Open questions

_None._

## Resolved questions

- **2026-09-03 — Does the bar belong on desktop too?** Yes — Nik: *"the
  repository strip on new sessions: let's make it visible on desktop, too"*.
  Requirement 1 was rescoped from "on a mobile viewport" to every viewport. The
  original mobile-only scope was an agent judgement (the desktop sidebar already
  names the repo), not something the human asked for; the sidebar is across the
  window from the composer, and the bar is also the switcher req 3 asks for.
- **2026-08-09 — Which treatment?** Five options were prototyped in
  [`mocks/repo-context.html`](mocks/repo-context.html). Nik chose **B — a
  context bar in the PR-card slot** (recommended): the slot is empty on this
  route, and the PR lifecycle card takes it over once the session graduates.
  Requirements 1 and 2 stand unchanged; the choice constrains `plan.md`, not
  them.
- **2026-08-09 — Must the surface also change the repository?** Yes — *"Show and
  switch, but we need to make sure that the input text draft correctly changes
  between repositories. I may have a draft for a new session in another
  repository, then switch to it, so the text needs to correctly change to my
  draft."* Added as requirements 3 and 4.
- **2026-08-09 — Is the per-repository draft existing behaviour?** Nik: *"I
  believe this already works now, but the new switcher needs to respect it."*
  Requirement 4 was reworded from "each repository must keep its own draft" to
  respecting behaviour the composer already has, because that is the intent —
  not a new feature. Half of it is already true and half is not, verified at the
  source: per-**session** drafts do work, saved and restored on every key change
  in `client/components/MessageInput/hooks/useMessageDraft.ts`. But the
  new-session view pins every repository to the one constant key `"new"`
  (`client/App.tsx:1559`), so on this screen a draft does follow the user across
  repositories today. Req 4 is therefore mostly "don't break it" plus a one-line
  key change; see `plan.md`.
- **2026-08-09 — Does this extend past the new-session screen?** No — Nik chose
  "New-session screen only". Added as requirement 6.
