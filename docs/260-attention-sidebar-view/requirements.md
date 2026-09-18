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
   count of the sessions that need attention. It sits next to the control that
   collapses the sidebar, not among the controls that create sessions.
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
10. The icon is the only chrome the second view adds. Nothing else appears above
    the list — no band, no label, no separate exit control.
11. A session's row looks the same in the second view as it does in the first.
    In particular, why a session needs attention is shown exactly the way the
    current build shows it, and is not restated as text on the row.
12. Each row in the second view shows the name of its repository.
13. The sidebar remembers which view was chosen, and opens in it again.
14. A keyboard shortcut changes the view. It appears alongside the product's
    other shortcuts and can be changed the same way they can.
15. The mobile session list has the same switch, on the left of its own top bar.
16. The switch and its count are legible in every theme, light and dark.
17. While the second view is showing, the sidebar's collapse control leaves that
    view instead of collapsing the sidebar. A second press then collapses it. The
    control says what it will do: in the second view its tooltip and its
    accessible name name the view it goes to, in wording of its own that no other
    control on the row shares.

## Open questions

_(none — see the receipts below)_

## Resolved questions

- **2026-09-01 · The collapse button is pressed by mistake in the second view.**
  Nik, from use: *"I often click on the collapse sidebar button, meaning to
  switch the mode to the regular mode of showing all the sessions. I always do
  that."* His proposal — the first press in the second view switches the view,
  and only the next press collapses — is requirement 17. His reasoning: nobody
  wants to collapse the sidebar from this view, because collapsing does not help
  there. The code agrees for a sharper reason: the collapsed rail carries no
  attention count at all (a deliberate choice recorded below), so collapsing from
  the second view hides the exact information that view exists to show, and
  leaves the view active but invisible.
  Hiding the collapse button in that view was considered and rejected by Nik as
  more confusing; it would also shift the header and make collapsing
  unreachable. Swapping the two buttons was rejected too — it moves the same
  mistake into the first view, where a corner press would switch view instead of
  collapsing. The tooltip and accessible-name clause is the agent's addition, to
  keep the state visible rather than hidden: without it a screen reader still
  hears "Collapse sidebar" and gets a view change. The glyph stays
  `SidebarSimpleIcon`, which marks the sidebar rather than the collapse
  direction, so it remains true of both presses.
- **2026-09-01 · Must the two controls share a name?** No. The first draft of
  requirement 17 gave the collapse control the switch's own words, "Show all
  sessions", on the grounds that identical actions should read identically. The
  review rejected that: at a count of zero the switch reads exactly those words
  too, so two adjacent buttons carried one name — ambiguous to a voice command
  ("click Show all sessions") and noise in screen-reader navigation. The clause
  now asks only for distinct wording that names the destination; the build says
  **"Back to all sessions"**. This was the agent's clause to begin with, not
  Nik's, so it is corrected here rather than re-asked.
- **2026-08-10 · Does the amber hold up on light themes?** Not as drawn. Nik:
  *"I would like to see how this new colored switcher icon would look in the
  light theme to make sure that the contrast is okay."* → requirement 16. The
  measured board in the mockup shows the 10 px count in `--color-attention`
  reaching only 2.35–3.19:1 on light surfaces, under the 4.5:1 AA wants for
  small text; the fix is a deeper amber for the count, picked per theme, with
  the glyph and the edge marker left alone. Dark themes are unaffected (6.8–9.4:1).
- **2026-08-10 · Q4 — is the chosen view remembered?** Yes. Nik: *"yes."* →
  requirement 13.
- **2026-08-10 · Q7 — is there a keyboard shortcut?** Yes. Nik: *"Why not, let's
  add it."* → requirement 14. The requirement is that a shortcut exists and
  behaves like the others; the chord itself is a design choice for `plan.md`,
  which should register it in `src/client/keybindings/registry.ts` (docs/180) so
  it appears in the `?` overlay and the Keyboard settings tab and is rebindable,
  rather than hard-coding a keydown handler.
- **2026-08-10 · Q8 — does mobile get the switch?** Yes. Nik: *"There is still
  the same bar in the session list on mobile. There is no 'close sessions'
  button, but the new switcher could be just on the left."* → requirement 15.
  The mobile bar's left slot is empty today (it has no collapse control), so the
  switch lands in the same place as on desktop.
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
- **2026-08-10 · Where in the header row?** Next to the collapse control. Nik:
  *"what do you think about putting it next to the hiding sidebar button?
  Because otherwise it is in the row with a lot of other buttons on desktop,
  which is confusing"* — with a screenshot of the real bar. → requirement 4. The
  right-hand cluster is four create/act controls; the switch and the collapse
  button are both controls for the sidebar itself.
- **2026-08-10 · Does the row show the attention reason as text?** No. Nik, on
  the invented "Waiting for your input" / "PR has merge conflicts" labels:
  *"let's not change it. So it is already shown in some way in the current
  build, and we should show it in exactly the same way."* → requirement 11. The
  row keeps `SessionStatusDot`, the docs/187 marker and the tooltip, unchanged.
  The colored reason text and the repo color chip drawn in the earlier version
  are both dropped.
- **2026-08-10 · Does the row show the repository?** Yes. Nik: *"showing the
  repository name, I think it is good."* → requirement 12. Uses the `repoLabel`
  prop `SessionItem` already takes, exactly as `AllSessionsDialog` passes it for
  its cross-repo list — plain tertiary text, not a new chip.
- **2026-08-10 · Is there a band above the list?** No. Nik, on the first
  drawing's amber "Needs you · 4 — Show all" strip: *"why do we need a separate
  bar? I thought I chose the option with an icon only."* → requirement 10. The
  band cost ~28 px, which is the height that ruled out the segmented control, and
  it repeated what was already on screen: the count is on the badge, the exit is
  a second click on the icon, and every row states its own reason. The lit icon
  is now the whole mode indicator.
- **2026-08-10 · Q6 — is the existing attention rule too broad for this view?**
  Nik: *"Keep it, one definition."* → requirement 9. An agent idle on an open PR
  still counts, and no view-specific rule is introduced.
