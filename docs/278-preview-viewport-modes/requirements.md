# Preview viewport modes

Tracks `planning#229` (migrated from Linear SHI-227, sub-issue of the T3 Code
competitive analysis). Written against an implementation that already exists —
docs/066-mobile-preview shipped it before this issue was migrated — so this
document states what the feature must do, and this session's work is the audit
that verifies each requirement against the running product and closes the gaps
found (see plan.md §Delta).

1. The Preview tab has a viewport control that constrains the previewed app's rendered surface without changing its user agent.
2. The control has a fill mode ("Responsive") in which the preview fills the panel exactly as it did before the control existed.
3. The control offers device presets (e.g. iPhone) that fix the surface to named width/height dimensions, with a way to swap orientation.
4. The control offers freeform sizing: any width and height within a bounded range.
5. When a preset or freeform size is active, the constrained surface is centered inside the panel, visually distinct from its surroundings, and a size indicator reports the exact dimensions (and the scale, when scaled to fit).
6. A constrained surface larger than the panel is scaled down to fit; it never overflows or clips at the panel edge.
7. Sizing is pure client-side iframe styling. No proxy, server, or injected-script change participates in it.
8. The viewport choice is remembered per session: two sessions can sit at different sizes, and switching between them restores each one's choice.

## Open questions

None.

## Resolved questions

All decisions below were made by the implementing agent as benchmark
assumptions (the brief forbids asking the user); each names the reasoning that
settled it.

- 2026-08-21 — *Which presets?* Kept docs/066's set: four phones (iPhone SE,
  iPhone 16, iPhone 16 Pro Max, Pixel 9) and two tablets (iPad Mini, iPad Air).
  No laptop/desktop sizes: the preview pane is a split pane typically 600–1000px
  wide, so a 1280px+ surface renders at ≤50% scale where breakpoint checking is
  guesswork anyway, and freeform entry covers anyone who genuinely needs one.
  Six presets keep the dropdown scannable; every added row must beat the
  freeform input to earn its place.
- 2026-08-21 — *Where does the control live?* In the preview toolbar's left
  group, after the port label — the same bar that already carries refresh,
  errors, and open-in-new-tab. A second row or floating overlay would cost
  vertical space from the very surface being sized, permanently, for a control
  used in bursts.
- 2026-08-21 — *How do preset and freeform relate?* A freeform size becomes
  its own active state (`category: "custom"`) shown in the trigger as
  `W×H`; picking a named preset or Responsive replaces/clears it. One active
  size at a time — no multi-slot memory to misplace.
- 2026-08-21 — *Orientation.* A single rotate button beside the selector,
  visible only while a fixed size is active, swapping width/height for named
  presets and custom sizes alike.
- 2026-08-21 — *Framing.* The constrained iframe sits centered on a tertiary
  background with a rounded border and shadow; scale-to-fit via
  `transform: scale()` recomputed by a ResizeObserver on panel resize.
- 2026-08-21 — *Remembered at what scope?* Per session, in the existing
  per-session preview snapshot (in-memory, restored on switch) — matching how
  selected port and errors are already remembered. Not global localStorage:
  "phone-sized" is a property of the app under preview, not of the user, and a
  stale phone frame on a brand-new session is a confusion risk. Page reloads
  reset to Responsive; accepted, same trade as the other snapshot fields.
