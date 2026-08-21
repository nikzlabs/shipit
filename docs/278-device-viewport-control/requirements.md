---
issue: planning#229
title: Device viewport control for the preview panel
description: Constrain the preview iframe to device presets or a freeform size, with orientation, centered in the panel with a size indicator.
---

# Requirements — device viewport control

Human-owned. Numbered statements are what the feature must do, in observable
terms. Design lives in `plan.md`.

## Requirements

1. The Preview tab must offer a viewport control that constrains the rendered
   surface of the previewed app, so the app's CSS breakpoints flip without the
   user agent changing.
2. The control must offer a "fill" mode in which the preview fills the panel as
   it does today.
3. The control must offer preset device dimensions for common phones and
   tablets, grouped by category.
4. The control must offer a freeform width and height.
5. The control must offer an orientation toggle (portrait ↔ landscape) for any
   constrained size, swapping the width and height of the rendered surface.
6. A constrained surface must be centered in the panel and accompanied by a
   size indicator showing the active viewport dimensions.
7. The feature must be pure client-side iframe sizing; no proxy or server
   changes.

## Open questions

None — this benchmark session resolves every open decision itself (see below).

## Resolved questions

- 2026-08-21 — **Which presets?** (benchmark assumption) Six: iPhone SE
  (375×667, deliberate small-device reference), iPhone 16 (393×852), iPhone 16
  Pro Max (440×956), Pixel 9 (412×916), iPad Mini (744×1133), iPad Air
  (820×1180). Phones and tablets cover the responsive-checking use case the
  issue names; a desktop/laptop preset is skipped because fill mode is already
  the desktop viewport (see plan.md "Deliberately not built").

- 2026-08-21 — **Where does the control live?** (benchmark assumption) In the
  Preview tab's toolbar, immediately right of the port/status group, because
  the toolbar is the one surface that is on screen exactly when a preview runs
  and a constrained surface can matter.

- 2026-08-21 — **How do preset and freeform relate?** (benchmark assumption)
  Freeform is a third mode beside the named presets: a "Custom" section of the
  same menu with width/height inputs. The last applied custom size is
  remembered for the session and restored whenever Custom mode is re-entered —
  switching to a named preset (or to fill) must not destroy it, because a
  freeform size usually takes more effort to arrive at than a preset click.

- 2026-08-21 — **Orientation semantics** (benchmark assumption) The toggle
  applies to whatever constrained size is active, including a custom one, and
  outputs the swapped dimensions to both the frame and the size indicator. The
  toggle exists only while a constrained size is active; fill has no
  orientation. Portrait is the default for every preset and custom entry.

- 2026-08-21 — **How is the constrained surface framed?** (benchmark
  assumption) The iframe itself carries the device dimensions and is centered
  in the panel over a neutral background, with rounded corners and a hairline
  border. When the device exceeds the panel it is scaled down — never up — to
  fit, leaving 16 px of padding, and the toolbar reads out the scale factor as
  a percentage alongside the dimensions.

- 2026-08-21 — **Is the choice remembered, and at what scope?** (benchmark
  assumption) Per session, in memory: each session's viewport choice (preset or
  custom, plus orientation) is snapshotted with the session's other preview
  state and restored when the user returns to that session. It is neither
  global nor persisted across a page reload — the viewport is inspection state
  about the app being looked at, like the selected port, not a preference
  about the user.

- 2026-08-21 — **What sizing constraints apply to freeform input?** (benchmark
  assumption) 100 px minimum and 2560 px maximum per dimension, enforced by the
  inputs with an inline validity message; out-of-range or empty values disable
  Apply.