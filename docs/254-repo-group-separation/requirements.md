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
5. Each repo has its own color. Two repos must not share a color while unused
   colors remain.
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
11. When only one repo is visible in the sidebar, the treatment is suppressed:
    there is nothing to separate it from.
12. The treatment works in every theme ShipIt ships, light and dark.

## Open questions

Both raised by an independent Codex review of the implementation (2026-08-06),
which flagged these two requirements as not met by the code as written. Neither
is a bug — in each case the code does something defensible that the requirement's
wording doesn't cover. They need a human decision, not an agent's.

- **Req 5 — may the user deliberately pick a colour another repo already uses?**
  Automatic assignment never collides. But req 7 lets the user choose, and
  nothing stops them choosing a taken colour, so req 5 as written ("two repos
  must not share a colour while unused colours remain") is violated by a manual
  pick. Options: (a) leave it — the picker now marks taken colours with a dot
  and names the holder, so a duplicate is deliberate rather than accidental
  *(recommended, and what currently ships)*; (b) block the pick outright;
  (c) reword req 5 to scope it to automatic assignment. Nothing was reworded
  pending this answer.

- **Req 11 — is the treatment suppressed on one *repo*, or on one *group*?**
  The requirement says "when only one repo is visible". The code suppresses when
  only one **group** renders, so a lone repo alongside a Host/Ops or Sandbox
  group still gets the treatment. The reasoning: one repo beside an Ops group is
  still two things the eye must separate, and suppressing there would leave
  exactly the blending this feature exists to fix. If that reasoning is accepted,
  req 11 should be reworded to say "group"; if not, the code should change. The
  code currently implements the group reading, and a test pins it.

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

## Chosen treatment

Option **5b** from
[`mocks/repo-separation-spine.html`](../033-session-sidebar/mocks/repo-separation-spine.html)
("Edge spans the whole group"), which was itself an extension of option 4e in
[`mocks/repo-separation-band.html`](../033-session-sidebar/mocks/repo-separation-band.html).
Selected by Nik on 2026-08-06 after reviewing four rounds of mockups.
