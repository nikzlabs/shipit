---
issue: planning#336
title: Repository context on the mobile new-session screen
description: On mobile, the new-session screen does not say which repository the session will be created in.
---

# 259 — Repository context on the mobile new-session screen

Human-owned. Numbered statements are what the feature must do, in plain
language. Mechanisms belong in [`plan.md`](plan.md).

## Requirements

1. On a mobile viewport, the new-session screen (`/{owner}/{repo}/new`) must
   show which repository the session will be created in.
2. The repository must be identifiable without opening the sessions drawer and
   without reading the browser URL.
3. The same surface must let the user change the repository the session will be
   created in.
4. Each repository must keep its own new-session draft. Switching the repository
   swaps the composer text to that repository's draft, and switching back
   restores the text that was there before.
5. Quick sessions are out of scope: the quick-capture overlay already carries an
   explicit *"New quick session in ⟨repo⟩"* picker, and that surface stays
   literally unchanged.
6. Sessions that are already running are out of scope. Only the new-session
   screen changes.

## Open questions

_None._

## Resolved questions

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
- **2026-08-09 — Does this extend past the new-session screen?** No — Nik chose
  "New-session screen only". Added as requirement 6.
