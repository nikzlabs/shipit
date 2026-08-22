---
title: Remember the preview viewport choice
description: The Preview tab's device-viewport choice survives a full page reload instead of resetting to fill-panel.
---

# Remember the preview viewport choice

Context: planning#229 asks for a viewport control (device presets, freeform
size, orientation, size indicator) in the Preview tab. That control already
ships — docs/066-mobile-preview, live on main since April 2026. Auditing the
issue against main left exactly one gap: every page reload resets the viewport
to Responsive. The choice is remembered across session *switches* (in-memory
per-session snapshots) but not across a reload of ShipIt itself, so anyone
working a responsive-layout task re-picks iPhone after every refresh.

1. Picking any viewport state in the Preview tab — a named preset, a custom
   size, landscape/portrait orientation, or back to Responsive — still holds
   after a full page reload of ShipIt.
2. The remembered choice is the last one picked anywhere (one global value),
   and per-session snapshot behaviour on session switch is unchanged.
3. A stored value that is malformed, names an unknown preset, or is out of
   range is ignored: the tab opens Responsive and nothing throws.

## Open questions

(none)

## Resolved questions

- 2026-08-22 — **Scope of the memory: global last-used vs per-session across
  reloads?** Resolved as global last-used (benchmark assumption; no human
  available to ask). Reasoning: the control behaves like DevTools' device
  mode — a tool setting that stays until turned off. Per-session-across-
  reloads needs keyed storage that grows with the session list for little
  gain, and requirement 2 keeps today's per-session behaviour inside a visit.
  Requirement 3 bounds the damage of a stale value: one click returns to
  Responsive, and the toolbar always shows what is active.
- 2026-08-22 — **Does a full reset clear it?** No (benchmark assumption).
  It matches the two preferences the preview store already keeps at this
  scope — the services-drawer state and remembered preview paths survive
  `reset()` — and the theme does the same one tier up. Reset clears session
  work, not tool preferences.
