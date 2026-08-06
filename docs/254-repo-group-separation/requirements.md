---
issue: roadmap#SHI-326
title: Repo group separation in the session sidebar
description: Each repo group carries a persistent, user-changeable colored edge spanning the whole group.
---

# 254 — Repo group separation — requirements

What the feature must do, in the user's terms. Design lives in
[`plan.md`](plan.md); the treatment was chosen from the mockups in
[`docs/033-session-sidebar/mocks/`](../033-session-sidebar/mocks/).

## Requirements

1. Repo groups in the session sidebar must be visually distinguishable from one
   another. Today they blend together — with four or more repos the eye can't
   find where one project ends and the next begins.
2. Each repo group is marked by a colored vertical line on its **left edge**
   that spans the **entire group** — the repo header, the pinned sub-section,
   the `New session` row, every session row, and the `Recently resolved`
   sub-section. Everything belonging to a repo sits inside one continuous claim.
3. The line stays visible and unbroken while the sidebar is scrolled, including
   the region where the repo header is pinned to the top.
4. The repo header reads as a section header rather than as another row.
5. Each repo gets its own color **automatically**: no two repos are assigned the
   same color while unused colors remain. The user may deliberately choose a
   color another repo already holds (req 7) — but the picker must mark those
   colors and name the repo holding each one, so a duplicate is a deliberate
   choice rather than an accident.
6. A repo's color is stable: it does not change when other repos are added,
   removed, reordered, hidden, or unhidden.
7. The user can change a repo's color from that repo's settings.
8. The palette must be large enough that a user with many repos rarely sees a
   repeat.
9. Repo colors must not be mistakable for the sidebar's existing status colors
   (green = live agent, amber = current session, violet = PR, red = error).
10. Groups that are not repos — Host / Ops and Sandbox — are marked with their
    own established colors rather than a palette color, so the palette means
    "a repository" and nothing else.
11. When the sidebar renders only one **group**, the treatment is suppressed:
    there is nothing to separate it from. The count is of groups, not repos — a
    lone repo alongside a Host / Ops or Sandbox group is still two groups the eye
    has to separate, and suppressing there would leave exactly the blending req 1
    exists to fix.
12. The treatment works in every theme ShipIt ships, light and dark.

## Open questions

None.

## Resolved questions

- **2026-08-06 — How should a repo get its color: hash the URL, or assign one?**
  Assign at add time from the palette, skipping colors already in use, and
  persist it. Hashing is stable but collides, and two adjacent repos landing on
  the same color is worse than no color at all. *(Nik, accepting the proposed
  defaults on the "Ready to build 5b" action card. Fixes reqs 5 and 6.)*
- **2026-08-06 — Should the non-repo groups (Ops, Sandbox, Orphan, Hidden) get
  palette colors too?** No — Ops and Sandbox use their own semantic colors.
  *(Nik, same card. Fixes req 10.)*
- **2026-08-06 — Should the treatment apply when there is only one repo?** No.
  *(Nik, same card. Fixes req 11.)*
- **2026-08-06 — Is the color fixed once assigned?** No: it must be changeable
  from repo settings, and the palette must be "big enough". *(Nik, follow-up
  message on the same card. Adds reqs 7 and 8.)*
- **2026-08-06 — May the user deliberately pick a color another repo already
  holds?** Yes — leave it allowed rather than blocking the pick. The safeguard
  is that the picker marks taken colors and names the repo holding each, so a
  duplicate is a deliberate choice, not an accident. Raised by the Codex review,
  which correctly read the old req 5 ("two repos must not share a color") as
  violated by any manual pick. Req 5 is now scoped to *automatic* assignment and
  carries the marking safeguard; no code changed. *(Nik, reviewing this document.
  Rewrites req 5.)*
- **2026-08-06 — Is the treatment suppressed on one *repo*, or on one *group*?**
  One **group**. A lone repo alongside a Host / Ops or Sandbox group is still two
  groups the eye must separate. This **refines** the earlier "should the
  treatment apply when there is only one repo?" receipt above: the intent there
  was "don't decorate a sidebar with nothing to separate", and the group count is
  the accurate measure of that. Also raised by the Codex review, which read the
  code and the old req 11 as disagreeing — they did; the code was right and the
  wording was wrong. No code changed. *(Nik, reviewing this document. Rewrites
  req 11.)*

## Chosen treatment

Option **5b** from
[`mocks/repo-separation-spine.html`](../033-session-sidebar/mocks/repo-separation-spine.html)
("Edge spans the whole group"), which was itself an extension of option 4e in
[`mocks/repo-separation-band.html`](../033-session-sidebar/mocks/repo-separation-band.html).
Selected by Nik on 2026-08-06 after reviewing four rounds of mockups.
