---
issue: planning#345
title: Sidebar "Needs you" view
description: A sidebar view switch that lists only the sessions needing attention, without the repo breakdown.
---

# Requirements — sidebar "Needs you" view

Human-owned. Numbered statements are what the feature must do, in observable
terms. Design lives in `plan.md` (not written yet — questions below are open);
the visual exploration is **[mockup.html](./mockup.html)**.

## Requirements

1. The session sidebar has a way to switch between its current view and a second
   view.
2. The second view lists only the sessions that need the user's attention.
3. The second view does not group sessions by repository, and shows no
   repository headers.

## Open questions

Everything below is a choice the agent had to make and did not have an answer
for. Each names the mockup variant that illustrates it.

- **Q1 · Where does the switch live?** `A1` a segmented control under the header
  (clearest, costs ~30 px of list height) · `A2` an icon toggle in the existing
  header row with a count badge (no height cost; recommended) · `A3` no mode at
  all — a pinned "Needs you" band above the tree, which duplicates rows · `A4` a
  view dropdown that later extends to Recent / Archived.
- **Q2 · What replaces the repo grouping as structure?** `B1` one flat list
  sorted by urgency · `B2` bands by reason — *Blocked on you* / *Broken* /
  *Waiting on you* (recommended) · `B3` two-line rows with the reason promoted to
  the title line and the session title demoted to metadata.
- **Q3 · What happens when a row stops needing attention while the view is
  open?** `C2` it settles in place, marked done, and leaves on the next entry
  into the view (recommended) · `C3` it disappears immediately.
- **Q4 · Is the chosen view remembered?** Sticky across reloads and session
  switches, or does the sidebar always open in the current (All) view?
- **Q5 · Does the count badge show in the All view too?** It is the only thing
  that makes the second view discoverable, but it is also a permanent amber mark
  in the header.
- **Q6 · Does "needs attention" keep its current definition?**
  `computeAttentionReason()` today counts a session as needing attention when the
  agent is merely **idle on an open PR** ("Waiting for your input"). In a list
  whose whole purpose is triage, that could be most of the list. Keep as-is, or
  does this view want a narrower rule?
- **Q7 · Is there a keyboard shortcut for the switch?**
- **Q8 · Does mobile get the same switch?** The mobile sessions panel is one mode
  of the bottom tab bar and has no desktop header row.

## Resolved questions

_(none yet)_
