---
issue: planning#345
title: Sidebar "Needs you" view
description: A sidebar view switch that lists only the sessions needing attention, without the repo breakdown.
---

# Requirements — sidebar "Needs you" view

Human-owned. Numbered statements are what the feature must do, in observable
terms. Design lives in `plan.md` (not written yet); the visual reference is
**[mockup.html](./mockup.html)**.

## Requirements

1. The session sidebar has a way to switch between its current view and a second
   view.
2. The second view lists only the sessions that need the user's attention.
3. The second view does not group sessions by repository, and shows no
   repository headers.
4. The switch is an icon control in the sidebar's existing header row, carrying a
   count of the sessions that need attention.
5. The count is visible in both views, so the second view is discoverable from
   the first.
6. The second view is a single flat list — no sections, no sub-groups.
7. The order of that list is stable: a row's position does not change while the
   row is in the list.
8. A session that stops needing attention while the view is open keeps its row,
   in place, marked as no longer needing attention. It does not move, and it does
   not disappear until the view is entered again.
9. "Needs attention" means the same thing in this view as everywhere else in the
   product — there is one definition, shared with the row marker, the row tooltip
   and notifications.

## Open questions

- **Q4 · Is the chosen view remembered?** Sticky across reloads and session
  switches, or does the sidebar always open in the All view?
- **Q7 · Is there a keyboard shortcut for the switch?**
- **Q8 · Does mobile get the same switch?** The mobile sessions panel is one mode
  of the bottom tab bar and has no desktop header row.

## Resolved questions

- **2026-08-10 · Q1 — where the switch lives.** Nik: *"Icon toggle + badge."* →
  requirements 4 and 5. The segmented control (mockup A1), the pinned band with
  no mode (A3) and the view dropdown (A4) are out.
- **2026-08-10 · Q5 — is the badge visible in the All view?** Yes, carried by the
  Q1 answer: the badge is the discovery mechanism for the second view. →
  requirement 5.
- **2026-08-10 · Q2 — what replaces the repo grouping.** Nik: *"flat, sort order
  is stable."* → requirements 6 and 7. Bands by reason (mockup B2) and
  reason-first two-line rows (B3) are out; so is sorting by urgency, because an
  urgency sort re-orders the list whenever a reason changes.
- **2026-08-10 · Q3 — a row that stops needing attention.** Nik: *"settle in
  place, shouldn't move to the separate section."* → requirement 8. Both the
  immediate removal (mockup C3) and the "Settled just now" section that the first
  C2 drawing used are out: the row stays exactly where it is.
- **2026-08-10 · Q6 — is the existing attention rule too broad for this view?**
  Nik: *"Keep it, one definition."* → requirement 9. An agent idle on an open PR
  still counts, and no view-specific rule is introduced.
