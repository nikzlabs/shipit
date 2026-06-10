---
description: Restyle how a session that "needs attention" is marked in the sidebar — explored as borders, backgrounds, and title treatments.
---

# Needs-attention session styling

Exploration of how a session that **needs attention** is marked in the session
sidebar. Today the row gets a 2px amber border on **both** the left and right
edges (`border-x-2 border-x-(--color-attention)`); the goal is a cleaner, less
"caged" signal that still reads at a glance and coexists with the selected-row
treatment.

## Constraints

- **Background fill is reserved for the *selected* session** (`--color-bg-secondary`,
  light `#f9fafb`). Any attention treatment must not fight that — either avoid the
  row background, or define an explicit rule for the **selected + needs-attention**
  overlap.
- **14 themes.** `--color-attention` is already defined per theme: `#d97706`
  (amber-600) in the 6 light themes, `#f59e0b` (amber-500) in the 8 dark themes.
  Any treatment must work across all of them.
- **Multiple sessions can need attention at once**, including adjacent rows — the
  treatment has to hold up stacked, not just for a single flagged row.

## Options explored

Four families, trading off visual weight against implementation cost. The combined
decision board is **[mockup.html](./mockup.html)** — every variant on one screen
(see the *Visual reference* note below).

### A · Row border — *no new tokens*
Accent on the row edge(s); reuses `--color-attention` as-is in every theme.
- **A0 Both edges** (current)
- **A1 Left rail** — single 3px left bar (the familiar "unread / needs you" marker)
- **A2 Grouped rail** — like A1, but adjacent flagged rows fuse into one continuous
  bar via `:has(+ .row.attn)`, so a run reads as a single zone
- **A3 Outline ring** — full 1.5px border around the pill
- **A4 Soft glow** — amber box-shadow halo, no hard edge
- **A5 Rail + edge dot** — left rail plus a trailing dot
- **A6 Pulsing rail** — animated glow on the left rail

### B · Row background — *needs a collision rule*
Tints the whole row amber (strongest), which collides with the selected fill. Each
variant resolves **selected + attention** differently:
- **B1 Fill + selection ring** — amber fill wins; selection shown by an inset ring
- **B2 Selected wins → rail** — gray fill takes over, attention demotes to a rail
  (keeps "background = selected")
- **B3 Deepened both-state** — the overlap gets its own deeper amber
- **B4 Tint + rail** — faint tint + rail; selection replaces the tint, rail stays

### C · Title fill — *needs a 2-token pair per theme*
Solid color behind the title text, title flipped to a contrasting color. Boldest.
- **C1 Deep amber pill** (amber-800 + white), **C2 Token amber pill** (amber-600 +
  white — low contrast), **C3 Full-width bar**, **C4 Rounded chip**
- **Cross-theme requirement** (see **[mocks/title-across-themes.html](./mocks/title-across-themes.html)**):
  the fill *and* text color must flip per theme — light surfaces want a **dark fill +
  white text**, dark surfaces want a **bright fill + dark text** (a dark pill
  disappears on the near-black `#030712` dark surface). So this needs two new tokens
  added to all 14 theme files:
  - `--color-attention-fill` — color behind the title
  - `--color-attention-on-fill` — title text color
  - Light camp: `#92400e` + `#ffffff`. Dark camp: `#f59e0b` + `#111827`.
    `high-contrast` can push to pure black/white; `solarized` can use its own amber.

### D · Title outline — *no new tokens*
Border in the attention color around the title only; text and background untouched.
Quietest and cheapest of the title treatments — because nothing is filled,
white-text legibility never comes up, so it reuses `--color-attention` directly.
- **D1 Outline pill** (1.5px, radius 5), **D2 Outline chip** (rounded), **D3 Dashed**

## Recommendation

Shortlist: **A1 (left rail)**, **A2 (grouped rail)**, or **D1 (outline pill)** — all
three are theme-proof with no new tokens and don't touch the selected-row fill. Pick
A/D for a clean low-cost change; reach for C (title fill) only if a bolder signal is
worth the per-theme token work.

