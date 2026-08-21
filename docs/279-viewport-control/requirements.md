---
issue: planning#229
title: Device-preset viewport resize for the preview panel
description: The Preview tab renders the previewed app at the panel's size. A viewport control constrains the rendered surface to device presets or a freeform size, so the user can flip CSS breakpoints without changing the user agent.
---

# Viewport control for the preview panel

Human-owned. Numbered statements are what the feature must do, in plain
language. Mechanisms belong in [`plan.md`](plan.md).

## Requirements

1. While a preview runs, the user can constrain the rendered surface to a
   named device size (phone and tablet presets) or to a freeform width and
   height they type, from inside the Preview tab.
2. One mode fills the whole panel (the default). Returning to it must always
   be one action away, and must restore the exact pre-constraint behavior.
3. While a fixed size is active, the constrained surface is visually distinct
   from the panel — framed, centered, and labeled with its dimensions — so
   the user always knows what viewport they are looking at.
4. If the chosen size does not fit the panel, the surface scales down to fit
   rather than overflowing or clipping, and the label says so.
5. A preset's width and height can be swapped (portrait ↔ landscape) without
   re-picking the preset.
6. The choice survives switching to another session and back. Different
   sessions do not share it.
7. Constraining the surface changes only its rendered size. It must not
   change the user agent, the preview URL, the proxy, or reload the page.
8. Freeform sizes outside a sane range are rejected at the input, with the
   accepted range visible where the user types.

## Open questions

- (none)

## Resolved questions

- 2026-08-21 — **Benchmark assumption.** Which presets ship? Kept the six
  shipped presets (iPhone SE / 16 / 16 Pro Max, Pixel 9, iPad Mini / Air) —
  they were modernized in June 2026 and cover the small-device reference,
  the current flagship lineup, Android, and both tablet classes. A longer
  list adds menu noise without adding a breakpoint.
- 2026-08-21 — **Benchmark assumption.** Where does the control live, and
  how do preset and freeform relate? One dropdown in the preview toolbar
  (the surface the user is already reading), with freeform inputs as the
  menu's last group and "Responsive" as its first entry. A separate freeform
  mode would duplicate the preset row it shares dimensions with.
- 2026-08-21 — **Benchmark assumption.** At what scope is the choice
  remembered? Per session (in the preview store's per-session snapshot), not
  globally: viewport work is per-app, and a global choice would leak a
  phone-sized frame from one project into the next. Not persisted across page
  reloads — the preview store's snapshots are in-memory by design, matching
  every other preview choice (port, auto-fix) that lives in them.
- 2026-08-21 — **Benchmark assumption.** Does landscape apply to freeform
  sizes? No — a freeform size already names its exact width and height, so
  rotating it would silently swap numbers the user typed. Landscape is a
  property of *named* presets, whose numbers are a device fact rather than
  the user's input.
- 2026-08-21 — **Audit finding, treated as the implementation gap.** The
  feature described by planning#229 shipped in April 2026
  (docs/066-mobile-preview, PR #360) and was modernized in June 2026. This
  folder's work is the audit against reqs 1–8, the state-machine fixes the
  audit found (see plan.md), and the live verification the original feature
  never recorded. Req 5's "without re-picking the preset" and req 8's input
  validation already hold; req 1–4, 6, 7 held except for the landscape
  leak fixed here.
