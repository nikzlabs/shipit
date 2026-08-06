---
issue: roadmap#SHI-326
title: Repo group separation in the session sidebar
description: Each repo group carries a persistent, user-changeable colored edge spanning the whole group.
---

# 254 — Repo group separation

Implements [`requirements.md`](requirements.md). Chosen from four rounds of
mockups in [`docs/033-session-sidebar/mocks/`](../033-session-sidebar/mocks/);
the shipped treatment is option **5b** in
[`repo-separation-spine.html`](../033-session-sidebar/mocks/repo-separation-spine.html).

## Problem

Every repo group in the sidebar rendered as a flat sibling on one uninterrupted
surface — repo header, `New session`, `PINNED`, `RECENTLY RESOLVED` and the
session rows all on `--color-bg-primary`, separated only by a font-weight bump
on the repo name (req 1). Worse, the strongest horizontal lines in the rail (the
pinned divider, the sub-section labels) are *intra*-group, so they out-ranked the
*inter*-group boundary they competed with.

## Design

Two cues, neither of which needs a background surface behind the group:

1. **A 3px identity edge** in the repo's own color, drawn as `border-left` on the
   **group element**, so it spans the header, the pinned sub-section, the
   `New session` row, every session row and `Recently resolved` (req 2).
2. **A `--color-bg-tertiary` header band**, so the header reads as a section
   header rather than another row (req 4).

Colors are stored as a **palette index**, never a hex. Each theme maps the index
to its own light/dark value, so one stored choice looks right on all fourteen
themes (req 12).

### Load-bearing constraints

These came out of mocking the treatment and are pinned by tests; a change that
violates one will look correct in a static screenshot and break in use.

- **The edge must be on the group, not the header.** The repo header is
  `sticky top-0`. An edge on the header visibly breaks at the seam the moment it
  pins; on the group it keeps painting behind the pinned band, so the line is
  continuous for the group's whole height (req 3). Guarded by *"puts the edge on
  the group element, not on the sticky header"* in `SessionSidebar.test.tsx`.
- **The band fill must be an opaque token.** Every `*-subtle` token is `rgba()`,
  and a translucent sticky header lets session rows scroll straight *through* it.
  `--color-bg-tertiary` is opaque in every theme. Same test asserts the class.
- **Palette entries must not read as status.** The rail already spends green on a
  live agent, amber on the current session, violet on a PR and red on errors, so
  every entry is pulled well down in saturation (req 9).
- **The dark values must stay scoped to the dark-theme classes**, never `:root` —
  the identical cascade trap documented for `--color-sandbox` directly above them
  in `index.css`. The theme class sits on `<html>`, i.e. the same element as
  `:root`, so a value in `:root` declared later in source order clobbers every
  light theme's override.

### Assignment

`pickRepoColorIndex` takes the **lowest-numbered free** color, not the next one
round-robin, so the early colors stay stable as repos come and go: removing repo
#2 and adding another gives the new repo #2's old slot rather than shifting
everyone along (req 5, req 6). Hidden repos are counted as holders, so unhiding
one can never collide with a color handed out while it was out of sight. Past 16
repos it wraps to the least-used index — the first repeat req 5 allows.

A re-add (which is also how *unhide* works, since `add()` clears `hidden`) never
reassigns; it only fills a hole left by an older build.

### Suppression

The treatment is keyed off the rendered **group** count, not the repo count. One
repo alongside an Ops or Sandbox group is still two groups the eye has to
separate, so `isSingleRepo` would have suppressed the treatment in exactly the
case it is needed (req 11).

### Non-repo groups

Ops and Sandbox get their own semantic colors — `--color-warning` and
`--color-sandbox` — rather than palette entries, so a palette color always means
"a repository" (req 10). Ops had no color at all before this: its docstring
described "the amber ops group" while the wrench rendered `text-secondary`.

## Key files

| File | Role |
|---|---|
| `src/server/shared/repo-colors.ts` | Palette size, names, validation, assignment. Shared by both layers. |
| `src/client/index.css` | `--repo-color-0` … `-15`, light values + dark overrides. |
| `src/server/shared/database.ts` | `color_index` column + backfill migration. |
| `src/server/orchestrator/repo-store.ts` | Assignment on add; `setColorIndex`. |
| `src/server/orchestrator/services/repos.ts` | `setRepoColorIndex` — validates before storing. |
| `src/server/orchestrator/api-routes-session-repos.ts` | `PATCH /api/repos/:url` now also carries `colorIndex`. |
| `src/client/stores/repo-store.ts` | `setRepoColorIndex` — optimistic, reverts on failure. |
| `src/client/components/SessionSidebar/SessionGroup.tsx` | `groupEdgeStyle`, the band, the three group components. |
| `src/client/components/RepoColorPicker.tsx` | The 16-swatch picker. |
| `src/client/components/ProjectSettings.tsx` | New **Appearance** tab hosting the picker. |

## Migration

Existing repos are backfilled rather than left NULL — the edge *is* the feature,
so a workspace upgrading into it with every repo uncolored would see nothing at
all. The backfill walks rows in the sidebar's own display order and hands out
distinct low indices, which is what `pickRepoColorIndex` would have produced had
those repos been added under this build, so an upgraded workspace and a fresh one
agree.

The palette size is **inlined as `16`** in the migration rather than imported. A
migration must keep reproducing the same result forever; following a constant
would let a later, larger palette retroactively recolor old repos.

## Changing a color

`Project Settings → Appearance` (req 7). The swatches paint with the same
`--repo-color-N` properties the rail uses, so the picker cannot show one color
while the sidebar draws another — a component test asserts that. Selection writes
through the store's optimistic action, so the edge behind the dialog changes on
click; there is no save step. The selected swatch carries a tick as well as a
ring, so it stays identifiable without relying on ring contrast against sixteen
different backgrounds.

## Verification

Checked in the dogfood inner ShipIt with four repos, in Claude Light and Claude
Dark (the flattest palettes we ship, per the band mock's contrast measurements):
distinct edges per repo, `--color-bg-tertiary` band resolving to `#e6dcd0` in
Claude Light, and a color change in the picker updating both the DOM edge and
`GET /api/repos` immediately.
