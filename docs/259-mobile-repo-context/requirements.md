---
issue: planning#336
title: Repository context on the mobile new-session screen
description: On mobile, the new-session screen does not say which repository the session will be created in.
---

# 259 — Repository context on the mobile new-session screen

Human-owned. Numbered statements are what the feature must do, in plain
language. Mechanisms belong in `plan.md`, which does not exist yet — an option
must be chosen first.

## Requirements

1. On a mobile viewport, the new-session screen (`/{owner}/{repo}/new`) must
   show which repository the session will be created in.
2. The repository must be identifiable without opening the sessions drawer or
   reading the browser URL.
3. Quick sessions are out of scope: the quick-capture overlay already carries an
   explicit *"New quick session in ⟨repo⟩"* picker, and that surface must stay
   literally unchanged.

## Open questions

- **Which treatment?** Five options are prototyped in
  [`mocks/repo-context.html`](mocks/repo-context.html) — (A) repo in the app
  header, (B) a context bar in the PR-card slot, (C) a repo chip in the
  composer, (D) an empty-state headline, (E) ambient repo colour plus a naming
  placeholder. Recommendation: **B**, with **D** as a free complement.
- **Must the shown repository also be changeable from that surface?** Options B,
  C and D can carry a switch affordance; A and E cannot. Showing and switching
  are separable, and the ask was only to show.
- **Does this extend past the new-session screen** — i.e. should a session that
  is already running also name its repository on mobile? The reported problem is
  the new-session menu specifically.

## Resolved questions

_None yet._