## Decision — implemented: attention rail (solid left bar)

We iterated through several row-level backgrounds (a left-edge wash, a center wash,
and a short right-edge glow) — all **rejected** because a soft gradient reads as
ambient texture, not a marker: it's ambiguous (could be hover/selection/loading),
hard to notice in peripheral vision, and turns into noise when many rows are flagged
at once (the realistic "came back from a break" case).

The implemented choice is the **attention rail**: a solid amber bar down the row's
left edge.

```tsx
// SessionItem — applied as an inline boxShadow on the row div
const attentionRail = needsAttention
  ? "inset 3px 0 0 var(--color-attention)"
  : undefined;
// ...
<div ... style={attentionRail ? { boxShadow: attentionRail } : undefined}>
```

Why this is the right signal (verified at scale — see
[mocks/rail-at-scale.html](./mocks/rail-at-scale.html)):
- **Peripherally glanceable.** Peripheral vision responds to luminance contrast and
  hard edges, not small text or soft tints. A solid, saturated bar with a crisp edge
  is exactly that; the soft washes failed this test by design.
- **Scales to many-at-once.** When several rows are flagged the bars line up into a
  **scannable column** down the left edge — you catch the set (and the gaps) in one
  glance instead of reading row by row.
- **Zero layout shift.** Rendered as an `inset` box-shadow, so the bar paints inside
  the row's box; nothing moves (a real `border-left` would shift the content right).
- **No new tokens.** Uses the saturated per-theme `--color-attention` directly
  (amber-600 light / amber-500 dark) — it reads strongly on both light and dark
  surfaces, so the interim `--color-attention-wash` token was removed.
- **Coexists with selection.** The shadow paints over the row background, so a
  selected + needs-attention row keeps its gray fill with the bar on top — no
  special-casing of `isCurrent`.

Easy knobs if we want to tune: bar thickness (`3px`), or the row-tint and
rounded-pill variants (B / C in the at-scale mock).

## Key files

- `src/client/components/SessionSidebar.tsx` — `SessionItem` (the row). The
  attention class is at the row `className`; currently
  `needsAttention ? "border-x-2 border-x-(--color-attention)" : "border-x-2 border-x-transparent"`.
  All options above are a swap here (row variants) or wrapping the title `<p>` in a
  span and toggling a class (title variants), keyed on `needsAttention` + `isCurrent`.
- `src/client/hooks/useAttentionInfo.ts` — derives `needsAttention` and the reason string.
- `src/client/themes/*.css` — `--color-attention` per theme (amber-600 light /
  amber-500 dark); the implemented rail uses this token directly, no theme edits.

## Visual reference

- **[mockup.html](./mockup.html)** — all 18 variants on one screen, grouped by family,
  each in the same 4-row list (normal · two adjacent attention · selected+attention).
  The primary decision board.
- **[mocks/row-borders.html](./mocks/row-borders.html)** — family A with multiple
  flagged rows, including the grouped-rail behavior.
- **[mocks/row-backgrounds.html](./mocks/row-backgrounds.html)** — family B, four
  states per variant showing the collision rule.
- **[mocks/title-fill.html](./mocks/title-fill.html)** — family C with shade/contrast options.
- **[mocks/title-across-themes.html](./mocks/title-across-themes.html)** — light vs dark
  for the title-fill, explaining the per-theme token pair.
- **[mocks/title-outline.html](./mocks/title-outline.html)** — family D, light + dark, shape options.
- **[mocks/creative-directions.html](./mocks/creative-directions.html)** — content/motion/texture
  ideas (reason chip, notification dot, bell, gradient wash, shimmer, dog-ear, wavy
  underline, marching ants) drawn on a faithful replica of the real session row
  (PR badge, CI status, auto-merge, ⋮).
- **[mocks/rail-at-scale.html](./mocks/rail-at-scale.html)** — the deciding board:
  bold left-edge markers (solid rail / rail+tint / rounded pill) on a **full sidebar
  with ~half the rows flagged in clusters**, in warm-light + dark, to judge
  peripheral glance and the many-at-once case. **The solid rail (A) was implemented.**
